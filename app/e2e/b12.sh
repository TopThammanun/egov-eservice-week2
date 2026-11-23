#!/usr/bin/env bash
# ขั้นรวมของบล็อก B12 แบบคำสั่งเดียว (ทำซ้ำได้): build เว็บ → ชุดเต็ม 51 TC ทุก BUG_MODE → ตาราง BUGS.md §4
#   bash app/e2e/b12.sh             WEB=docker (ค่าเริ่ม) · WEB=node bash app/e2e/b12.sh ถ้าไม่มี Docker
#   bash app/e2e/b12.sh "" B01      ลองเฉพาะบางโหมด (รหัสออกจะไม่เป็น 0 เพราะตารางไม่ครบ)
# ออกด้วยรหัส 0 เมื่อ: ไม่เปิดบั๊กผ่าน 51/51 ทั้ง 3 รอบ · ทุกบั๊กล้มเฉพาะ TC ในรายการของ BUGS.md · บั๊กรวมล้มเท่ากับ union
set -u
APP="$(cd "$(dirname "$0")/.." && pwd)"; E2E="$APP/e2e"; WEB="${WEB:-docker}"
mkdir -p "$E2E/results"
if ls "$E2E/results"/bug-*.json >/dev/null 2>&1 || [ -e "$E2E/results/matrix.log" ]; then   # เก็บผลรอบก่อนไว้ ไม่ให้ปนกับรอบนี้
  PREV="$E2E/results/prev-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$PREV"; mv "$E2E/results"/bug-*.json "$E2E/results/matrix.log" "$PREV/" 2>/dev/null
fi
[ -d "$E2E/node_modules" ] || ( cd "$E2E" && npm ci && npx playwright install chromium ) || exit 2
if [ "$WEB" = docker ]; then ( cd "$APP" && docker compose build ) || exit 2
else [ -d "$APP/node_modules" ] || ( cd "$APP" && npm ci ) || exit 2; fi
[ $# -gt 0 ] || set -- "" "" B01 B02 B03 B04 B05 B06 B07 B08 B09 B10 B11 B12 "B03,B07" "B01,B05,B09" ""   # ค่าเริ่ม = ครบ 17 รอบ (ระบุโหมดเองได้เพื่อลองสั้น ๆ)
START=$(date +%s)
WEB="$WEB" bash "$E2E/run-matrix.sh" "$@"
cat "$E2E/results/matrix.log"
cd "$E2E" && node bug-table.js bug > results/bug-table.md; RC=$?
cat results/bug-table.md
echo "B12: ใช้เวลา $(( ($(date +%s)-START)/60 )) นาที · WEB=$WEB · รหัสออก $RC (0 = ผลตรงตาราง BUGS.md)"
exit $RC
