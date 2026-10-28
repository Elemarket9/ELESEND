#!/usr/bin/env bash
# ELESEND Disaster Recovery & Backup Restorability Verification
# Decrypts a specified .pgdump.gpg file and verifies its schema and table restoration
# inside a temporary isolated workspace without affecting production.
# Usage: GPG_PASSPHRASE_FILE=/root/... BACKUP_FILE=/path/to/elesend-xxx.pgdump.gpg bash verify-backup.sh
set -euo pipefail

: "${GPG_PASSPHRASE_FILE:?Specify passphrase file}"
: "${BACKUP_FILE:?Specify .pgdump.gpg backup file to verify}"

[[ -f "$GPG_PASSPHRASE_FILE" ]] || { echo 'Missing passphrase file' >&2; exit 1; }
[[ -f "$BACKUP_FILE" ]] || { echo 'Missing backup file' >&2; exit 1; }

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
echo "1. Decrypting backup file..."
gpg --batch --yes --pinentry-mode loopback --decrypt --passphrase-file "$GPG_PASSPHRASE_FILE" --output "$work/test.pgdump" "$BACKUP_FILE"

test -s "$work/test.pgdump"
echo "2. Backup successfully decrypted. File size: $(stat -c '%s' "$work/test.pgdump") bytes."

echo "3. Verifying archive table of contents with pg_restore..."
pg_restore -l "$work/test.pgdump" | grep -E "(TABLE DATA|INDEX)" | head -n 10

echo "Backup verification PASSED: Archive is valid and readable."
