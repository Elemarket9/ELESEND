#!/usr/bin/env bash
# ELESEND Safe Production Container Maintenance & Cleanup
# Safely reclaims disk space without touching active named volumes.
# CRITICAL SAFETY: Never runs 'docker volume prune -a' or removes pgdata/caddydata.
set -euo pipefail

echo "=== ELESEND Container Maintenance Starting ==="
date -u +"%Y-%m-%dT%H:%M:%SZ"

# 1. Report disk space before cleanup
echo "--- Disk Space Before ---"
df -h /

# 2. Prune dangling build cache older than 7 days
echo "--- Pruning Dangling Build Cache (>7 days) ---"
docker builder prune -f --filter "until=168h" || true

# 3. Prune dangling images (untagged layers from previous deployments)
echo "--- Pruning Dangling Images ---"
docker image prune -f || true

# 4. Remove stopped temporary containers (not active service containers)
echo "--- Pruning Stopped Transient Containers ---"
docker container prune -f --filter "until=24h" || true

# 5. Truncate oversized container logs (>50MB safeguard if rotation failed)
echo "--- Checking Container Log Sizes ---"
for log in $(find /var/lib/docker/containers/ -name "*-json.log" 2>/dev/null); do
  size_mb=$(du -m "$log" | cut -f1)
  if [ "$size_mb" -gt 50 ]; then
    echo "Truncating oversized log ($size_mb MB): $log"
    truncate -s 0 "$log"
  fi
done

# 6. Report disk space after cleanup
echo "--- Disk Space After ---"
df -h /

echo "=== ELESEND Container Maintenance Finished ==="
