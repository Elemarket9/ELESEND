#!/usr/bin/env bash
# Caller must ship nonzero exit / logs to a real on-call alert destination.
set -euo pipefail
budget_kb=${ELESEND_TARGET_STORAGE_KB:-20971520} # 20 GiB planning goal, not disk size specification
used_kb=$(du -sk /var/lib/docker/volumes 2>/dev/null | awk '{print $1}' || true)
used_kb=${used_kb:-0}
free_kb=$(df -Pk / | awk 'NR==2{print $4}')
printf '{"type":"storage","usedKb":%s,"freeKb":%s,"targetKb":%s}\n' "$used_kb" "$free_kb" "$budget_kb"
if (( free_kb < 2097152 || used_kb > budget_kb * 85 / 100 )); then exit 2; fi
