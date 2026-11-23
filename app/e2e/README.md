# ชุด Playwright 51 TC (ตาม TEST-PLAN กลาง)

ทุก test ขึ้นต้นด้วยรหัส TC · ทุก TC เริ่มด้วย `POST /api/test/reset` แล้วล็อกอินใหม่ · รันทีละตัว (`workers: 1`) เพราะใช้ฐานข้อมูลเดียวกัน

| ไฟล์ | ครอบ |
|---|---|
| `tests-a.spec.ts` (17 TC) | AUTH · FEE · SUBMIT · UPLOAD · PAY · QUEUE |
| `tests-b.spec.ts` (31 TC) | SLA · NOTI · WORKFLOW · DOC · PDPA · DASH · AUDIT · RBAC-04..06 · NFR |
| `tests-c.spec.ts` (3 TC) | RBAC-01..03 |
| `b12.sh` | ขั้นรวมของบล็อก B12 แบบคำสั่งเดียว: build เว็บ → matrix 17 รอบ → ตาราง BUGS.md §4 → รหัสออก 0 เมื่อผลตรงตาราง |
| `run-matrix.sh` · `summarize.js` · `bug-table.js` | รันชุดเต็มทีละ `BUG_MODE` (restart เว็บทุกรอบ) · สรุปผล · ทำตารางตาม BUGS.md §4 (รหัสออก 0 = ตรงตาราง) |
| `playwright.report.config.ts` | รันชุดเต็มพร้อมรายงาน HTML + JSON (`report/`) |
| `playwright.rec.config.ts` · `record-gifs.js` | อัดวิดีโอ TC ระดับ P1 ทีละ TC แล้วย่อเป็น GIF → `test-report/report/gifs/` |
| `compose.e2e.yml` | override ของ Docker Compose: bind `/data` ออกมาที่ `e2e/.data` ให้ TC-NFR-04 อ่านไฟล์ฐานข้อมูลได้ |

## รัน

ทุกคำสั่งเริ่มจากรากของ repo · เว็บในข้อ 1 แบบ Node ทำงานค้างหน้าจอ ให้เปิดไว้ในเทอร์มินัลแยก · ข้อ 3 เปิด/ปิดเว็บเอง จึงต้องปิดเว็บของข้อ 1 ก่อน (ใช้พอร์ตเดียวกัน)

```bash
cd app/e2e && npm ci && npx playwright install chromium        # ครั้งแรก

# 1) เปิดเว็บ (เลือกอย่างใดอย่างหนึ่ง) — ต้องตั้ง TEST_MODE=1 เอง (ไม่ตั้ง = ปิด test hook)
cd app && TEST_MODE=1 PORT=3912 docker compose -f docker-compose.yml -f e2e/compose.e2e.yml up -d --build   # Docker
cd app && npm ci && TEST_MODE=1 PORT=3912 DB_PATH=$PWD/e2e/.data/egov.db npm start                          # Node 22 ตรง ๆ

# 2) ชุดเต็ม 51 TC (DB_PATH = ไฟล์ฐานข้อมูลของเว็บ ใช้เฉพาะ TC-NFR-04)
cd app/e2e && DB_PATH=$PWD/.data/egov.db BASE_URL=http://127.0.0.1:3912 npx playwright test

# 3) BUG_MODE ทีละตัว + ชุดรวม (สคริปต์ start/stop เว็บเองทุกรอบ) → results/matrix.log + results/bug-<tag>.json + results/bug-table.md
bash app/e2e/b12.sh                          # เว็บใน Docker Compose (ค่าเริ่ม)
WEB=node bash app/e2e/b12.sh                 # เว็บด้วย node server.js (เครื่องที่ไม่มี Docker)

# 4) รายงาน HTML/JSON และ GIF ของ TC ระดับ P1 (เปิดเว็บตามข้อ 1 ก่อน)
cd app/e2e && DB_PATH=$PWD/.data/egov.db BASE_URL=http://127.0.0.1:3912 npx playwright test -c playwright.report.config.ts
cd app/e2e && DB_PATH=$PWD/.data/egov.db BASE_URL=http://127.0.0.1:3912 node record-gifs.js
```

หมายเหตุ

- `WEB=docker` (ค่าเริ่ม) รันเว็บใน Docker Compose พร้อม `compose.e2e.yml` ที่ bind `/data` ออกมาที่ `e2e/.data` · ทดสอบแล้วบน Windows + Docker Desktop (matrix 17 รอบ รวม TC-NFR-04)
- `WEB=node` รันเว็บด้วย `node server.js` ตรง ๆ สำหรับเครื่องที่ไม่มี Docker · เครื่องที่ไม่มีฟอนต์ไทย PDF จะใช้ป้ายอังกฤษ (test ผ่านทั้งสองแบบ)
- ผลที่คาดหวังทุกค่าใน test มาจากการ์ด TC / กฎใน REQUIREMENTS · DECISIONS ไม่ได้อ่านจากหน้าจอ
- TC-DASH-03 อ่านไฟล์ `.xlsx` ด้วย `exceljs` และดึงข้อความจาก PDF จากตัวดำเนินการ `TJ` (เว็บออก PDF แบบไม่บีบอัด · ฟอนต์ไทยแปลงกลับด้วย ToUnicode CMap)
- กับเว็บใน Docker ที่เก็บข้อมูลใน volume (ไม่ใช้ `compose.e2e.yml`) ให้รัน `npx playwright test --grep-invert TC-NFR-04` เพราะ TC-NFR-04 ต้องอ่านไฟล์ฐานข้อมูลจาก host
