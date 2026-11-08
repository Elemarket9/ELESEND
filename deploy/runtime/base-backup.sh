#!/usr/bin/env bash
# Nightly physical copy of the whole database, encrypted and stored offsite. Recovery starts from the newest one
# and replays the shipped WAL files on top, up to the moment you choose.
source "$(dirname "$0")/backup-lib.sh"
require_offsite
: "${BACKUP_RETENTION_DAYS:=30}"
trap 'heartbeat "${BASE_BACKUP_HEARTBEAT_URL:-}" fail' ERR
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="base-${stamp}.tar.gz.gpg"
# -X fetch puts the WAL needed for a consistent copy inside the backup, so each one can be restored on its own.
dc exec -T db sh -c 'pg_basebackup -h /var/run/postgresql -U "${POSTGRES_USER:-elesend}" -D - -Ft -X fetch --checkpoint=fast' \
  | gzip -c | encrypt_to "$work/$file"
test -s "$work/$file"
(cd "$work" && sha256sum "$file" > "$file.sha256")
upload_verified "$work/$file" "$OFFSITE/base/$file"
upload_verified "$work/$file.sha256" "$OFFSITE/base/$file.sha256"
echo "Base backup stored offsite: $file ($(stat -c '%s' "$work/$file") bytes)"
# Old base backups and the WAL they need go together. The newest base backup is never removed.
newest=$(rclone lsf "$OFFSITE/base" --files-only --include 'base-*.tar.gz.gpg' | sort | tail -1)
[[ "$newest" == "$file" ]] || { echo 'The new base backup is not the newest offsite; not pruning' >&2; exit 1; }
rclone delete --min-age "${BACKUP_RETENTION_DAYS}d" --exclude "$newest" "$OFFSITE/base" || true
rclone delete --min-age "$((BACKUP_RETENTION_DAYS+1))d" "$OFFSITE/wal" || true
heartbeat "${BASE_BACKUP_HEARTBEAT_URL:-}"
