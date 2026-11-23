#!/usr/bin/env bash
# [B12] รัน Playwright ชุดเต็ม 51 TC ทีละ BUG_MODE (restart เว็บทุกครั้งด้วย TEST_MODE=1 BUG_MODE=<รหัส>)
#   ./e2e/run-matrix.sh "" "" B01 B02 ... "B03,B07" ""     ("" = เว็บถูกต้อง)
#   WEB=docker (ค่าเริ่ม) = docker compose · WEB=node = node server.js ตรง ๆ (เครื่องที่ไม่มี Docker)
#   ผล: e2e/results/bug-<tag>.json (รอบที่ซ้ำ tag เดิมได้ -2 -3 ต่อท้าย) + e2e/results/matrix.log
set -u
APP="$(cd "$(dirname "$0")/.." && pwd)"; E2E="$APP/e2e"; PORT="${PORT:-3912}"; PROJ="${PROJ:-b12}"; WEB="${WEB:-docker}"
DATA="$E2E/.data"; mkdir -p "$E2E/results" "$DATA"
PID=""
stop_web() {
  if [ "$WEB" = node ]; then
    [ -n "$PID" ] && kill "$PID" 2>/dev/null && wait "$PID" 2>/dev/null; PID=""
  else
    ( cd "$APP" && PORT="$PORT" docker compose -f docker-compose.yml -f e2e/compose.e2e.yml -p "$PROJ" down >/dev/null 2>&1 )
  fi
}
start_web() {
  if [ "$WEB" = node ]; then
    ( cd "$APP" && TEST_MODE=1 BUG_MODE="$1" PORT="$PORT" DB_PATH="$DATA/egov.db" exec node --no-warnings=ExperimentalWarning server.js >"$E2E/results/web.log" 2>&1 ) &
    PID=$!
  else
    ( cd "$APP" && TEST_MODE=1 BUG_MODE="$1" PORT="$PORT" docker compose -f docker-compose.yml -f e2e/compose.e2e.yml -p "$PROJ" up -d --build >/dev/null 2>&1 )
  fi
  for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && return 0; sleep 1; done
  echo "!! เว็บไม่ขึ้น BUG_MODE=[$1]" >> "$E2E/results/matrix.log"; return 1
}
trap stop_web EXIT
for MODE in "$@"; do
  TAG="${MODE:-none}"; TAG="${TAG//,/_}"
  N=1; OUT="$E2E/results/bug-$TAG.json"; while [ -e "$OUT" ]; do N=$((N+1)); OUT="$E2E/results/bug-$TAG-$N.json"; done
  stop_web; start_web "$MODE" || continue
  ACTIVE="$(curl -s "http://127.0.0.1:$PORT/api/test/bugs")"
  START=$(date +%s)
  ( cd "$E2E" && DB_PATH="$DATA/egov.db" BASE_URL="http://127.0.0.1:$PORT" npx playwright test --reporter=json --output="results/out-$TAG" > "$OUT" 2>/dev/null )
  echo "== BUG_MODE=[$MODE] active=$ACTIVE $(( $(date +%s)-START ))s → $(basename "$OUT")" >> "$E2E/results/matrix.log"
  node "$E2E/summarize.js" "$OUT" 4 | grep -v '^PASS' >> "$E2E/results/matrix.log"
done
stop_web
echo DONE >> "$E2E/results/matrix.log"
