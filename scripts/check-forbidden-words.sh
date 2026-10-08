#!/usr/bin/env bash
# Fails when the tree contains vocabulary that must never ship: third-party social-network
# scraping terms and private hosts, names or paths. Terms are assembled from fragments so this
# file does not match its own patterns.
set -uo pipefail
cd "$(dirname "$0")/.."

fragments=(
  "face""book"
  "\\bf""b\\b"
  "f""bcdn"
  "graph""ql"
  "check""point"
  "\\bco""met\\b"
  "anh""_bm"
  "anh""-bm"
  "192""\\.168"
  "for""gio"
  "north""star"
  "rv""gvn"
  "9""router"
  "cho""tot"
  "cho""-tot"
  "ch""ợ tốt"
  "/Us""ers/"
  "loc""lq"
  "vin""css"
)
pattern="$(IFS='|'; echo "${fragments[*]}")"

hits="$(grep -rniIE "$pattern" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude=bun.lock . || true)"
if [[ -n "$hits" ]]; then
  echo "forbidden vocabulary found:" >&2
  echo "$hits" | head -50 >&2
  exit 1
fi
echo "forbidden-words: clean"
