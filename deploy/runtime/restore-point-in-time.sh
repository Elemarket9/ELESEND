#!/usr/bin/env bash
# Disaster recovery: rebuilds the database from the newest offsite base backup and replays the shipped WAL files,
# to the latest moment available or to RESTORE_TARGET_TIME (for example "2027-02-10 14:05:00+00", just before a
# bad change). The broken database is kept, renamed, on the same volume until you delete it.
# Usage: ELESEND_ALLOW_DATABASE_RESTORE=YES [RESTORE_TARGET_TIME=...] [BASE_BACKUP=base-...tar.gz.gpg] bash restore-point-in-time.sh
source "$(dirname "$0")/backup-lib.sh"
require_offsite
[[ "${ELESEND_ALLOW_DATABASE_RESTORE:-}" == "YES" ]] || { echo 'Set ELESEND_ALLOW_DATABASE_RESTORE=YES to confirm the restore' >&2; exit 1; }
if [[ -n "${RESTORE_TARGET_TIME:-}" && ! "$RESTORE_TARGET_TIME" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[\ T][0-9]{2}:[0-9]{2}(:[0-9]{2})?([+-][0-9]{2}(:?[0-9]{2})?|Z)?$ ]]; then
  echo 'RESTORE_TARGET_TIME must look like 2027-02-10 14:05:00+00' >&2; exit 1
fi
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
base="${BASE_BACKUP:-$(rclone lsf "$OFFSITE/base" --files-only --include 'base-*.tar.gz.gpg' | sort | tail -1)}"
[[ "$base" =~ ^base-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.gpg$ ]] || { echo 'No base backup found offsite' >&2; exit 1; }
echo "1. Downloading base backup $base and the WAL files after it"
rclone copyto "$OFFSITE/base/$base" "$work/$base"
rclone copyto "$OFFSITE/base/$base.sha256" "$work/$base.sha256"
(cd "$work" && sha256sum -c "$base.sha256")
mkdir -p "$work/base" "$work/wal"
decrypt_from "$work/$base" | gunzip -c | tar -x -C "$work/base"
rclone copy "$OFFSITE/wal" "$work/wal.enc" --include '*.gz.gpg'
for f in "$work"/wal.enc/*.gz.gpg; do [[ -e "$f" ]] || continue; n=$(basename "$f" .gz.gpg); decrypt_from "$f" | gunzip -c > "$work/wal/$n"; done
echo "   $(ls "$work/wal" | wc -l) WAL file(s) ready"

echo "2. Stopping the app and the database"
dc stop api caddy db
pgdata=$(dc run --rm --no-deps -T --entrypoint sh db -c 'printf %s "$PGDATA"')
[[ "$pgdata" == /var/lib/postgresql/* ]] || { echo "Unexpected database folder: $pgdata" >&2; exit 1; }
kept="/var/lib/postgresql/before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
target_line=""
[[ -n "${RESTORE_TARGET_TIME:-}" ]] && target_line="recovery_target_time = '${RESTORE_TARGET_TIME}'"
echo "3. Keeping the old database at $kept and laying down the backup"
tar -C "$work" -cf - base wal | dc run --rm --no-deps -T --entrypoint sh db -c "
  set -e
  if [ -d $pgdata ]; then mkdir -p $kept && mv $pgdata $kept/; fi
  mkdir -p $pgdata /var/lib/postgresql/restore-wal
  cd /tmp && tar -xf -
  cp -a /tmp/base/. $pgdata/
  rm -rf /var/lib/postgresql/restore-wal/* && cp /tmp/wal/* /var/lib/postgresql/restore-wal/ 2>/dev/null || true
  cat >> $pgdata/postgresql.auto.conf <<CONF
restore_command = 'cp /var/lib/postgresql/restore-wal/%f %p'
recovery_target_action = 'promote'
$target_line
CONF
  touch $pgdata/recovery.signal
  chown -R postgres:postgres /var/lib/postgresql
  chmod 700 $pgdata"
echo "4. Starting the database and replaying changes"
dc up -d db
for ((i=0;i<600;i++)); do
  state=$(dc exec -T db psql -U "${POSTGRES_USER:-elesend}" -d "${POSTGRES_DB:-elesend}" -Atqc 'SELECT pg_is_in_recovery()' 2>/dev/null || true)
  [[ "$state" == "f" ]] && break
  sleep 2
done
[[ "$state" == "f" ]] || { echo 'Recovery did not finish; check: docker compose logs db' >&2; exit 1; }
dc exec -T db psql -U "${POSTGRES_USER:-elesend}" -d "${POSTGRES_DB:-elesend}" -v ON_ERROR_STOP=1 -qc \
  "ALTER SYSTEM RESET restore_command; ALTER SYSTEM RESET recovery_target_action; ALTER SYSTEM RESET recovery_target_time; SELECT pg_reload_conf();" >/dev/null
last=$(dc exec -T db psql -U "${POSTGRES_USER:-elesend}" -d "${POSTGRES_DB:-elesend}" -Atqc "SELECT max(created_at) FROM shipments")
dc exec -T db rm -rf /var/lib/postgresql/restore-wal
echo "5. Restored. Newest delivery in the database: ${last:-none}."
echo "   Check the data, then start the app: docker compose -f deploy/runtime/compose.yaml --env-file $ELESEND_ENV_FILE up -d api caddy"
echo "   The old database is kept at $kept inside the database volume. Remove it once you are satisfied."
echo "   Take a new base backup now (base-backup.sh): the restored database starts a new timeline."
