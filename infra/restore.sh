#!/usr/bin/env bash
# infra/restore.sh — restore a pg_dump into a scratch DB, optionally swap it in
#.
#
# Usage: infra/restore.sh <dump path|latest> [--target-db feedhound_restore] [--swap] [--yes]
# Env overrides (used by infra/restore.test.sh):
#   BACKUP_DIR       defaults to /backups
#   COMPOSE_PROJECT  defaults to feedhound
#
# Exit codes: 0 ok · 20 dump missing/checksum mismatch · 21 pg_restore error ·
#             22 swap aborted (rename failed, rolled back where possible) ·
#             23 post-swap smoke failed (swap already happened; see the
#             printed rollback command)
set -uo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-feedhound}"
TARGET_DB="feedhound_restore"
SWAP=0
YES=0
DUMP_ARG=""
TARGET_DB_RE='^[a-z_][a-z0-9_]*$'

log() { echo "[restore] $*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-db) TARGET_DB="$2"; shift 2 ;;
    --swap) SWAP=1; shift ;;
    --yes) YES=1; shift ;;
    -*) echo "unknown argument: $1" >&2; exit 1 ;;
    *) DUMP_ARG="$1"; shift ;;
  esac
done

if [[ -z "$DUMP_ARG" ]]; then
  echo "usage: $0 <dump path|latest> [--target-db name] [--swap] [--yes]" >&2
  exit 1
fi

# --target-db must be a safe, quotable Postgres identifier and must never be
# "feedhound" itself: pg_restore --clean --if-exists below drops objects in the
# target database, so a restore into "feedhound" (or an unsanitized name) would be
# destructive/injectable.
if [[ ! "$TARGET_DB" =~ $TARGET_DB_RE ]]; then
  log "FAIL: --target-db '$TARGET_DB' is invalid (must match $TARGET_DB_RE)"
  exit 1
fi
if [[ "$TARGET_DB" == "feedhound" ]]; then
  log "FAIL: --target-db must not be 'feedhound' (refusing to restore/clean the live database)"
  exit 1
fi

# Any restore that can drop/clean a database (every restore here, via
# pg_restore --clean --if-exists, plus --swap's renames) requires --yes.
if [[ "$YES" -ne 1 ]]; then
  log "FAIL: this restore drops/cleans database '${TARGET_DB}' (pg_restore --clean); pass --yes to confirm"
  exit 22
fi

if [[ "$DUMP_ARG" == "latest" ]]; then
  DUMP_PATH="${BACKUP_DIR}/feedhound-latest.dump"
  # resolve the symlink so the .sha256 lookup below matches the real file name
  if [[ -L "$DUMP_PATH" ]]; then
    DUMP_PATH="${BACKUP_DIR}/$(readlink "$DUMP_PATH")"
  fi
else
  DUMP_PATH="$DUMP_ARG"
fi

if [[ ! -f "$DUMP_PATH" ]]; then
  log "FAIL: dump not found: $DUMP_PATH"
  exit 20
fi

SHA_PATH="${DUMP_PATH}.sha256"
if [[ ! -f "$SHA_PATH" ]]; then
  log "FAIL: checksum file not found: $SHA_PATH"
  exit 20
fi

log "verifying checksum for $(basename "$DUMP_PATH")"
if ! (cd "$(dirname "$DUMP_PATH")" && sha256sum -c "$(basename "$SHA_PATH")" >/dev/null 2>&1); then
  log "FAIL: checksum mismatch for $DUMP_PATH"
  exit 20
fi

log "restoring $(basename "$DUMP_PATH") into database ${TARGET_DB}"
if ! docker compose -p "$COMPOSE_PROJECT" exec -T postgres \
  psql -U feedhound -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${TARGET_DB}'" | grep -q 1; then
  docker compose -p "$COMPOSE_PROJECT" exec -T postgres createdb -U feedhound "$TARGET_DB" || {
    log "FAIL: could not create database ${TARGET_DB}"
    exit 21
  }
fi

if ! docker compose -p "$COMPOSE_PROJECT" exec -T postgres pg_restore -U feedhound -d "$TARGET_DB" --clean --if-exists <"$DUMP_PATH"; then
  log "FAIL: pg_restore reported an error"
  exit 21
fi
log "OK: restored into ${TARGET_DB}"

if [[ "$SWAP" -eq 0 ]]; then
  exit 0
fi

# --yes is already required above (any restore drops/cleans TARGET_DB); the
# swap additionally renames the live "feedhound" database, so it is gated on the
# same flag, not a separate check.

TS="$(date -u +%Y%m%d-%H%M%S)"
PREV_DB="feedhound_prev_${TS}"
log "stopping api agent bot web for swap"
docker compose -p "$COMPOSE_PROJECT" stop api agent bot web || { log "FAIL: could not stop app services"; exit 22; }

# A client connected straight to the published port (a local dev shell, say) can
# hold an open session on "feedhound" and block ALTER DATABASE RENAME. Terminate
# any remaining backends first.
docker compose -p "$COMPOSE_PROJECT" exec -T postgres psql -U feedhound -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'feedhound' AND pid <> pg_backend_pid();" || true

log "swapping feedhound -> ${PREV_DB}, ${TARGET_DB} -> feedhound"
if ! docker compose -p "$COMPOSE_PROJECT" exec -T postgres psql -U feedhound -d postgres -c \
  "ALTER DATABASE \"feedhound\" RENAME TO \"${PREV_DB}\";"; then
  log "FAIL: could not rename feedhound"
  docker compose -p "$COMPOSE_PROJECT" start api agent bot web || true
  exit 22
fi
if ! docker compose -p "$COMPOSE_PROJECT" exec -T postgres psql -U feedhound -d postgres -c \
  "ALTER DATABASE \"${TARGET_DB}\" RENAME TO \"feedhound\";"; then
  log "FAIL: could not rename ${TARGET_DB}; rolling back rename"
  docker compose -p "$COMPOSE_PROJECT" exec -T postgres psql -U feedhound -d postgres -c \
    "ALTER DATABASE \"${PREV_DB}\" RENAME TO \"feedhound\";" || true
  docker compose -p "$COMPOSE_PROJECT" start api agent bot web || true
  exit 22
fi

log "restarting api agent bot web"
docker compose -p "$COMPOSE_PROJECT" start api agent bot web

SMOKE_SCRIPT="$(dirname "$0")/smoke.sh"
if [[ ! -f "$SMOKE_SCRIPT" ]]; then
  log "FAIL: post-swap smoke script not found: ${SMOKE_SCRIPT}; the swap already happened (feedhound is now ${TARGET_DB}'s data, previous kept as ${PREV_DB})"
  log "rollback: docker compose -p ${COMPOSE_PROJECT} exec -T postgres psql -U feedhound -d postgres -c 'ALTER DATABASE \"feedhound\" RENAME TO \"${TARGET_DB}\"; ALTER DATABASE \"${PREV_DB}\" RENAME TO \"feedhound\";' && docker compose -p ${COMPOSE_PROJECT} restart api agent bot web"
  exit 23
fi
log "re-running deploy smoke after swap"
if ! bash "$SMOKE_SCRIPT" --host localhost; then
  log "FAIL: post-swap smoke failed; the swap already happened (feedhound is now ${TARGET_DB}'s data, previous kept as ${PREV_DB})"
  log "rollback: docker compose -p ${COMPOSE_PROJECT} exec -T postgres psql -U feedhound -d postgres -c 'ALTER DATABASE \"feedhound\" RENAME TO \"${TARGET_DB}\"; ALTER DATABASE \"${PREV_DB}\" RENAME TO \"feedhound\";' && docker compose -p ${COMPOSE_PROJECT} restart api agent bot web"
  exit 23
fi

log "OK: swap complete, previous database kept as ${PREV_DB}"
exit 0
