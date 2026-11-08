#!/usr/bin/env bash
# Daily logical copy (pg_dump) of the database, encrypted and stored offsite. Easy to inspect or load into a fresh
# database; base-backup.sh and wal-ship.sh cover recovery to the minute.
source "$(dirname "$0")/backup-lib.sh"
require_offsite
: "${BACKUP_RETENTION_DAYS:=30}"
trap 'heartbeat "${BACKUP_HEARTBEAT_URL:-}" fail' ERR
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="elesend-${stamp}.pgdump.gpg"
dc exec -T db sh -c 'pg_dump -h /var/run/postgresql -U "${POSTGRES_USER:-elesend}" -d "${POSTGRES_DB:-elesend}" --format=custom --no-owner' \
  | encrypt_to "$work/$file"
test -s "$work/$file"
(cd "$work" && sha256sum "$file" > "$file.sha256")
upload_verified "$work/$file" "$OFFSITE/$file"
upload_verified "$work/$file.sha256" "$OFFSITE/$file.sha256"
echo "Encrypted backup uploaded offsite: $file ($(stat -c '%s' "$work/$file") bytes)"
rclone delete --min-age "${BACKUP_RETENTION_DAYS}d" --max-depth 1 --include 'elesend-*' "$OFFSITE" || true
heartbeat "${BACKUP_HEARTBEAT_URL:-}"
