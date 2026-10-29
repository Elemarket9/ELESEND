#!/usr/bin/env bash
# ==============================================================================
# ELESEND EGIA — Runtime Staging and Verification Deployment Script
# ==============================================================================
set -euo pipefail

_DIR="${BASH_SOURCE[0]%/*}"
if [ "$_DIR" = "${BASH_SOURCE[0]}" ]; then
  _DIR="."
fi
SCRIPT_DIR="$(cd "$_DIR" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/compose.yaml"
BACKUP_DIR="${REPO_ROOT}/.deploy-backups"
ENV_FILE="${ELESEND_ENV_FILE:-${REPO_ROOT}/.env.runtime}"
export COMPOSE_ENV_FILES="${ENV_FILE}"

# --- Rollback Command Line Argument Support ---
if [ "${1:-}" = "--rollback" ]; then
  echo "=========================================================="
  echo " Rollback flag detected. Executing deploy/runtime/rollback.sh"
  echo "=========================================================="
  shift
  if [ -f "${SCRIPT_DIR}/rollback.sh" ]; then
    exec "${BASH:-bash}" "${SCRIPT_DIR}/rollback.sh" "$@"
  elif [ -f "${REPO_ROOT}/deploy/runtime/rollback.sh" ]; then
    exec "${BASH:-bash}" "${REPO_ROOT}/deploy/runtime/rollback.sh" "$@"
  else
    exec deploy/runtime/rollback.sh "$@"
  fi
fi

echo "=========================================================="
echo " Starting ELESEND EGIA Runtime Staging Deployment"
echo "=========================================================="

# 1. System Resource Verification
if [ -f /proc/meminfo ] && command -v awk &>/dev/null; then
  TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
  TOTAL_MEM_MB=$((TOTAL_MEM_KB / 1024))
  echo "[1/6] Checking RAM: ${TOTAL_MEM_MB} MB available..."
else
  echo "[1/6] Checking RAM: /proc/meminfo not present; skipping host memory check..."
fi

if command -v df &> /dev/null && command -v awk &>/dev/null; then
  FREE_DISK_GB=$(df -BG / 2>/dev/null | awk 'NR==2 {gsub("G",""); print $4}' || echo "50")
  echo "[2/6] Checking Storage: ${FREE_DISK_GB} GB free..."
  if [ "${FREE_DISK_GB}" -lt 25 ]; then
    echo "ERROR: Insufficient disk space for geospatial indexing and logs (min 25 GB free required)."
    exit 1
  fi
else
  echo "[2/6] Checking Storage: df/awk not available; skipping..."
fi

# 2. Docker & Container Network Verification
echo "[3/6] Verifying Docker and Docker Compose..."
if ! command -v docker &> /dev/null; then
  echo "ERROR: docker command not found. Please install Docker Engine."
  exit 1
fi

# 3. Environment & Safe Staging Secret Generation
echo "[4/6] Checking Environment configuration & secrets..."
if [ ! -f "${ENV_FILE}" ]; then
  if [ -f "${SCRIPT_DIR}/.env.example" ]; then
    echo "Creating .env from ${SCRIPT_DIR}/.env.example..."
    cp "${SCRIPT_DIR}/.env.example" "${ENV_FILE}"
  elif [ -f "${REPO_ROOT}/deploy/runtime/.env.example" ]; then
    echo "Creating .env from deploy/runtime/.env.example..."
    cp "${REPO_ROOT}/deploy/runtime/.env.example" "${ENV_FILE}"
  else
    echo "ERROR: .env file missing and no example template found."
    exit 1
  fi
fi

generate_hex() {
  local num_bytes="$1"
  if command -v openssl &>/dev/null; then
    openssl rand -hex "$num_bytes"
  elif command -v node &>/dev/null; then
    node -e "console.log(require('crypto').randomBytes($num_bytes).toString('hex'))"
  elif [ -c /dev/urandom ] && command -v od &>/dev/null; then
    head -c "$num_bytes" /dev/urandom | od -An -tx1 | tr -d ' \n'
  else
    echo "ERROR: No cryptographic random source found." >&2
    exit 1
  fi
}

update_env_var() {
  local var_name="$1"
  local new_value="$2"
  local target_file="${3:-$ENV_FILE}"
  if grep -qE "^${var_name}=" "$target_file"; then
    sed "s|^${var_name}=.*|${var_name}=${new_value}|" "$target_file" > "${target_file}.tmp" && mv "${target_file}.tmp" "$target_file"
  else
    echo "${var_name}=${new_value}" >> "$target_file"
  fi
}

if grep -qE '^OTP_KEY=(.*REPLACE_WITH_.*|$)' "${ENV_FILE}" || ! grep -qE '^OTP_KEY=' "${ENV_FILE}"; then
  update_env_var "OTP_KEY" "$(generate_hex 32)" "${ENV_FILE}"
fi

if grep -qE '^ADMIN_MFA_ENCRYPTION_KEY=(.*REPLACE_WITH_.*|$)' "${ENV_FILE}" || ! grep -qE '^ADMIN_MFA_ENCRYPTION_KEY=' "${ENV_FILE}"; then
  update_env_var "ADMIN_MFA_ENCRYPTION_KEY" "$(generate_hex 32)" "${ENV_FILE}"
fi

if grep -qE '^JWT_SECRET=(.*REPLACE_WITH_.*|$)' "${ENV_FILE}" || ! grep -qE '^JWT_SECRET=' "${ENV_FILE}"; then
  update_env_var "JWT_SECRET" "$(generate_hex 16)" "${ENV_FILE}"
fi

if grep -qE '^ADMIN_MASTER_KEY=(.*REPLACE_WITH_.*|$)' "${ENV_FILE}" || ! grep -qE '^ADMIN_MASTER_KEY=' "${ENV_FILE}"; then
  update_env_var "ADMIN_MASTER_KEY" "$(generate_hex 16)" "${ENV_FILE}"
fi

if grep -qE '^AUDIT_LOG_SECRET=(.*REPLACE_WITH_.*|$)' "${ENV_FILE}" || ! grep -qE '^AUDIT_LOG_SECRET=' "${ENV_FILE}"; then
  update_env_var "AUDIT_LOG_SECRET" "$(generate_hex 16)" "${ENV_FILE}"
fi

if grep -qE '^POSTGRES_PASSWORD=(.*REPLACE_WITH_.*|$)' "${ENV_FILE}" || ! grep -qE '^POSTGRES_PASSWORD=' "${ENV_FILE}"; then
  NEW_PG_PASS="$(generate_hex 16)"
  update_env_var "POSTGRES_PASSWORD" "$NEW_PG_PASS" "${ENV_FILE}"
  if grep -q "URLENCODE_PASSWORD" "${ENV_FILE}"; then
    sed "s|URLENCODE_PASSWORD|${NEW_PG_PASS}|g" "${ENV_FILE}" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "${ENV_FILE}"
  fi
fi

export GEOGRAPHIC_INTELLIGENCE_ENABLED=true
export EGIA_LEARNING_CYCLE_ENABLED=true
export NODE_ENV=production

# 4. Pre-Deployment State Snapshot for Rollback Readiness
mkdir -p "${BACKUP_DIR}"
if docker compose -f "${COMPOSE_FILE}" ps db 2>/dev/null | grep -q "Up"; then
  echo "Creating pre-deployment database snapshot..."
  docker compose -f "${COMPOSE_FILE}" exec -T db pg_dump -U "${POSTGRES_USER:-elesend}" "${POSTGRES_DB:-elesend}" > "${BACKUP_DIR}/pre-deploy-snapshot.sql.tmp"
  test -s "${BACKUP_DIR}/pre-deploy-snapshot.sql.tmp"
  mv "${BACKUP_DIR}/pre-deploy-snapshot.sql.tmp" "${BACKUP_DIR}/pre-deploy-snapshot.sql"
fi
if docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -q '^elesend-api:latest$'; then
  docker tag elesend-api:latest elesend-api:previous 2>/dev/null || true
fi

# 5. Start / Reload Services via Docker Compose
echo "[5/6] Launching ELESEND Runtime Stack via Docker Compose..."
docker compose -f "${COMPOSE_FILE}" up -d --build --remove-orphans

# 6. Post-Launch Health Verification Loop
echo "[6/6] Verifying Runtime Stack Health (/health & /api/v1/admin/system-health)..."
HEALTH_TIMEOUT=60
START_TIME=$(date +%s)
HEALTH_VERIFIED=false

while true; do
  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))
  if [ "$ELAPSED" -ge "$HEALTH_TIMEOUT" ]; then
    break
  fi

  if docker compose -f "${COMPOSE_FILE}" exec -T api node -e '
    import pg from "pg";
    import crypto from "crypto";

    const port = process.env.PORT || "3090";
    const adminHost = (process.env.ADMIN_HOST || "admin.elesend.local").split(":")[0];

    const healthRes = await fetch("http://127.0.0.1:" + port + "/health");
    if (!healthRes.ok) throw new Error("Health check returned status " + healthRes.status);
    const healthJson = await healthRes.json();
    if (healthJson.status !== "alive") throw new Error("Health status not alive: " + JSON.stringify(healthJson));

    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const sfx = String(Math.floor(100000 + Math.random() * 899999));
    const adminId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    try {
      await pool.query(
        "INSERT INTO users(id, phone, password_hash, kind, phone_verified_at) VALUES ($1, $2, '\''dummy_hash'\'', '\''admin'\'', now())",
        [adminId, "+233250" + sfx]
      );
      await pool.query(
        "INSERT INTO sessions(token_hash, user_id, expires_at, admin_mfa_verified) VALUES ($1, $2, now() + interval '\''5 minutes'\'', true)",
        [tokenHash, adminId]
      );

      const adminRes = await fetch("http://127.0.0.1:" + port + "/api/v1/admin/system-health", {
        headers: {
          "Authorization": "Bearer " + token,
          "Host": adminHost
        }
      });

      if (!adminRes.ok) throw new Error("Admin system-health returned " + adminRes.status);
      const data = await adminRes.json();
      if (!["HEALTHY", "WARNING"].includes(data.status)) throw new Error("Unhealthy status: " + data.status);
      if (!data.memory || !data.eventLoop || !data.database?.pool || !("cache" in data)) {
        throw new Error("System health payload missing required fields");
      }
    } finally {
      await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id = $1", [adminId]).catch(() => {});
      await pool.end().catch(() => {});
    }
  ' 2>/dev/null; then
    HEALTH_VERIFIED=true
    break
  fi

  echo "Waiting for runtime services to become healthy (${ELAPSED}s / ${HEALTH_TIMEOUT}s)..."
  sleep 3
done

if [ "$HEALTH_VERIFIED" != "true" ]; then
  echo "=========================================================="
  echo " ERROR: Health verification failed or timed out after ${HEALTH_TIMEOUT}s!"
  echo " Automatically invoking rollback..."
  echo "=========================================================="
  if [ -f "${SCRIPT_DIR}/rollback.sh" ]; then
    "${BASH:-bash}" "${SCRIPT_DIR}/rollback.sh"
  else
    deploy/runtime/rollback.sh
  fi
  exit 1
fi

echo "Pre-warming PostgreSQL Geospatial Indexes..."
docker compose -f "${COMPOSE_FILE}" exec -T db psql -U "${POSTGRES_USER:-elesend}" -d "${POSTGRES_DB:-elesend}" -c "
  VACUUM ANALYZE spatial_landmarks;
  VACUUM ANALYZE national_businesses;
  VACUUM ANALYZE candidate_roads;
  VACUUM ANALYZE candidate_landmarks;
  VACUUM ANALYZE rider_map_reports;
" 2>/dev/null || true

echo "=========================================================="
echo " ELESEND EGIA Runtime Stack Deployed Successfully"
echo " Monitoring command: docker compose -f deploy/runtime/compose.yaml logs -f"
echo " Rollback command:   deploy/runtime/stage-egia.sh --rollback"
echo "=========================================================="
