/**
 * ELESEND Official Node Redis Integration & Ephemeral Geospatial Engine
 * 
 * Uses official 'redis' library with built-in connection management,
 * reconnection strategies, and protocol parsing.
 * 
 * Provides:
 * - Sub-millisecond ephemeral storage for live rider GPS telemetry.
 * - Active member tracking and automated stale-member purging from shared ZSETs.
 * - Explicit rider removal on offline status or debt restriction.
 * - Seamless graceful fallback when Redis is unconfigured or unavailable.
 * 
 * Architecture Invariant:
 * Redis is an advisory spatial acceleration index. PostgreSQL remains the authoritative,
 * transactional source of truth for courier online status, verification, and debt restriction.
 */

import { createClient } from 'redis';

class ElesendRedisClient {
  constructor(url = process.env.REDIS_URL) {
    this.url = url;
    this.enabled = Boolean(url && url.trim().length > 0 && url.trim().toLowerCase() !== 'disabled');
    this.client = null;
    this.connected = false;
    this.connecting = false;

    if (this.enabled) {
      try {
        this.client = createClient({
          url: this.url,
          socket: {
            reconnectStrategy: (retries) => {
              if (retries > 20) {
                process.stderr.write('[REDIS] Max reconnect retries reached, backing off...\n');
                return 10000;
              }
              return Math.min(retries * 100, 3000);
            },
            connectTimeout: 5000
          }
        });

        this.client.on('connect', () => {
          this.connected = true;
        });

        this.client.on('ready', () => {
          this.connected = true;
        });

        this.client.on('error', (err) => {
          this.connected = false;
          // Structured warning log, avoids unhandled promise rejections
          if (process.env.NODE_ENV !== 'test') {
            process.stderr.write(JSON.stringify({
              level: 'warn',
              component: 'redis',
              msg: 'Redis connection error',
              err: err.message
            }) + '\n');
          }
        });

        this.client.on('end', () => {
          this.connected = false;
        });
      } catch (err) {
        this.enabled = false;
      }
    }
  }

  async connect() {
    if (!this.enabled || !this.client || this.connected) return this.connected;
    if (this.connecting) return false;
    this.connecting = true;
    try {
      await this.client.connect();
      this.connected = true;
      return true;
    } catch (err) {
      this.connected = false;
      return false;
    } finally {
      this.connecting = false;
    }
  }

  async ping() {
    if (!this.enabled) return 'DISABLED';
    try {
      if (!this.connected) await this.connect();
      if (!this.connected) return 'DISCONNECTED';
      return await this.client.ping();
    } catch {
      return 'ERROR';
    }
  }

  /**
   * Ephemeral live rider coordinate update.
   * Updates:
   * 1. GEOADD in shared 'elesend:riders:geo' spatial index
   * 2. ZADD in 'elesend:riders:active' with timestamp score for stale-member pruning
   * 3. HSET in 'elesend:rider:<riderId>' with TTL
   */
  async saveRiderLocation(riderId, { latitude, longitude, heading = null, speed = null, accuracy = null, observedAt = null }, ttlSeconds = 900) {
    if (!this.enabled) return false;
    try {
      if (!this.connected) await this.connect();
      if (!this.connected) return false;

      const tsStr = observedAt || new Date().toISOString();
      const tsMs = Date.parse(tsStr) || Date.now();
      const numLon = Number(longitude);
      const numLat = Number(latitude);

      const multi = this.client.multi();
      // 1. Geospatial index
      multi.geoAdd('elesend:riders:geo', {
        longitude: numLon,
        latitude: numLat,
        member: riderId
      });
      // 2. Timestamped active ZSET for safe expiration and stale-member removal
      multi.zAdd('elesend:riders:active', {
        score: tsMs,
        value: riderId
      });
      // 3. Telemetry details Hash
      multi.hSet(`elesend:rider:${riderId}`, {
        lat: String(numLat),
        lon: String(numLon),
        hdg: String(heading ?? 0),
        spd: String(speed ?? 0),
        acc: String(accuracy ?? 0),
        ts: tsStr
      });
      // 4. Hash TTL
      multi.expire(`elesend:rider:${riderId}`, ttlSeconds);

      await multi.exec();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retrieves active cached telemetry for a courier.
   */
  async getRiderLocation(riderId) {
    if (!this.enabled) return null;
    try {
      if (!this.connected) await this.connect();
      if (!this.connected) return null;

      const data = await this.client.hGetAll(`elesend:rider:${riderId}`);
      if (!data || Object.keys(data).length === 0 || !data.lat) return null;

      return {
        latitude: parseFloat(data.lat),
        longitude: parseFloat(data.lon),
        heading: parseFloat(data.hdg || 0),
        speed: parseFloat(data.spd || 0),
        accuracy: parseFloat(data.acc || 0),
        observedAt: data.ts
      };
    } catch {
      return null;
    }
  }

  /**
   * Removes a courier from all Redis indexes immediately.
   * Must be called when a rider goes offline, disconnects, or is debt-restricted.
   */
  async removeRiderLocation(riderId) {
    if (!this.enabled) return false;
    try {
      if (!this.connected) await this.connect();
      if (!this.connected) return false;

      const multi = this.client.multi();
      multi.zRem('elesend:riders:geo', riderId);
      multi.zRem('elesend:riders:active', riderId);
      multi.del(`elesend:rider:${riderId}`);
      await multi.exec();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Prunes stale couriers who haven't sent a telemetry ping within maxAgeSeconds.
   * Removes stale members from both 'elesend:riders:geo' and 'elesend:riders:active'.
   */
  async purgeStaleRiders(maxAgeSeconds = 300) {
    if (!this.enabled) return 0;
    try {
      if (!this.connected) await this.connect();
      if (!this.connected) return 0;

      const cutoffMs = Date.now() - (maxAgeSeconds * 1000);
      // Find all couriers whose last active score is older than cutoff
      const staleRiderIds = await this.client.zRangeByScore('elesend:riders:active', '-inf', cutoffMs);
      if (!staleRiderIds || staleRiderIds.length === 0) return 0;

      const multi = this.client.multi();
      // Remove stale IDs from geospatial ZSET
      multi.zRem('elesend:riders:geo', staleRiderIds);
      // Remove from active timestamp ZSET
      multi.zRem('elesend:riders:active', staleRiderIds);
      // Delete any residual hashes
      for (const id of staleRiderIds) {
        multi.del(`elesend:rider:${id}`);
      }
      await multi.exec();

      return staleRiderIds.length;
    } catch {
      return 0;
    }
  }

  /**
   * Fast Redis proximity search with lazy freshness verification.
   * If a returned member has no fresh hash or is stale, it is automatically pruned.
   */
  async findNearbyRiders(latitude, longitude, radiusKm = 5, count = 20, maxFreshAgeSeconds = 300) {
    if (!this.enabled) return [];
    try {
      if (!this.connected) await this.connect();
      if (!this.connected) return [];

      let rawResults = [];
      try {
        // Redis 6.2+ GEOSEARCH
        rawResults = await this.client.geoSearchWith(
          'elesend:riders:geo',
          { longitude: Number(longitude), latitude: Number(latitude) },
          { radius: Number(radiusKm), unit: 'km' },
          ['WITHDIST'],
          { SORT: 'ASC', COUNT: count }
        );
      } catch {
        // Fallback for older Redis versions
        rawResults = await this.client.geoRadius(
          'elesend:riders:geo',
          { longitude: Number(longitude), latitude: Number(latitude) },
          Number(radiusKm),
          'km',
          ['WITHDIST', 'ASC', 'COUNT', count]
        );
      }

      if (!Array.isArray(rawResults) || rawResults.length === 0) return [];

      const verified = [];
      const staleToPurge = [];
      const now = Date.now();
      const cutoffMs = now - (maxFreshAgeSeconds * 1000);

      for (const item of rawResults) {
        const memberId = typeof item === 'string' ? item : item.member || item[0];
        const distKm = parseFloat(typeof item === 'object' && item.distance !== undefined ? item.distance : item[1] || 0);

        // Verify active freshness in ZSET score or Hash
        const score = await this.client.zScore('elesend:riders:active', memberId);
        if (score === null || score < cutoffMs) {
          staleToPurge.push(memberId);
          continue;
        }

        verified.push({
          riderId: memberId,
          distanceKm: distKm
        });
      }

      // Lazily purge stale members discovered during search
      if (staleToPurge.length > 0) {
        this.client.zRem('elesend:riders:geo', staleToPurge).catch(() => {});
        this.client.zRem('elesend:riders:active', staleToPurge).catch(() => {});
      }

      return verified;
    } catch {
      return [];
    }
  }

  async getMemoryReport() {
    if (!this.enabled) {
      return {
        status: 'disabled',
        reason: 'REDIS_URL not configured. Ephemeral caching falling back to bounded in-memory.'
      };
    }
    try {
      if (!this.connected) await this.connect();
      if (!this.connected) return { status: 'disconnected' };

      const infoStr = await this.client.info('memory');
      const lines = infoStr.split('\r\n');
      const metrics = {};
      for (const line of lines) {
        const [k, v] = line.split(':');
        if (k && v) metrics[k.trim()] = v.trim();
      }

      const activeCouriers = await this.client.zCard('elesend:riders:active').catch(() => 0);

      return {
        status: 'connected',
        usedMemoryHuman: metrics.used_memory_human || 'N/A',
        usedMemoryPeakHuman: metrics.used_memory_peak_human || 'N/A',
        maxMemoryHuman: metrics.maxmemory_human || '512MB (Target)',
        maxMemoryPolicy: metrics.maxmemory_policy || 'allkeys-lru',
        evictedKeys: parseInt(metrics.evicted_keys || '0', 10),
        activeCouriersInIndex: activeCouriers
      };
    } catch (err) {
      return { status: 'error', message: err.message };
    }
  }

  async close() {
    if (this.client && this.connected) {
      try {
        await this.client.quit();
      } catch {
        this.client.disconnect();
      }
      this.connected = false;
    }
  }
}

let instance = null;

export function getRedisClient(url = process.env.REDIS_URL) {
  if (!instance || (url && instance.url !== url)) {
    if (instance) instance.close().catch(() => {});
    instance = new ElesendRedisClient(url);
  }
  return instance;
}
