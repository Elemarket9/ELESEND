#!/usr/bin/env bash
# ELESEND Scheduled Off-Server Encrypted Backup & Offsite Retention
# Requires Docker, gpg, rclone, sha256sum.
# Usage: OFFSITE_RCLONE_REMOTE=remote:elesend-backups GPG_PASSPHRASE_FILE=/root/... bash backup-offsite.sh
set -euo pipefail

: "${OFFSITE_RCLONE_REMOTE:?Specify a remote offsite rclone destination}"
: "${GPG_PASSPHRASE_FILE:?Specify a root-only readable passphrase file}"
: "${BACKUP_RETENTION_DAYS:=30}"
: "${ELESEND_ENV_FILE:=.env.runtime}"

[[ -f "$GPG_PASSPHRASE_FILE" ]] || { echo 'Missing encryption passphrase' >&2; exit 1; }
mode=$(stat -c '%a' "$GPG_PASSPHRASE_FILE" 2>/dev/null || stat -f '%A' "$GPG_PASSPHRASE_FILE")
[[ "$mode" =~ ^[46]00$ ]] || { echo 'Passphrase file must have 0600 or 0400 permissions' >&2; exit 1; }

cd "$(dirname "$0")/../.."
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="elesend-${stamp}.pgdump.gpg"
checksum_file="${file}.sha256"

# 1. Generate encrypted custom-format PostgreSQL dump
docker compose -f deploy/runtime/compose.yaml --env-file "$ELESEND_ENV_FILE" exec -T db sh -c \
  'export PGPASSWORD="$POSTGRES_PASSWORD"; pg_dump --host=127.0.0.1 --username="${POSTGRES_USER:-elesend}" --dbname="${POSTGRES_DB:-elesend}" --format=custom --no-owner' \
  | gpg --batch --yes --pinentry-mode loopback --symmetric --cipher-algo AES256 --passphrase-file "$GPG_PASSPHRASE_FILE" --output "$work/$file"

test -s "$work/$file"

# 2. Compute SHA256 integrity checksum
(cd "$work" && sha256sum "$file" > "$checksum_file")

# 3. Upload encrypted backup and checksum offsite
rclone copyto "$work/$file" "${OFFSITE_RCLONE_REMOTE%/}/$file"
rclone copyto "$work/$checksum_file" "${OFFSITE_RCLONE_REMOTE%/}/$checksum_file"
rclone lsf "${OFFSITE_RCLONE_REMOTE%/}" --files-only | grep -Fx -- "$file" >/dev/null

printf 'Encrypted backup uploaded offsite: %s (Size: %s bytes)\n' "$file" "$(stat -c '%s' "$work/$file")"

# 4. Prune remote offsite backups older than retention policy
echo "Pruning remote backups older than ${BACKUP_RETENTION_DAYS} days..."
rclone delete --min-age "${BACKUP_RETENTION_DAYS}d" "${OFFSITE_RCLONE_REMOTE%/}" || true
echo "Backup and remote rotation completed successfully."
