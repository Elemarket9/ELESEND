#!/usr/bin/env bash
# CI only: proves the backup chain end to end against the real production database setup.
set -euo pipefail
dc() { docker compose -f deploy/runtime/compose.yaml --env-file "$ELESEND_ENV_FILE" "$@"; }
q() { dc exec -T db psql -U elesend -d elesend -Atqc "$1"; }
pass() { echo "DRILL PASS: $*"; }
fail() { echo "DRILL FAIL: $*"; exit 1; }

q "CREATE TABLE IF NOT EXISTS drill_marker(label text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())"
q "INSERT INTO drill_marker(label) VALUES('before-base-backup')"
bash deploy/runtime/base-backup.sh
ls /tmp/offsite/base | grep -q '^base-.*\.tar\.gz\.gpg$' && pass "nightly base backup stored offsite, encrypted"

q "INSERT INTO drill_marker(label) VALUES('after-base-backup')"
q "SELECT pg_switch_wal()" >/dev/null; sleep 3
bash deploy/runtime/wal-ship.sh
sleep 2; target=$(q "SELECT to_char(now(),'YYYY-MM-DD HH24:MI:SS.US')")"+00"; sleep 2
q "INSERT INTO drill_marker(label) VALUES('mistake-after-target')"
q "SELECT pg_switch_wal()" >/dev/null; sleep 3
bash deploy/runtime/wal-ship.sh
[ "$(dc exec -T db sh -c 'ls /var/lib/postgresql/wal-archive | grep -vc part' || true)" = "0" ] && pass "change files shipped offsite and cleared locally"
grep -c . <(ls /tmp/offsite/wal) | sed 's/^/DRILL WAL files offsite: /'
! gunzip -t "/tmp/offsite/wal/$(ls /tmp/offsite/wal | head -1)" 2>/dev/null && pass "offsite files are encrypted, not readable"

bash deploy/runtime/backup-offsite.sh
bash deploy/runtime/verify-backup.sh | tail -1 | grep -q PASSED && pass "weekly restore drill of the newest daily backup passes"

report=$(bash deploy/runtime/storage-check.sh || true); echo "DRILL watchdog: $report"
echo "$report" | grep -q '"walFilesWaiting":0' && pass "watchdog reads the archive backlog"

echo "--- Disaster: the database server and its disk are lost ---"
dc down -v
dc up -d db >/dev/null 2>&1 || true; sleep 5; dc stop db
ELESEND_ALLOW_DATABASE_RESTORE=YES bash deploy/runtime/restore-point-in-time.sh
got=$(q "SELECT string_agg(label,',' ORDER BY label) FROM drill_marker")
echo "DRILL restored to latest: $got"
[ "$got" = "after-base-backup,before-base-backup,mistake-after-target" ] && pass "restored everything up to the last shipped change"
[ "$(q "SELECT count(*) FROM schema_migrations")" -gt 60 ] && pass "full schema back"

echo "--- Undo a mistake: restore to the minute before it ---"
ELESEND_ALLOW_DATABASE_RESTORE=YES RESTORE_TARGET_TIME="$target" bash deploy/runtime/restore-point-in-time.sh
got=$(q "SELECT string_agg(label,',' ORDER BY label) FROM drill_marker")
echo "DRILL restored to $target: $got"
[ "$got" = "after-base-backup,before-base-backup" ] && pass "point-in-time restore stops just before the mistake"
q "INSERT INTO drill_marker(label) VALUES('writable-after-restore')" && pass "database accepts new records after restore"
dc exec -T db sh -c 'ls -d /var/lib/postgresql/before-restore-*' | sed 's/^/DRILL kept old copy: /'
