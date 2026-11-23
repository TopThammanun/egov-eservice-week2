# e-Service กลาง "เทศบาลนครตัวอย่าง" · งาน LAB Week 2

ผู้จัดทำ: **Thammanun** (GitHub [@TopThammanun](https://github.com/TopThammanun))

เว็บ e-Service ของเทศบาลสมมติ: ประชาชนยื่นคำขอ 3 บริการและจ่ายเงินออนไลน์ เจ้าหน้าที่ตรวจและออกเอกสารดิจิทัล หัวหน้าอนุมัติ ผู้บริหารดู Dashboard ผู้ตรวจสอบดู Audit Trail
สร้างด้วยทีมเอเจนต์ตามแผน DAG แล้ว **พิสูจน์ด้วย Playwright 51 TC** และ **BUG_MODE 12 บั๊ก** ตามชุดโจทย์ของผู้สอน

> หน่วยงานเป็นของสมมติ · ThaiD, PromptPay QR และลายเซ็นดิจิทัลเป็น **ตัวจำลอง** ทั้งหมด ไม่เชื่อมระบบจริง

## ผลลัพธ์

| รายการ | ผล | หลักฐาน |
|---|---|---|
| ชุด Playwright 51 TC (`TEST_MODE=1` ไม่ตั้ง `BUG_MODE`) | **ผ่าน 51/51** · รันซ้ำทันทีโดยไม่ restart เว็บ 51/51 · หลังปิดบั๊กทั้งหมด 51/51 | [`test-report/index.html`](test-report/index.html) · [`test-report/results.json`](test-report/results.json) · [`matrix.log`](test-report/results/matrix.log) · [`rerun-no-restart.log`](test-report/results/rerun-no-restart.log) |
| BUG_MODE B01–B12 ทีละตัว | **จับได้ 12/12** · ชุด TC ที่ล้มอยู่ในรายการของ BUGS.md ทุกตัว (ไม่มีล้มเกิน ไม่มีผ่านหลอก) | [`BUG-HUNT.md`](BUG-HUNT.md) · `test-report/results/bug-*.json` |
| บั๊กรวม `B03,B07` · `B01,B05,B09` | ล้มเท่ากับ union ของแต่ละตัว | [`BUG-HUNT.md`](BUG-HUNT.md) |
| GIF ของ TC ระดับ P1 | 43 ไฟล์ (P1 ทั้งหมด) | [`test-report/report/gifs/`](test-report/report/gifs/) |
| เว็บใน Docker (`TEST_MODE=1 docker compose up --build`) | ผ่าน 50/50 (ทุก TC ยกเว้น TC-NFR-04 ที่ต้องอ่านไฟล์ฐานข้อมูลจาก host) · BUG_MODE matrix รันกับ `node server.js` โค้ดชุดเดียวกัน | [`test-report/results/docker-run.log`](test-report/results/docker-run.log) |
| ไม่ตั้ง `TEST_MODE` | `/api/test/*` ตอบ 404 ทุกเส้น · `/api/health` และ `/verify` ยังใช้ได้ | [`test-report/results/test-mode-off.log`](test-report/results/test-mode-off.log) |

## ไฟล์ที่ส่ง (ตาม `PROMPTS.md` ของชุดโจทย์)

| ขั้น | ไฟล์ | คืออะไร |
|---|---|---|
| 1 วางแผน | [`blocks.json`](blocks.json) · [`dag.png`](dag.png) · [`gantt-plan.png`](gantt-plan.png) · [`PLAN.md`](PLAN.md) | 12 บล็อก · 4 บัญชี (yolo1 yolo2 cyolo1 cyolo2) · สายวิกฤต B01 → B03 → B04 → B11 → B12 |
| 3 รันทีม | [`gantt-actual.png`](gantt-actual.png) · [`compare.png`](compare.png) · [`REPORT.md`](REPORT.md) · [`run.log`](run.log) · [`run-resume.log`](run-resume.log) | ผลรันจริงของ agent-team (+ ภาคผนวกหลัง resume) |
| 3–4 เว็บ + test | [`app/`](app/) · [`app/e2e/`](app/e2e/) | เว็บ (Node 22 + SQLite ในตัว) และชุด Playwright 51 TC |
| 4 TEST-PLAN | [`test-report/`](test-report/) | `results.json` · `index.html` · GIF ของ TC ระดับ P1 · ผลดิบ BUG_MODE ทุกรอบ |
| 5 BUG_MODE | [`BUG-HUNT.md`](BUG-HUNT.md) | ตาราง triage ตามรูปแบบ BUGS.md §4 |
| สรุป | [`FINAL-REPORT.md`](FINAL-REPORT.md) · [`SUMMARY.md`](SUMMARY.md) | รายงานขั้นรวม (ผลของบล็อก B12) · สรุปส่งงานและคำถามถึง TA |

repo นี้คือโฟลเดอร์ `week2/egov-eservice/` ของชุดโจทย์ (วางไว้ที่ราก repo) · ชุดโจทย์ของผู้สอน (`egov-brief/`) ไม่ได้แนบมา

## รันเว็บ (คำสั่งเดียว)

```bash
cd app
docker compose up --build                              # http://localhost:3000 · ไม่ตั้ง TEST_MODE = ปิด test hook
TEST_MODE=1 docker compose up --build                  # โหมดทดสอบ: เปิด /api/test/* · เว็บถูกต้อง 100%
TEST_MODE=1 BUG_MODE=B03,B07 docker compose up --build # เปิดบั๊กตามรหัสใน BUGS.md
```

ไม่ใช้ Docker: `cd app && npm ci && TEST_MODE=1 npm start` (ต้องใช้ Node ≥ 22.13 เพราะใช้ `node:sqlite` ในตัว)

บัญชีทดสอบ (จาก TEST-DATA): ประชาชน เลขบัตร `1101700123456` OTP `123456` · เจ้าหน้าที่ `off.reg1` `off.reg2` `off.works1` `head1` `exec1` `audit1` `admin1` รหัสผ่าน `Test@1234`

## รันชุดทดสอบ

```bash
cd app/e2e && npm ci && npx playwright install chromium
cd ../ && TEST_MODE=1 PORT=3912 DB_PATH=$PWD/e2e/.data/egov.db npm start &            # หรือ docker compose (ดู app/e2e/README.md)
cd e2e && DB_PATH=$PWD/.data/egov.db BASE_URL=http://127.0.0.1:3912 npx playwright test   # 51 passed
cd ../ && WEB=node bash e2e/run-matrix.sh "" "" B01 B02 B03 B04 B05 B06 B07 B08 B09 B10 B11 B12 "B03,B07" "B01,B05,B09" ""
```

รายละเอียดและข้อจำกัดของแต่ละวิธี: [`app/e2e/README.md`](app/e2e/README.md)

## ตรวจแผนด้วยตัวเอง (ขั้น 2 ของ PROMPTS)

| ตรวจ | ผล | ดูที่ |
|---|---|---|
| ทุก FR ใน REQUIREMENTS มีบล็อกที่ทำ | FR-01 ถึง FR-29 มีบล็อกรับครบ (FR-28 health + test hook อยู่ใน B01 · เติมรหัส FR/NFR ที่ไม่ได้เขียนไว้ใน `desc` ของ B01 และ B12 ด้วยมือ ไม่กระทบลูกศรและแผนเวลา) · BR-01 ถึง BR-29 ครบ · NFR-05 (HTTPS ตอน deploy) อยู่นอกขอบเขตตามโจทย์ (Q-08) | `blocks.json` |
| บล็อก Playwright ไม่มีลูกศรจากบล็อกเว็บ | B09 · B10 `depends_on: []` (อ่านได้เฉพาะ TEST-PLAN CONTRACT TEST-DATA) จึงทำขนานกับบล็อกเว็บ | `blocks.json` · `dag.png` |
| บล็อกสุดท้ายเป็นรวม + ทดสอบ แบบ exclusive | B12 `exclusive: true` รอ B04–B11 | `blocks.json` · `dag.png` |
| ไม่มีสองบล็อกที่เขียนไฟล์เดียวกัน | `output` 12 ค่าไม่ซ้ำกัน (SCAFFOLD.md · auth.js · rules.js · citizen.js · officer.js · docs.js · notify.js · reports.js · tests-a.spec.ts · tests-b.spec.ts · ui-audit.md · FINAL-REPORT.md) | `blocks.json` |
| ทุกบล็อกมีบัญชีรับ | ครบ 12 บล็อก (B03 · B08 ใช้ `review` มีทั้งผู้ทำและผู้ตรวจ) | `PLAN.md` |

## กติกาของโจทย์ที่ตรวจแล้ว

| กติกา | ทำอย่างไร |
|---|---|
| ทำตาม CONTRACT (route · `data-testid` · ข้อความ error · API · test hook) | ตรวจด้วยชุด 51 TC ที่ assert ตามการ์ด TC ทั้งบนจอและ API |
| ตัวเลข กฎ seed ตรง REQUIREMENTS + TEST-DATA | ผลที่คาดหวังใน test คิดจากกฎ ไม่ได้อ่านจากหน้าจอ · ข้อที่เห็นว่าโจทย์ไม่ชัดจดเป็นคำถามใน `SUMMARY.md` ไม่แก้เอง |
| `TEST_MODE=1` เปิด test hook · ไม่ตั้ง = ปิด | ค่าเริ่มของ `docker-compose.yml` คือไม่ตั้ง · มีหลักฐาน 404 ใน `test-report/results/test-mode-off.log` |
| `BUG_MODE` คั่นด้วยจุลภาค · ไม่ตั้ง = ถูกต้อง 100% | `app/src/core/bugs.js` · บั๊กทำงานเฉพาะเมื่อ `TEST_MODE=1` และอยู่ที่ตรรกะฝั่งเซิร์ฟเวอร์ทุกตัว |
| เวลาใช้ Asia/Bangkok และอ่านจากนาฬิกาทดสอบ | กฎธุรกิจเรียก `clock.now()` ที่เดียว (`app/src/core/clock.js`) ไม่มี `Date.now()` / `new Date()` ในกฎ |
| ไม่มีชื่อ/ตราหน่วยงานจริง ไม่เชื่อมระบบจริง | ThaiD = เลขบัตร + OTP คงที่ · PromptPay = QR จำลอง + test hook · ลายเซ็น = HMAC-SHA256 คีย์ทดสอบ |
