#!/usr/bin/env bash
# Shared by the ELESEND backup scripts. Settings come from /etc/elesend/backup.env (see backup.env.example).
set -euo pipefail
: "${ELESEND_ENV_FILE:=.env.runtime}"
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

dc() { docker compose -f deploy/runtime/compose.yaml --env-file "$ELESEND_ENV_FILE" "$@"; }

require_offsite() {
  : "${OFFSITE_RCLONE_REMOTE:?Set OFFSITE_RCLONE_REMOTE to an rclone destination on another provider}"
  : "${GPG_PASSPHRASE_FILE:?Set GPG_PASSPHRASE_FILE to a root-only passphrase file}"
  [[ -f "$GPG_PASSPHRASE_FILE" ]] || { echo 'Missing encryption passphrase file' >&2; exit 1; }
  local mode; mode=$(stat -c '%a' "$GPG_PASSPHRASE_FILE" 2>/dev/null || stat -f '%A' "$GPG_PASSPHRASE_FILE")
  [[ "$mode" =~ ^[46]00$ ]] || { echo 'Passphrase file must have 0600 or 0400 permissions' >&2; exit 1; }
  OFFSITE="${OFFSITE_RCLONE_REMOTE%/}"
}

encrypt_to() { gpg --batch --yes --pinentry-mode loopback --symmetric --cipher-algo AES256 --passphrase-file "$GPG_PASSPHRASE_FILE" --output "$1"; }
decrypt_from() { gpg --batch --yes --pinentry-mode loopback --decrypt --passphrase-file "$GPG_PASSPHRASE_FILE" "$1"; }

# Uploads a file and confirms the copy offsite has the same size before anything local is removed.
upload_verified() {
  local file="$1" dest="$2"
  rclone copyto "$file" "$dest"
  local remote_size; remote_size=$(rclone size --json "$dest" | sed -E 's/.*"bytes":([0-9]+).*/\1/')
  [[ "$remote_size" == "$(stat -c '%s' "$file")" ]] || { echo "Upload of $(basename "$file") did not verify" >&2; exit 1; }
}

# A "dead man's switch": the monitoring service (for example healthchecks.io) alerts when a ping does not arrive on
# time, which catches a backup that has silently stopped running, not just one that fails loudly.
heartbeat() {
  local url="${1:-}" state="${2:-}"
  [[ -n "$url" ]] || return 0
  curl -fsS -m 10 --retry 3 "${url%/}${state:+/$state}" >/dev/null || echo "Could not reach the monitoring URL" >&2
}
