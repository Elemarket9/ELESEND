#!/usr/bin/env bash
# Example scheduled OFF-SERVER encrypted backup; requires Docker, gpg, rclone.
# Usage: OFFSITE_RCLONE_REMOTE=remote:elesend-backups GPG_PASSPHRASE_FILE=/root/... bash backup-offsite.sh
# This script does NOT prove backup restorability; test restores separately.
set -euo pipefail
: "${OFFSITE_RCLONE_REMOTE:?Specify a remote off-VPS rclone destination}"
: "${GPG_PASSPHRASE_FILE:?Specify a root-only readable passphrase file}"
[[ -f "$GPG_PASSPHRASE_FILE" ]] || { echo 'Missing encryption passphrase' >&2; exit 1; }
mode=$(stat -c '%a' "$GPG_PASSPHRASE_FILE")
[[ "$mode" == '600' || "$mode" == '400' ]] || { echo 'Passphrase file must have 0600 or 0400 permissions' >&2; exit 1; }
cd "$(dirname "$0")/../.."
work=$(mktemp -d);trap 'rm -rf "$work"' EXIT
stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="elesend-${stamp}.pgdump.gpg"
docker compose -f deploy/vps/compose.yaml --env-file .env.vps exec -T db sh -c \
  'export PGPASSWORD="$POSTGRES_PASSWORD"; pg_dump --host=127.0.0.1 --username=elesend --dbname=elesend --format=custom --no-owner' \
  | gpg --batch --yes --pinentry-mode loopback --symmetric --cipher-algo AES256 --passphrase-file "$GPG_PASSPHRASE_FILE" --output "$work/$file"
test -s "$work/$file"
rclone copyto "$work/$file" "${OFFSITE_RCLONE_REMOTE%/}/$file"
rclone lsf "${OFFSITE_RCLONE_REMOTE%/}" --files-only | grep -Fx -- "$file" >/dev/null
printf 'Encrypted backup uploaded offsite: %s\n' "$file"
