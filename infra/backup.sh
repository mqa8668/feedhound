#!/usr/bin/env bash
# infra/backup.sh — nightly pg_dump (R2 offsite copy).
#
# Usage: infra/backup.sh
# Env overrides (used by infra/backup.test.sh):
#   BACKUP_DIR         defaults to /backups
#   COMPOSE_PROJECT     defaults to feedhound
#   OPS_NOTIFY_URL       e.g. http://127.0.0.1:4820/api/ops/notify (optional)
#   OPS_API_KEY          bearer key with scope "ops" (optional, needed to notify)
#   R2_BUCKET / R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (P2, optional)
set -uo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-feedhound}"
LOG_FILE="${BACKUP_DIR}/backup.log"
MIN_FREE_GB="${MIN_FREE_GB:-2}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

log() {
  local line
  line="$(date -u +%FT%TZ) $*"
  echo "$line" >>"$LOG_FILE" 2>/dev/null || echo "$line" >&2
  echo "$line" >&2
}

notify_failure() {
  local message="$1"
  if [[ -n "${OPS_NOTIFY_URL:-}" && -n "${OPS_API_KEY:-}" ]]; then
    curl -sf -X POST "$OPS_NOTIFY_URL" \
      -H "Authorization: Bearer ${OPS_API_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"rule\":\"backup_failed\",\"message\":$(printf '%s' "$message" | sed 's/"/\\"/g' | sed 's/^/"/;s/$/"/')}" \
      >/dev/null 2>&1 || true
  fi
}

mkdir -p "$BACKUP_DIR"

# free space check (>= MIN_FREE_GB)
FREE_KB="$(df -Pk "$BACKUP_DIR" | tail -1 | awk '{print $4}')"
FREE_GB=$((FREE_KB / 1024 / 1024))
if [[ "$FREE_GB" -lt "$MIN_FREE_GB" ]]; then
  log "FAIL: ${BACKUP_DIR} has ${FREE_GB}GB free, below ${MIN_FREE_GB}GB minimum"
  notify_failure "backup skipped: ${BACKUP_DIR} free space ${FREE_GB}GB < ${MIN_FREE_GB}GB"
  exit 1
fi

TS="$(date -u +%Y%m%d-%H%M%S)"
DUMP_NAME="feedhound-${TS}.dump"
DUMP_PATH="${BACKUP_DIR}/${DUMP_NAME}"
TMP_PATH="${DUMP_PATH}.tmp"

log "starting pg_dump -> ${DUMP_PATH}"
if ! docker compose -p "$COMPOSE_PROJECT" exec -T postgres pg_dump -U feedhound -Fc feedhound >"$TMP_PATH" 2>>"$LOG_FILE"; then
  log "FAIL: pg_dump exited non-zero"
  rm -f "$TMP_PATH"
  notify_failure "pg_dump failed for feedhound at ${TS}"
  exit 1
fi
mv "$TMP_PATH" "$DUMP_PATH"

if ! (cd "$BACKUP_DIR" && sha256sum "$DUMP_NAME" >"${DUMP_NAME}.sha256" 2>>"$LOG_FILE"); then
  log "FAIL: checksum write failed for ${DUMP_NAME}"
  notify_failure "checksum write failed for ${DUMP_NAME}"
  exit 1
fi

ln -sf "$DUMP_NAME" "${BACKUP_DIR}/feedhound-latest.dump"
log "OK: ${DUMP_PATH} written, checksum recorded, feedhound-latest.dump updated"

# Offsite copy to R2, prune only after a successful upload.
if [[ -n "${R2_BUCKET:-}" ]] && command -v rclone >/dev/null 2>&1; then
  log "uploading ${DUMP_NAME} to r2:${R2_BUCKET}/feedhound/"
  if rclone copy "$DUMP_PATH" "r2:${R2_BUCKET}/feedhound/" >>"$LOG_FILE" 2>&1 \
    && rclone copy "${DUMP_PATH}.sha256" "r2:${R2_BUCKET}/feedhound/" >>"$LOG_FILE" 2>&1; then
    log "OK: uploaded ${DUMP_NAME} to R2"
    find "$BACKUP_DIR" -maxdepth 1 -name 'feedhound-*.dump*' -mtime "+${RETENTION_DAYS}" -delete
    rclone delete --min-age "${RETENTION_DAYS}d" "r2:${R2_BUCKET}/feedhound/" >>"$LOG_FILE" 2>&1 || true
  else
    log "FAIL: R2 upload failed for ${DUMP_NAME}; local prune skipped"
    notify_failure "R2 upload failed for ${DUMP_NAME}"
  fi
else
  find "$BACKUP_DIR" -maxdepth 1 -name 'feedhound-*.dump*' -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null || true
fi

exit 0
