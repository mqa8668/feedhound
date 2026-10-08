#!/usr/bin/env bash
# infra/smoke.sh — post-deploy smoke checks.
# Run by hand or by CI after a deploy.
#
# Usage: infra/smoke.sh [--host localhost] [--public [--domain <hostname>]]
#
# Always: the local api answers /healthz. With --public (a tunnel deploy), the
# whole hostname must sit behind Cloudflare Access: `https://<domain>/` and
# `https://<domain>/api/health` must both answer 302 to a *.cloudflareaccess.com
# login. A 2xx or 401 straight from the app (no Access login) is a failure.
# --domain defaults to $PUBLIC_HOSTNAME from the environment (no hardcoded host).
set -euo pipefail

HOST="localhost"
DOMAIN="${PUBLIC_HOSTNAME:-}"
PUBLIC=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --public) PUBLIC=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

log() { echo "[smoke] $*" >&2; }

run() {
  if [[ "$HOST" == "localhost" || "$HOST" == "127.0.0.1" ]]; then
    bash -c "$1"
  else
    ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "$1"
  fi
}

fail=0

log "checking local api healthz"
if ! run "curl -sf http://127.0.0.1:4820/healthz >/dev/null"; then
  log "FAIL: 127.0.0.1:4820/healthz not reachable"
  fail=1
fi

# One path must answer 302 to cloudflareaccess.com.
check_access_redirect() {
  local path="$1" headers status location
  headers="$(curl -sI "https://${DOMAIN}${path}" 2>/dev/null | tr -d '\r' || true)"
  status="$(head -n1 <<<"$headers" | awk '{print $2}')"
  location="$(grep -i '^location:' <<<"$headers" | awk '{print $2}' | tr -d '\r' || true)"
  if [[ "$status" != "302" || ! "$location" =~ ^https://[^/]+\.cloudflareaccess\.com/ ]]; then
    log "FAIL: ${path} expected 302 to cloudflareaccess.com, got status=${status:-none} location=${location:-none}"
    fail=1
  fi
}

if [[ "$PUBLIC" -eq 1 ]]; then
  if [[ -z "$DOMAIN" ]]; then
    log "FAIL: --public needs --domain or PUBLIC_HOSTNAME"
    exit 1
  fi
  log "checking https://${DOMAIN}/ redirects to Cloudflare Access"
  check_access_redirect "/"
  log "checking https://${DOMAIN}/api/health redirects to Cloudflare Access (no bypass app)"
  check_access_redirect "/api/health"
fi

if [[ $fail -ne 0 ]]; then
  exit 1
fi

log "smoke checks passed"
exit 0
