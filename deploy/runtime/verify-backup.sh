#!/usr/bin/env bash
# ELESEND Disaster Recovery & Backup Restorability Verification
# Decrypts a specified .pgdump.gpg file, restores it into an isolated temporary
# PostgreSQL database with --exit-on-error, and verifies migrations, critical
# operational tables, and double-entry financial ledger invariants.
# Usage: GPG_PASSPHRASE_FILE=/root/... BACKUP_FILE=/path/to/elesend-xxx.pgdump.gpg bash verify-backup.sh
set -euo pipefail

: "${GPG_PASSPHRASE_FILE:?Specify passphrase file}"
: "${BACKUP_FILE:?Specify .pgdump.gpg backup file to verify}"
: "${ELESEND_ENV_FILE:=.env.runtime}"

[[ -f "$GPG_PASSPHRASE_FILE" ]] || { echo 'Missing passphrase file' >&2; exit 1; }
[[ -f "$BACKUP_FILE" ]] || { echo 'Missing backup file' >&2; exit 1; }

work=$(mktemp -d)
verify_db="elesend_restore_verify_$(date -u +%s)_$$"

run_psql_admin() {
  local sql="$1"
  if [[ -n "${VERIFY_PG_SUPER_URL:-}" ]]; then
    psql "$VERIFY_PG_SUPER_URL" -v ON_ERROR_STOP=1 -Atqc "$sql"
  else
    docker compose -f deploy/runtime/compose.yaml --env-file "$ELESEND_ENV_FILE" exec -T db sh -c \
      "export PGPASSWORD=\"\$POSTGRES_PASSWORD\"; psql -h 127.0.0.1 -U \"${POSTGRES_USER:-elesend}\" -d postgres -v ON_ERROR_STOP=1 -Atqc \"$sql\""
  fi
}

run_psql_verify() {
  local sql="$1"
  if [[ -n "${VERIFY_PG_SUPER_URL:-}" ]]; then
    local base_url="${VERIFY_PG_SUPER_URL%/*}"
    psql "${base_url}/${verify_db}" -v ON_ERROR_STOP=1 -Atqc "$sql"
  else
    docker compose -f deploy/runtime/compose.yaml --env-file "$ELESEND_ENV_FILE" exec -T db sh -c \
      "export PGPASSWORD=\"\$POSTGRES_PASSWORD\"; psql -h 127.0.0.1 -U \"${POSTGRES_USER:-elesend}\" -d \"$verify_db\" -v ON_ERROR_STOP=1 -Atqc \"$sql\""
  fi
}

cleanup() {
  run_psql_admin "DROP DATABASE IF EXISTS \"${verify_db}\" WITH (FORCE);" >/dev/null 2>&1 || \
    run_psql_admin "DROP DATABASE IF EXISTS \"${verify_db}\";" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

echo "1. Decrypting backup file..."
gpg --batch --yes --pinentry-mode loopback --decrypt --passphrase-file "$GPG_PASSPHRASE_FILE" --output "$work/test.pgdump" "$BACKUP_FILE"

test -s "$work/test.pgdump"
dump_size=$(wc -c < "$work/test.pgdump" | tr -d ' ')
echo "2. Backup successfully decrypted. File size: ${dump_size} bytes."

echo "3. Verifying archive table of contents with pg_restore..."
toc=$(pg_restore -l "$work/test.pgdump")
echo "$toc" | grep -E "schema_migrations" >/dev/null
echo "$toc" | grep -E "shipments" >/dev/null

echo "4. Creating isolated verification database ${verify_db} and restoring archive..."
run_psql_admin "CREATE DATABASE \"${verify_db}\";"
run_psql_verify "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS postgis;"

if [[ -n "${VERIFY_PG_SUPER_URL:-}" ]]; then
  base_url="${VERIFY_PG_SUPER_URL%/*}"
  pg_restore --exit-on-error --no-owner --no-privileges --dbname="${base_url}/${verify_db}" "$work/test.pgdump"
else
  docker compose -f deploy/runtime/compose.yaml --env-file "$ELESEND_ENV_FILE" exec -T db sh -c \
    "export PGPASSWORD=\"\$POSTGRES_PASSWORD\"; pg_restore --exit-on-error --no-owner --no-privileges -h 127.0.0.1 -U \"${POSTGRES_USER:-elesend}\" -d \"$verify_db\"" < "$work/test.pgdump"
fi

echo "5. Verifying restored migrations, critical records, and double-entry financial ledger invariants..."
migration_count=$(run_psql_verify "SELECT count(*)::int FROM schema_migrations;")
if [[ "${migration_count:-0}" -lt 1 ]]; then
  echo "Verification FAILED: schema_migrations is empty after restore" >&2
  exit 1
fi

missing_tables=$(run_psql_verify "
  SELECT count(*)::int
  FROM unnest(ARRAY[
    'schema_migrations','users','shipments','quotes','food_orders',
    'restaurants','journal_entries','ledger_lines',
    'checkout_accounting_journals','checkout_accounting_lines'
  ]) AS required_table
  WHERE to_regclass('public.' || required_table) IS NULL;
")
if [[ "${missing_tables:-1}" -ne 0 ]]; then
  echo "Verification FAILED: ${missing_tables} required table(s) missing in restored database" >&2
  exit 1
fi

unbalanced_journals=$(run_psql_verify "
  SELECT (
    (SELECT count(*) FROM (
      SELECT entry_id
      FROM ledger_lines
      GROUP BY entry_id
      HAVING coalesce(sum(CASE WHEN side = 'debit' THEN amount_minor ELSE 0 END), 0)
          <> coalesce(sum(CASE WHEN side = 'credit' THEN amount_minor ELSE 0 END), 0)
    ) AS u1)
    +
    (SELECT count(*) FROM (
      SELECT journal_id
      FROM checkout_accounting_lines
      GROUP BY journal_id
      HAVING coalesce(sum(CASE WHEN side = 'debit' THEN amount_minor ELSE 0 END), 0)
          <> coalesce(sum(CASE WHEN side = 'credit' THEN amount_minor ELSE 0 END), 0)
    ) AS u2)
  )::int;
")
if [[ "${unbalanced_journals:-1}" -ne 0 ]]; then
  echo "Verification FAILED: ${unbalanced_journals} unbalanced financial ledger journal(s) detected" >&2
  exit 1
fi

orphan_lines=$(run_psql_verify "
  SELECT (
    (SELECT count(*) FROM journal_entries j WHERE NOT EXISTS (SELECT 1 FROM ledger_lines l WHERE l.entry_id = j.id))
    +
    (SELECT count(*) FROM checkout_accounting_journals j WHERE NOT EXISTS (SELECT 1 FROM checkout_accounting_lines l WHERE l.journal_id = j.id))
  )::int;
")
if [[ "${orphan_lines:-1}" -ne 0 ]]; then
  echo "Verification FAILED: ${orphan_lines} empty ledger journal(s) detected" >&2
  exit 1
fi

echo "Backup verification PASSED: Restored ${migration_count} migrations into isolated database ${verify_db}; all critical tables and financial ledger invariants verified."
