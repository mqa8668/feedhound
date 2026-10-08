#!/usr/bin/env bash
# infra/restore.test.sh — exercises infra/restore.sh against a real local
# Postgres container (no bats). Covers: `restore.sh latest` restores
# `feedhound_restore` with the same `post` row count, `feedhound` is untouched, exit 0;
# a tampered `.sha256` yields exit 20 and no restore.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SH="${SCRIPT_DIR}/backup.sh"
RESTORE_SH="${SCRIPT_DIR}/restore.sh"
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
CONTAINER_NAME="feedhound-restore-test-$$"
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

"$REAL_DOCKER_BIN" exec "$CONTAINER_NAME" psql -U feedhound -d feedhound -c \
  "CREATE TABLE post (id serial primary key, text text); INSERT INTO post (text) VALUES ('a'), ('b'), ('c');" >/dev/null

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

echo "seeding a backup via backup.sh"
BACKUP_DIR="$BACKUP_DIR" PATH="${SHIM_DIR}:${PATH}" bash "$BACKUP_SH" >/dev/null

echo "running restore.sh latest"
BACKUP_DIR="$BACKUP_DIR" PATH="${SHIM_DIR}:${PATH}" bash "$RESTORE_SH" latest --target-db feedhound_restore --yes >/tmp/restore-ac8.out 2>&1
status=$?
assert "restore.sh latest exits 0" "$status"

RESTORE_COUNT="$("$REAL_DOCKER_BIN" exec "$CONTAINER_NAME" psql -U feedhound -d feedhound_restore -tAc 'select count(*) from post' | tr -d '[:space:]')"
restore_count_ok=1
[[ "$RESTORE_COUNT" == "3" ]] && restore_count_ok=0
assert "feedhound_restore.post has the same row count (3) as feedhound.post" "$restore_count_ok"

HUNT_COUNT="$("$REAL_DOCKER_BIN" exec "$CONTAINER_NAME" psql -U feedhound -d feedhound -tAc 'select count(*) from post' | tr -d '[:space:]')"
feedhound_count_ok=1
[[ "$HUNT_COUNT" == "3" ]] && feedhound_count_ok=0
assert "feedhound.post is unchanged (3 rows)" "$feedhound_count_ok"

echo "--swap with no smoke.sh next to restore.sh -> exit 23 (never silently skipped)"
NO_SMOKE_DIR="$(mktemp -d)"
cp "$RESTORE_SH" "${NO_SMOKE_DIR}/restore.sh"
BACKUP_DIR="$BACKUP_DIR" PATH="${SHIM_DIR}:${PATH}" bash "${NO_SMOKE_DIR}/restore.sh" latest \
  --target-db feedhound_swaptest --swap --yes >/tmp/restore-no-smoke.out 2>&1
no_smoke_status=$?
rm -rf "$NO_SMOKE_DIR"
no_smoke_ok=1
[[ "$no_smoke_status" -eq 23 ]] && no_smoke_ok=0
assert "MED-5: missing smoke.sh -> exit 23" "$no_smoke_ok"
no_smoke_msg_ok=1
grep -q "smoke script not found" /tmp/restore-no-smoke.out && no_smoke_msg_ok=0
assert "MED-5: missing smoke.sh message names the missing script" "$no_smoke_msg_ok"

echo "tampering with the .sha256 file"
DUMP_FILE="$(find "$BACKUP_DIR" -maxdepth 1 -name 'feedhound-*.dump' ! -name 'feedhound-latest.dump' | head -n1)"
echo "0000000000000000000000000000000000000000000000000000000000000000  $(basename "$DUMP_FILE")" >"${DUMP_FILE}.sha256"

"$REAL_DOCKER_BIN" exec "$CONTAINER_NAME" psql -U feedhound -d postgres -c "DROP DATABASE IF EXISTS feedhound_restore2;" >/dev/null

BACKUP_DIR="$BACKUP_DIR" PATH="${SHIM_DIR}:${PATH}" bash "$RESTORE_SH" latest --target-db feedhound_restore2 --yes >/tmp/restore-tamper.out 2>&1
tamper_status=$?
tamper_ok=1
[[ "$tamper_status" == "20" ]] && tamper_ok=0
assert "tampered checksum -> exit 20" "$tamper_ok"

DB_EXISTS="$("$REAL_DOCKER_BIN" exec "$CONTAINER_NAME" psql -U feedhound -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = 'feedhound_restore2'" | tr -d '[:space:]')"
assert "no restore occurred for tampered checksum" "$([[ -z "$DB_EXISTS" ]]; echo $?)"

echo "finding-6: --target-db feedhound is rejected"
BACKUP_DIR="$BACKUP_DIR" PATH="${SHIM_DIR}:${PATH}" bash "$RESTORE_SH" latest --target-db feedhound --yes >/tmp/restore-target-feedhound.out 2>&1
target_feedhound_status=$?
target_feedhound_ok=1
[[ "$target_feedhound_status" -eq 1 ]] && target_feedhound_ok=0
assert "finding-6: --target-db feedhound is rejected (exit 1)" "$target_feedhound_ok"

echo "finding-6: malicious --target-db is rejected"
BACKUP_DIR="$BACKUP_DIR" PATH="${SHIM_DIR}:${PATH}" bash "$RESTORE_SH" latest --target-db 'feedhound_restore; DROP DATABASE feedhound' --yes >/tmp/restore-target-malicious.out 2>&1
target_malicious_status=$?
target_malicious_ok=1
[[ "$target_malicious_status" -eq 1 ]] && target_malicious_ok=0
assert "finding-6: malicious --target-db is rejected (exit 1)" "$target_malicious_ok"

echo "finding-6: restore without --yes is refused"
BACKUP_DIR="$BACKUP_DIR" PATH="${SHIM_DIR}:${PATH}" bash "$RESTORE_SH" latest --target-db feedhound_restore3 >/tmp/restore-no-yes.out 2>&1
no_yes_status=$?
no_yes_ok=1
[[ "$no_yes_status" -eq 22 ]] && no_yes_ok=0
assert "finding-6: restore without --yes exits 22" "$no_yes_ok"
db_exists_no_yes="$("$REAL_DOCKER_BIN" exec "$CONTAINER_NAME" psql -U feedhound -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = 'feedhound_restore3'" | tr -d '[:space:]')"
assert "finding-6: no restore occurred without --yes" "$([[ -z "$db_exists_no_yes" ]]; echo $?)"

echo "----"
if [[ "$FAIL_COUNT" -eq 0 ]]; then
  echo "all restore.test.sh checks passed"
  exit 0
else
  echo "$FAIL_COUNT restore.test.sh check(s) failed"
  exit 1
fi
