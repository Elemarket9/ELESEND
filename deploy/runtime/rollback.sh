#!/usr/bin/env bash
# Normal rollback preserves all database/financial records. Restore is explicit disaster recovery.
set -euo pipefail
_DIR="${BASH_SOURCE[0]%/*}"
if [ "$_DIR" = "${BASH_SOURCE[0]}" ]; then _DIR=.; fi
SCRIPT_DIR="$(cd "$_DIR" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/compose.yaml"
ENV_FILE="${ELESEND_ENV_FILE:-${REPO_ROOT}/.env.runtime}"
BACKUP_DIR="${ELESEND_BACKUP_DIR:-${REPO_ROOT}/.deploy-backups}"
SNAPSHOT_FILE="${BACKUP_DIR}/pre-deploy-snapshot.sql"
RESTORE=false
if [ "${1:-}" = "--restore-database" ]; then
  RESTORE=true
  [ "${ELESEND_ALLOW_DATABASE_RESTORE:-}" = "YES" ] || { echo 'Explicit ELESEND_ALLOW_DATABASE_RESTORE=YES is required'; exit 1; }
  [ -s "${SNAPSHOT_FILE}" ] || { echo 'Readable, non-empty recovery snapshot required'; exit 1; }
  # The snapshot is from the last deploy. Restoring it erases everything recorded since, so say how much that is,
  # and refuse a snapshot older than a day unless that loss is confirmed too. For anything else, use
  # restore-point-in-time.sh, which can go back to a chosen minute.
  SNAPSHOT_AGE_HOURS=$(( ($(date +%s) - $(stat -c %Y "${SNAPSHOT_FILE}")) / 3600 ))
  echo "The snapshot is ${SNAPSHOT_AGE_HOURS} hour(s) old. Every order, payment and account change since then will be removed (a safety copy is taken first)."
  if [ "${SNAPSHOT_AGE_HOURS}" -ge 24 ] && [ "${ELESEND_ALLOW_OLD_SNAPSHOT:-}" != "YES" ]; then
    echo "Refusing: that would erase about $(( SNAPSHOT_AGE_HOURS / 24 )) day(s) of records. Use restore-point-in-time.sh, or set ELESEND_ALLOW_OLD_SNAPSHOT=YES if you really mean it."
    exit 1
  fi
elif [ "$#" -ne 0 ]; then
  echo 'Usage: rollback.sh [--restore-database]'; exit 1
fi
command -v docker >/dev/null || { echo 'Docker is required'; exit 1; }
[ -f "${ENV_FILE}" ] || { echo "Missing deployment environment: ${ENV_FILE}"; exit 1; }
dc() { docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"; }
docker image inspect elesend-api:previous >/dev/null
# Refuse rollback before taking down ingress if the previous image is unavailable.
dc stop api caddy
if [ "${RESTORE}" = true ]; then
  dc up -d db
  READY=false
  for ((attempt=0;attempt<30;attempt++)); do
    if dc exec -T db pg_isready -U "${POSTGRES_USER:-elesend}" -d "${POSTGRES_DB:-elesend}" >/dev/null; then READY=true; break; fi
    sleep 1
  done
  [ "${READY}" = true ] || { echo 'Database not ready; no restore attempted'; exit 1; }
  printf -v RESTORE_TIMESTAMP '%(%Y%m%dT%H%M%SZ)T' -1
  SAFETY_BACKUP="${BACKUP_DIR}/before-explicit-restore-${RESTORE_TIMESTAMP}.sql"
  dc exec -T db pg_dump -U "${POSTGRES_USER:-elesend}" "${POSTGRES_DB:-elesend}" > "${SAFETY_BACKUP}"
  [ -s "${SAFETY_BACKUP}" ]
  # Single transaction: a SQL error rolls back the schema drop and entire restore.
  { printf 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;\n'; while IFS= read -r line || [ -n "$line" ]; do printf '%s\n' "$line"; done < "${SNAPSHOT_FILE}"; } |
    dc exec -T db psql -X --single-transaction -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-elesend}" -d "${POSTGRES_DB:-elesend}"
fi
docker tag elesend-api:previous elesend-api:latest
export ELESEND_API_IMAGE=elesend-api:latest
dc up -d --no-build --no-deps api caddy
for ((attempt=0;attempt<30;attempt++)); do
  if dc exec -T api node --input-type=module -e '
    const token=process.env.READINESS_PROBE_TOKEN;
    const headers=token?{"x-elesend-health-token":token,"x-readiness-token":token}:{};
    const response=await fetch("http://127.0.0.1:"+(process.env.PORT||3090)+"/readyz",{headers});
    if(!response.ok)process.exit(1);
  '; then echo 'Previous image is ready; database preserved unless explicit restore was requested'; exit 0; fi
  sleep 1
done
echo 'Readiness did not recover; inspect container logs. No success claimed.'; exit 1
