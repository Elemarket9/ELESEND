#!/usr/bin/env bash
# Moves each finished database change file (WAL) off the server, encrypted, then removes the local copy.
# Runs every minute (elesend-wal-ship.timer). Together with base-backup.sh this allows point-in-time recovery.
source "$(dirname "$0")/backup-lib.sh"
require_offsite
trap 'heartbeat "${WAL_HEARTBEAT_URL:-}" fail' ERR
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
staging=/var/lib/postgresql/wal-archive
shipped=0
for f in $(dc exec -T db sh -c "ls -1 $staging 2>/dev/null | sort" || true); do
  # Finished WAL segments, timeline history and backup label files only; never a file still being copied.
  [[ "$f" =~ ^[0-9A-F]{8}(\.history|[0-9A-F]{16}(\.[0-9A-F]{8}\.backup|\.partial)?)$ ]] || continue
  dc exec -T db cat "$staging/$f" | gzip -c | encrypt_to "$work/$f.gz.gpg"
  test -s "$work/$f.gz.gpg"
  upload_verified "$work/$f.gz.gpg" "$OFFSITE/wal/$f.gz.gpg"
  dc exec -T db rm -f "$staging/$f"
  rm -f "$work/$f.gz.gpg"
  shipped=$((shipped+1))
done
# Anything left behind means shipping is falling behind: alert before the staging folder fills the disk.
waiting=$(dc exec -T db sh -c "ls -1 $staging 2>/dev/null | grep -vc '\.part$'" || true)
if (( ${waiting:-0} > 60 )); then echo "$waiting WAL files still waiting to be shipped" >&2; heartbeat "${WAL_HEARTBEAT_URL:-}" fail; exit 1; fi
echo "Shipped $shipped WAL file(s) offsite"
heartbeat "${WAL_HEARTBEAT_URL:-}"
