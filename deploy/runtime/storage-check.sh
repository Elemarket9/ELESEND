#!/usr/bin/env bash
# ELESEND Production Storage & Memory Health Watchdog
# Checks host memory and disk headroom against configured runtime thresholds.
# Exits with 0 (Healthy), 1 (Warning), or 2 (Critical).
set -euo pipefail

# 1. Storage Metrics (KB)
free_kb=$(df -Pk / | awk 'NR==2{print $4}')
total_kb=$(df -Pk / | awk 'NR==2{print $2}')
used_percent=$(( (total_kb - free_kb) * 100 / total_kb ))

# Volumes directory
volumes_kb=$(du -sk /var/lib/docker/volumes 2>/dev/null | awk '{print $1}' || echo 0)

# 2. Memory Metrics (KB)
mem_total_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 8388608)
mem_avail_kb=$(awk '/MemAvailable/ {print $2}' /proc/meminfo 2>/dev/null || echo "$mem_total_kb")
mem_used_percent=$(( (mem_total_kb - mem_avail_kb) * 100 / mem_total_kb ))

# Database change log (pg_wal) and files waiting to be shipped offsite. Either growing means archiving is failing,
# which ends with a full disk and a stopped database, so both raise the alarm long before that.
wal_mb=0; waiting=0
if [[ -n "${ELESEND_ROOT:-}" ]]; then
  dcq() { docker compose -f "$ELESEND_ROOT/deploy/runtime/compose.yaml" --env-file "${ELESEND_ENV_FILE:-$ELESEND_ROOT/.env.runtime}" "$@"; }
  wal_mb=$(dcq exec -T db sh -c 'du -sm "$PGDATA/pg_wal" | cut -f1' 2>/dev/null || echo 0)
  waiting=$(dcq exec -T db sh -c 'ls -1 /var/lib/postgresql/wal-archive 2>/dev/null | grep -vc "\.part$"' 2>/dev/null || echo 0)
fi

# 3. Formulate JSON report
status="HEALTHY"
exit_code=0

# Configurable Thresholds:
# Disk Critical: < 5 GB free (5242880 KB)
# Disk Warning: < 20 GB free (20971520 KB)
# RAM Critical: > 90% used
# RAM Warning: > 80% used
if (( free_kb < 5242880 || mem_used_percent > 90 || wal_mb > 6144 || waiting > 120 )); then
  status="CRITICAL"
  exit_code=2
elif (( free_kb < 20971520 || mem_used_percent > 80 || wal_mb > 4608 || waiting > 30 )); then
  status="WARNING"
  exit_code=1
fi

printf '{"component":"runtime_watchdog","status":"%s","disk":{"totalKb":%s,"freeKb":%s,"usedPercent":%s,"volumesKb":%s},"memory":{"totalKb":%s,"availableKb":%s,"usedPercent":%s},"database":{"walMb":%s,"walFilesWaiting":%s},"timestamp":"%s"}\n' \
  "$status" "$total_kb" "$free_kb" "$used_percent" "$volumes_kb" "$mem_total_kb" "$mem_avail_kb" "$mem_used_percent" "$wal_mb" "$waiting" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Pings the monitoring URL only while healthy, so a warning, a crash of this check or a dead server all alert.
if (( exit_code == 0 )) && [[ -n "${STORAGE_HEARTBEAT_URL:-}" ]]; then curl -fsS -m 10 --retry 3 "$STORAGE_HEARTBEAT_URL" >/dev/null || true; fi
exit $exit_code
