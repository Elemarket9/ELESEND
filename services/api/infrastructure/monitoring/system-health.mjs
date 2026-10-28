/**
 * ELESEND Production System Health & Resource Monitor
 * 
 * Tracks process memory, host memory, disk headroom, database connection pool,
 * event loop delay, and Redis cache against configurable runtime resource budgets.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { statfsSync } from 'node:fs';
import { totalmem, freemem } from 'node:os';
import { getRedisClient } from '../cache/redis.mjs';

// Monitor event loop delay with 10ms resolution
const loopMonitor = monitorEventLoopDelay({ resolution: 10 });
loopMonitor.enable();

export function resolveResourceBudgets(env = process.env) {
  const hostTotalMemBytes = totalmem();
  const configuredRamMb = Number(env.RUNTIME_MEMORY_BUDGET_MB || 0);
  const ramBudgetBytes = Number.isFinite(configuredRamMb) && configuredRamMb > 0
    ? Math.round(configuredRamMb * 1024 * 1024)
    : hostTotalMemBytes;

  const configuredDiskGb = Number(env.RUNTIME_DISK_BUDGET_GB || 0);
  const diskBudgetBytes = Number.isFinite(configuredDiskGb) && configuredDiskGb > 0
    ? Math.round(configuredDiskGb * 1024 * 1024 * 1024)
    : null;

  const maxRssMb = Number(env.RUNTIME_MAX_RSS_MB || 1536);
  const minFreeDiskGb = Number(env.RUNTIME_MIN_FREE_DISK_GB || 10);

  return {
    ramBudgetBytes,
    diskBudgetBytes,
    maxRssBytes: Math.round((Number.isFinite(maxRssMb) && maxRssMb > 0 ? maxRssMb : 1536) * 1024 * 1024),
    minFreeDiskBytes: Math.round((Number.isFinite(minFreeDiskGb) && minFreeDiskGb > 0 ? minFreeDiskGb : 10) * 1024 * 1024 * 1024)
  };
}

export async function getSystemHealthReport(db, env = process.env) {
  const mem = process.memoryUsage();
  const hostTotalBytes = totalmem();
  const hostFreeBytes = freemem();
  const uptimeSeconds = Math.round(process.uptime());
  const budgets = resolveResourceBudgets(env);

  // Event loop delay in milliseconds
  const eventLoopLagMs = Number((loopMonitor.mean / 1e6).toFixed(2));
  const eventLoopP95Ms = Number((loopMonitor.percentile(95) / 1e6).toFixed(2));
  const eventLoopMaxMs = Number((loopMonitor.max / 1e6).toFixed(2));
  loopMonitor.reset();

  // Storage headroom
  let disk = { totalBytes: budgets.diskBudgetBytes, freeBytes: null, usedPercent: null };
  try {
    const stats = statfsSync(process.cwd());
    const total = budgets.diskBudgetBytes || (stats.blocks * stats.bsize);
    const free = stats.bfree * stats.bsize;
    disk = {
      totalBytes: total,
      freeBytes: free,
      freeGb: (free / (1024 * 1024 * 1024)).toFixed(2),
      usedPercent: total > 0 ? Number(((1 - free / total) * 100).toFixed(1)) : null
    };
  } catch {}

  // Database Pool status
  const dbPool = db?.pool ? {
    totalCount: db.pool.totalCount,
    idleCount: db.pool.idleCount,
    waitingCount: db.pool.waitingCount
  } : null;

  // Redis Status
  const redis = await getRedisClient().getMemoryReport();

  // Threshold evaluation
  const warnings = [];
  if (mem.rss > budgets.maxRssBytes) {
    warnings.push(`High Node.js RSS memory: ${(mem.rss / (1024 * 1024)).toFixed(1)} MB`);
  }
  if (eventLoopLagMs > 50) {
    warnings.push(`Event loop delay high: ${eventLoopLagMs} ms (p95: ${eventLoopP95Ms} ms)`);
  }
  if (disk.freeBytes !== null && disk.freeBytes < budgets.minFreeDiskBytes) {
    warnings.push(`Low disk space remaining: ${disk.freeGb} GB`);
  }
  if (dbPool && dbPool.waitingCount > 5) {
    warnings.push(`Database connection pool backlog: ${dbPool.waitingCount} queries waiting`);
  }

  const status = warnings.length === 0 ? 'HEALTHY' : warnings.some(w => w.includes('Low disk')) ? 'CRITICAL' : 'WARNING';

  if (warnings.length > 0) {
    process.stderr.write(JSON.stringify({
      level: status === 'CRITICAL' ? 'error' : 'warn',
      component: 'system_monitor',
      status,
      warnings,
      rssMb: (mem.rss / (1024 * 1024)).toFixed(1),
      heapUsedMb: (mem.heapUsed / (1024 * 1024)).toFixed(1)
    }) + '\n');
  }

  const ramBudgetGb = (budgets.ramBudgetBytes / (1024 * 1024 * 1024)).toFixed(1);
  const diskBudgetGb = disk.totalBytes ? (disk.totalBytes / (1024 * 1024 * 1024)).toFixed(1) : 'unbounded';

  return {
    status,
    timestamp: new Date().toISOString(),
    uptimeSeconds,
    budget: {
      memoryBudgetGb: `${ramBudgetGb} GB`,
      storageBudgetGb: disk.totalBytes ? `${diskBudgetGb} GB` : 'dynamic',
      maxProcessRssMb: `${(budgets.maxRssBytes / (1024 * 1024)).toFixed(0)} MB`
    },
    memory: {
      rss: `${(mem.rss / (1024 * 1024)).toFixed(1)} MB`,
      heapTotal: `${(mem.heapTotal / (1024 * 1024)).toFixed(1)} MB`,
      heapUsed: `${(mem.heapUsed / (1024 * 1024)).toFixed(1)} MB`,
      external: `${(mem.external / (1024 * 1024)).toFixed(1)} MB`,
      hostTotalGb: `${(hostTotalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`,
      hostFreeGb: `${(hostFreeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`,
      processRamPercentOfBudget: ((mem.rss / budgets.ramBudgetBytes) * 100).toFixed(2) + '%'
    },
    eventLoop: {
      meanMs: eventLoopLagMs,
      p95Ms: eventLoopP95Ms,
      maxMs: eventLoopMaxMs
    },
    database: {
      pool: dbPool
    },
    cache: redis,
    disk,
    warnings
  };
}
