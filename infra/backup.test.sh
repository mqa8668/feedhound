#!/usr/bin/env bash
# infra/backup.test.sh — exercises infra/backup.sh against a real local
# Postgres container (no bats; not installed in this environment) with a
# `docker` PATH shim that maps `docker compose -p feedhound exec -T postgres ...`
# onto `docker exec -i <container>`, and `BACKUP_DIR` pointed at a temp dir.
# Never touches ports 5432/5173 or any other running container.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SH="${SCRIPT_DIR}/backup.sh"
PG_BIN_DIR="/opt/homebrew/opt/libpq/bin"
export PATH="${PG_BIN_DIR}:${PATH}"

FAIL_COUNT=0
assert() {
  local desc="$1" cond="$2"
  if [[ "$cond" -eq 0 ]]; then
    echo "ok - $desc"
  else
    echo "not ok - $desc"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

REAL_DOCKER_BIN="$(command -v docker)"
CONTAINER_NAME="feedhound-backup-test-$$"
BACKUP_DIR="$(mktemp -d)"
SHIM_DIR="$(mktemp -d)"

cleanup() {
  "$REAL_DOCKER_BIN" rm -f -v "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -rf "$BACKUP_DIR" "$SHIM_DIR"
}
trap cleanup EXIT

echo "starting local postgres container ${CONTAINER_NAME}"
"$REAL_DOCKER_BIN" run -d --name "$CONTAINER_NAME" \
  -e POSTGRES_USER=feedhound -e POSTGRES_PASSWORD=test -e POSTGRES_DB=feedhound \
  postgres:16 >/dev/null

for _ in $(seq 1 60); do
  if "$REAL_DOCKER_BIN" exec "$CONTAINER_NAME" pg_isready -U feedhound >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

cat >"${SHIM_DIR}/docker" <<EOF
#!/usr/bin/env bash
REAL_DOCKER_BIN="${REAL_DOCKER_BIN}"
CONTAINER_NAME="${CONTAINER_NAME}"
if [[ "\$1" == "compose" ]]; then
  shift
  [[ "\$1" == "-p" ]] && shift && shift
  if [[ "\$1" == "exec" ]]; then
    shift
    [[ "\$1" == "-T" ]] && shift
    shift # service name (e.g. postgres), positional
    exec "\$REAL_DOCKER_BIN" exec -i "\$CONTAINER_NAME" "\$@"
  fi
  if [[ "\$1" == "ps" || "\$1" == "stop" || "\$1" == "start" ]]; then
    exit 0
  fi
fi
exec "\$REAL_DOCKER_BIN" "\$@"
EOF
chmod +x "${SHIM_DIR}/docker"

echo "running backup.sh"
BACKUP_DIR="$BACKUP_DIR" PATH="${SHIM_DIR}:${PATH}" bash "$BACKUP_SH"
status=$?
assert "backup.sh exits 0" "$status"

DUMP_FILE="$(find "$BACKUP_DIR" -maxdepth 1 -name 'feedhound-*.dump' ! -name 'feedhound-latest.dump' | head -n1)"
dump_exists=1
[[ -n "$DUMP_FILE" ]] && dump_exists=0
assert "dump file was created" "$dump_exists"

sha_exists=1
[[ -f "${DUMP_FILE}.sha256" ]] && sha_exists=0
assert "sha256 file was created" "$sha_exists"

(cd "$BACKUP_DIR" && sha256sum -c "$(basename "$DUMP_FILE").sha256" >/dev/null 2>&1)
assert "checksum verifies" "$?"

symlink_ok=1
[[ "$(readlink "${BACKUP_DIR}/feedhound-latest.dump")" == "$(basename "$DUMP_FILE")" ]] && symlink_ok=0
assert "feedhound-latest.dump symlink points at the dump" "$symlink_ok"

pg_restore --list "$DUMP_FILE" >/dev/null 2>&1
assert "pg_restore --list succeeds on the dump" "$?"

echo "----"
if [[ "$FAIL_COUNT" -eq 0 ]]; then
  echo "all backup.test.sh checks passed"
  exit 0
else
  echo "$FAIL_COUNT backup.test.sh check(s) failed"
  exit 1
fi
