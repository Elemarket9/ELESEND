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

# 3. Formulate JSON report
status="HEALTHY"
exit_code=0

# Configurable Thresholds:
# Disk Critical: < 5 GB free (5242880 KB)
# Disk Warning: < 20 GB free (20971520 KB)
# RAM Critical: > 90% used
# RAM Warning: > 80% used
if (( free_kb < 5242880 || mem_used_percent > 90 )); then
  status="CRITICAL"
  exit_code=2
elif (( free_kb < 20971520 || mem_used_percent > 80 )); then
  status="WARNING"
  exit_code=1
fi

printf '{"component":"runtime_watchdog","status":"%s","disk":{"totalKb":%s,"freeKb":%s,"usedPercent":%s,"volumesKb":%s},"memory":{"totalKb":%s,"availableKb":%s,"usedPercent":%s},"timestamp":"%s"}\n' \
  "$status" "$total_kb" "$free_kb" "$used_percent" "$volumes_kb" "$mem_total_kb" "$mem_avail_kb" "$mem_used_percent" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

exit $exit_code
