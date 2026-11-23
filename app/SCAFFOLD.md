# SCAFFOLD · โครงโปรเจกต์ e-Service กลาง (บล็อก B01)

Node 22 + Express 4 + SQLite ในตัว (`node:sqlite` ไม่ต้องคอมไพล์) · ไม่มีขั้น build · server-rendered HTML + JS เล็ก ๆ

## 1. รัน

| ทำอะไร | คำสั่ง |
|---|---|
| Docker (คำสั่งเดียว) | `TEST_MODE=1 docker compose up --build` → http://localhost:3000 (โหมดทดสอบ, BUG_MODE ว่าง = เว็บถูกต้อง) |
| เปิดบั๊ก | `TEST_MODE=1 BUG_MODE=B03,B07 docker compose up --build` |
| ปิด test hook | `docker compose up --build` (ไม่ตั้ง `TEST_MODE` → `/api/test/*` ตอบ 404 ตามกติกาข้อ 4 ของโจทย์) |
| พอร์ตอื่น / แยกโปรเจกต์ | `PORT=3920 docker compose -p egov-xx up -d` (ใช้ `-p` เพื่อไม่ชนกับ agent อื่น) |
| ไม่ใช้ Docker | `npm run dev` (= `TEST_MODE=1 DB_PATH=./data/egov.db node server.js`) |
| smoke test ของโครง | `BASE_URL=http://127.0.0.1:3000 npm run smoke` (13 ข้อ: health reset clock pay tamper) |

env: `PORT` (3000) · `DB_PATH` (`./data/egov.db`, ใน Docker `/data/egov.db` volume `egov-data`) · `TEST_MODE` (`1` = เปิด hook) · `BUG_MODE` (`B03,B07`) · `DATA_KEY` `DOC_SIGN_KEY` `LOOKUP_KEY` (มีค่าทดสอบตั้งต้น) · `THAI_FONT` (Docker ติดตั้ง Garuda ให้แล้ว → `config.THAI_FONT`)

ตอนเริ่ม: ถ้า `TEST_MODE=1` หรือ DB ยังว่าง → `reset()` (ล้าง+seed) อัตโนมัติ

## 2. โครงไฟล์และเจ้าของ

```
app/
├─ server.js                 B01  จุดเริ่ม (โหลดโมดูล → reset ถ้า TEST_MODE → listen)
├─ Dockerfile · docker-compose.yml · .dockerignore · .gitignore     B01
├─ package.json              B01  (เพิ่ม dependency ได้: express multer pdfkit qrcode exceljs มีแล้ว)
├─ scripts/smoke.js          B01
├─ public/
│  ├─ app.css · app.js       B01  (app.js: api() showMsg() showError() toast() logout())
│  └─ ui.css                 B11  (ถ้ามีไฟล์ layout โหลดให้เอง)
├─ src/
│  ├─ app.js                 B01  ประกอบ Express + loader โมดูล + 404/error handler
│  ├─ core/                  B01  (ห้ามแก้ · ต้องการอะไรเพิ่มให้แจ้ง B12/ใช้ hooks)
│  │  ├─ index.js            ctx ที่ส่งให้ทุกโมดูล
│  │  ├─ config.js clock.js bugs.js db.js schema.js seed.js crypto.js sign.js
│  │  ├─ errors.js session.js audit.js hooks.js format.js html.js payments.js testHooks.js
│  └─ modules/               ← แต่ละบล็อกเพิ่มไฟล์ของตัวเองที่นี่เท่านั้น
│     ├─ auth.js       B02   /login /register /api/auth/* /api/me
│     ├─ rules.js      B03   pure functions (ไม่มี register · ไม่แตะ DB)
│     ├─ citizen.js    B04   /citizen* /api/drafts* /api/payments/:ref /api/cases (ฝั่งประชาชน) /api/files
│     ├─ officer.js    B05   /officer/* /head/approvals /api/officer/* /api/cases/:no/approve|reject
│     ├─ docs.js       B06   /verify/:code /api/verify/:code /api/documents/:docNo/pdf + ฟังก์ชันออกเอกสาร
│     ├─ notify.js     B07   /notifications /api/notifications + hooks.beforeRequest
│     └─ reports.js    B08   /dashboard /audit /admin/* /api/dashboard* /api/audit* /api/admin/*
└─ e2e/                      B12  ชุด Playwright: tests-a.spec.ts (B09) · tests-b.spec.ts (B10) · tests-c.spec.ts (B12) + runner (cd e2e && npm ci)
```

ถ้าสองโมดูลต้องใช้ endpoint เดียวกัน (เช่น `GET /api/cases/:caseNo` ใช้ทั้งประชาชนและเจ้าหน้าที่) → **เจ้าของคือ B04** แล้ว B05 ใช้ `hooks.provide/use` แลกฟังก์ชันกัน (ข้อ 5) · `GET /api/cases/:caseNo/files` และ `GET /api/files/:fileId` = B04

## 3. สัญญาโมดูล (loader ใน `src/app.js`)

```js
// src/modules/officer.js
'use strict';
module.exports = {
  order: 100,                    // ไม่ใส่ = 100 · น้อยลงทะเบียนก่อน (เท่ากันเรียงชื่อไฟล์)
  register(app, ctx) {           // ไม่มี register = ไลบรารีล้วน (rules.js)
    const { db, clock, bugs, errors: { HttpError, wrap }, session: { guard }, audit, html, format } = ctx;
    app.get('/api/officer/queue', guard.api('officer', 'head'), wrap((req, res) => { /* ... */ }));
    app.get('/officer/queue', guard.page('officer', 'head'), (req, res) => html.send(req, res, { title: 'คิวงาน', body: '...' }));
  },
};
```

ลำดับ middleware: `json(8mb)` → `session` (ตั้ง `req.user`) → `/api/health` → `/api/test/*` → **hooks.beforeRequest** → static `public/` → `GET /` redirect ตามบทบาท → **โมดูล** → 404 → error handler

## 4. ctx (`require('../core')`)

| ชื่อ | ใช้อย่างไร |
|---|---|
| `clock` | **ห้ามใช้ `Date.now()`/`new Date()` ในกฎธุรกิจ** · `now()` ms · `nowISO()` `'2026-12-01T09:00:00+07:00'` · `today()` `'YYYY-MM-DD'` · `parse(iso)` ms/NaN · `toISO(ms)` · `parts(iso)` {y,m,d,hh,mm,ss,dow} · `make(y,m,d,hh,mm)` · `dateStr` `addDays(ymd,n)` `dowOf(ymd)` `yearBE(ms)` |
| `db` | `get(sql,...p)` `all` `run` → `{changes,lastInsertRowid}` · `tx(fn)` (ซ้อนได้) · `nextSeq(name)` เลขรันถัดไป · synchronous ทั้งหมด → ไม่มี race |
| `bugs` | `bugs.on('B07')` → true เมื่อ TEST_MODE=1 และเปิดบั๊กนั้น · `list()` · ปิด = ทำงานถูกต้อง 100% |
| `errors` | `throw new HttpError(409,'ALREADY_CLAIMED')` (ข้อความไทยจาก `MESSAGES` ตรงตาราง 5 อัตโนมัติ) · `new HttpError(401,'OTP_INVALID',null,{attemptsLeft:2})` · `missingDocs(['แบบแปลน','โฉนด'])` · `wrap(fn)` ห่อ handler · `send(res,status,code)` |
| `session` | `create(res,{kind:'staff',username,role,dept})` / `{kind:'citizen'\|'register',role:'citizen',citizenId}` · `destroy(req,res)` · `upgrade(req,'citizen')` (หลังลงทะเบียน) · `guard.api(...roles)` 401 `UNAUTHENTICATED`/403 `FORBIDDEN` · `guard.page(...roles)` → `/login` · session register → `/register` · 403 `forbidden-msg` |
| `req.user` | staff `{kind:'staff',username,name,role,dept,sid}` · citizen `{kind:'citizen',role:'citizen',citizenId,name,username:'citizen:<id>'}` · register `{kind:'register',...}` (ใช้ได้เฉพาะ /register) · ไม่ล็อกอิน `null` |
| `audit` | `audit.log(req.user,'CLAIM',{caseNo,from,to,detail})` · event ต้องอยู่ใน 10 ชนิด (DECISIONS 13) · append-only (trigger กัน UPDATE/DELETE) |
| `format` | `thaiDate(iso)` `4 ธ.ค. 2569 16:30` · `money(1010)` `฿1,010` · `formatId` `maskId(idOrLast3)` `X-XXXX-XXXXX-65-9` · `maskName` `สมชาย ใ***` · `esc` · `timeEl(iso,testid)` (มี `data-iso`) · `statusEl(status)` · `levelEl(level)` · `STATUS_TH LEVEL_TH ROLE_TH LANDING SERVICE_NAME` |
| `html` | `send(req,res,{title,body,head,scripts},status)` (header มี `app-header` `user-name` `user-role` `logout-btn` เมนูตามบทบาท `nav-bell`/`bell-count`) · `forbidden(req,res)` · `notFound(req,res)` (`not-found-msg` `ไม่พบคำขอ`) · หน้าใส่ `<p data-testid="action-error" role="alert" hidden></p>` เอง |
| `crypto` | `encrypt/decrypt` (AES-256-GCM) · `lookupHash(idNo)` · `verifyPassword(pw, users.password_hash)` · `randomCode(8)` (รหัส verify) |
| `sign` | `signDoc(row)` ตอนออกเอกสาร · `verifyDoc(row)` ตอนตรวจ (ฟิลด์ที่ลงนาม: doc_no case_no verify_code service_id applicant_name issued_at valid_until signer) |
| `payments` | `createQr(caseId)` → แถว payments ref ใหม่ (ยอด = `cases.fee` ที่ล็อก) · `statusOf(p)` PAID/EXPIRED/PENDING · `pay(ref,amount)` (ใช้โดย test hook) · `computeDueAt(paidISO,sla)` · `isQrExpired(created,now)` · `holidaySet()` |
| `hooks` | ข้อ 5 |
| `rules` | `ctx.rules` = `src/modules/rules.js` (หรือ `{}` ถ้ายังไม่มี) |

## 5. จุดต่อ (`ctx.hooks`)

| เรียก | ใช้ทำอะไร | ใคร |
|---|---|---|
| `hooks.beforeRequest(fn(req))` | รันทุก request ยกเว้น `/api/test/*` (CONTRACT 0.7) **sync** | B07: สร้างแจ้งเตือน near/overdue + ยกเลิก NEED_FIX ที่เลย `fix_deadline` |
| `hooks.afterReset(fn())` | หลัง reset+seed (ล้าง cache ในหน่วยความจำ) | ทุกโมดูลที่มี state |
| `hooks.extendSchema(sql)` | เพิ่มตาราง/ดัชนีของโมดูล · เรียกตอนโหลดไฟล์ (top-level) ไม่ใช่ใน register | ถ้าจำเป็น |
| `hooks.provide(name, fn)` / `hooks.use(name)` | แลกฟังก์ชันข้ามโมดูล เช่น `provide('bellCount', user => n)` (html ใช้ถ้ามี) · `provide('issueDocument', (caseRow, user) => {docNo,verifyCode})` (B06 → B05) · `provide('caseJson', ...)` | ทุกบล็อก |

## 6. rules.js (B03) · ชื่อฟังก์ชันที่ core เรียก

core (`payments.js`) เรียก 2 ฟังก์ชันนี้ถ้ามีใน rules.js มิฉะนั้นใช้ fallback ในตัว (ผลเหมือน DECISIONS ข้อ 0/7/8 และรองรับ B03 B05 แล้ว):

```js
isQrExpired(qrCreatedAtISO, nowISO) → boolean      // อายุ ≥ 15:00 หมดอายุ · bugs.on('B05') → > 15:00
computeDueAt(paidAtISO, slaDays, holidays /* Set<'YYYY-MM-DD'> */) → 'YYYY-MM-DDT16:30:00+07:00'   // bugs.on('B03') → ไม่ข้ามวันหยุด
```
ที่เหลือ B03 ตั้งชื่อได้เอง (ค่าธรรมเนียม หยุดนับ ระดับเตือน วันคงเหลือ) แล้วจดใน rules.js หัวไฟล์ · B04/B05/B07/B08 เรียกผ่าน `ctx.rules` ห้ามคิดกฎซ้ำ

## 7. ฐานข้อมูล (`src/core/schema.js`)

| ตาราง | สาระ |
|---|---|
| `services` | id name fee fee_per_sqm sla docs(JSON `[{key,name,required,pdfOnly}]`) · SV-03 `fee` = feeBase |
| `holidays` | date name |
| `users` | username password_hash name role dept (`registry`/`works`/'') |
| `citizens` | id **id_hash** (HMAC ค้นหา) **id_enc** (AES) id_last3 name mobile_enc email registered consent_at · ไม่มีเลขบัตร/เบอร์ตรง ๆ ใน DB (TC-NFR-04 ✓) |
| `otp_state` | id_hash fails locked_until |
| `sessions` | sid kind role dept username citizen_id · reset ลบหมด |
| `cases` | **ร่างและคำขออยู่ตารางเดียว** · `draft_id` `DR-xxxx` · `case_no` NULL จนชำระ · status · `dept` คิวปัจจุบัน `registry`/`works`/`head`/NULL · `step` (SV-03 1/2/3) · `owner` ผู้ถือเรื่อง · `issuer` ผู้ออกเอกสาร (A-27) · `step1_by` `step2_by` · return_count need_fix_at fix_deadline · approved_by/at · paid_at due_at · **closed_at เฉพาะ COMPLETED/REJECTED** · **CANCELLED ใช้ cancelled_at** (closed_at = NULL) · cancel_reason · doc_no · fee (ล็อก) · sla_days |
| `case_files` | file_id (`F-` + `nextSeq('file')` 6 หลัก) case_id doc_key name mime size **data BLOB** · reset ล้างไฟล์อัปโหลดให้เอง |
| `payments` | ref (`PP-` + `nextSeq('payment')` 4 หลัก) case_id amount status(PENDING/PAID) qr_created_at qr_expires_at paid_at · ON DELETE CASCADE |
| `case_returns` | case_id n returned_at returned_by reason resubmitted_at paused_days |
| `case_events` | ไทม์ไลน์ case_id time event actor text (seed มี PAID/RETURN/RESUBMIT/APPROVE/ISSUE/REJECT/CANCEL) |
| `documents` | doc_no case_id case_no verify_code service_id applicant_name issued_at valid_until('YYYY-MM-DD') signer signer_username signature |
| `notifications` | username case_no level text created_at · UNIQUE(username,case_no,level) |
| `audit` | time username role event case_no from_status to_status detail · append-only |
| `counters` | `case:<พ.ศ.>` `receipt:<พ.ศ.>` `doc:<พ.ศ.>` `draft` `payment` `file` · ใช้ `db.nextSeq(name)` |

ร่างใหม่: `DR-${String(db.nextSeq('draft')).padStart(4,'0')}` · เอกสาร: `DOC-${be}-${pad6(db.nextSeq('doc:'+be))}` · เลขคำขอ/ใบเสร็จออกใน `payments.pay()` เท่านั้น

## 8. seed (`src/core/seed.js` · ตรวจแล้วตรง TEST-DATA)

30 คำขอ + DR-0001/DR-0002 + PP-0001 (08:55→09:10) + DOC-2569-000001 (`K7M2Q9XA` ลงนามจริง) + ไฟล์แนบ PDF 1,024 ไบต์ทุกคำขอ · audit/แจ้งเตือน/session ว่าง
ตรวจแล้ว: งานคงค้าง 21 (SUBMITTED 4 · IN_REVIEW 13 · NEED_FIX 1 · PENDING_APPROVAL 2 · APPROVED 1) · งานในมือ reg1 3 / reg2 9 · คิวทะเบียน 17 แถวเรียงตรงข้อ 9.1 · โยธา 1 (`…010`) · หัวหน้า 2 · dashboard ต.ค. 100% / พ.ย. 26·7·6 = 85.7% / พ.ย. SV-02 66.7% / ปี 30·8·7 = 87.5% / ธ.ค. 3·0 = `–`
ค่าที่ตั้งเพื่อให้โมดูลใช้: PENDING_APPROVAL `dept='head'` owner NULL · APPROVED `…019` dept registry owner NULL issuer `off.reg1` · W01 `…010` dept `works` step 2 owner NULL · F01 `…017` NEED_FIX owner `off.reg1` fix_deadline `2026-12-04T14:00:00+07:00` · ประวัติ COMPLETED/REJECTED มี issuer `off.reg1` owner NULL

## 9. Test hook (`src/core/testHooks.js` · TEST_MODE≠1 → 404)

`POST /api/test/reset` · `GET/PUT /api/test/clock` (แช่แข็ง · ไม่มี offset → 400 `INVALID_TIME`) · `POST /api/test/payments/:ref/pay` (ลำดับ: ไม่มี ref 404 → จ่ายแล้ว 200 duplicate → 410 `QR_EXPIRED` → 422 `AMOUNT_MISMATCH`) · `POST /api/test/documents/:docNo/tamper` (ต่อท้าย applicant_name ด้วย ` (แก้ไข)` ไม่เซ็นใหม่) · **เสริม** `GET/PUT /api/test/bugs {"bugs":"B03"}` สลับ BUG_MODE ระหว่างรันไม่ต้องรีสตาร์ต (B12 ใช้ได้)

## 10. BUG_MODE → ใครใส่ `if (bugs.on(...))`

> รหัสบั๊ก B01–B12 **คนละชุด** กับรหัสบล็อก B01–B12

| บั๊ก | จุด | บล็อก |
|---|---|---|
| B01 SV-03 101 ตร.ม. = ฿1,000 | ค่าธรรมเนียม | B03 rules |
| B02 5,242,880 ไบต์ถูกปฏิเสธ | อัปโหลด | B04 |
| B03 SLA ไม่ข้ามวันหยุด | เฉพาะการคำนวณกำหนดเสร็จ: computeDueAt (ตอนชำระ) + resumeDueAt (ตอนส่งแก้) ผ่าน `dueHolidays()` · วันคงเหลือ/ระดับเตือน/แจ้งเตือนไม่กระทบ | B03 rules (fallback ใน core รองรับแล้ว) |
| B04 ไม่หยุดนับตอน NEED_FIX | ส่งแก้ → ขยายกำหนด | B03 rules / B04 resubmit |
| B05 QR 15:00 พอดียังจ่ายได้ | isQrExpired | B03 rules (fallback ใน core รองรับแล้ว) |
| B06 IDOR | `GET /api/cases/:no` + หน้า `/citizen/cases/:no` | B04 |
| B07 เจ้าหน้าที่อนุมัติ SV-02 ได้ | `POST /api/cases/:no/approve` | B05 |
| B08 รับเรื่องซ้อน | claim ข้ามการตรวจผู้ถือ (คนที่ 2 เป็นผู้ถือแทน) | B05 |
| B09 คิวส่งเลขบัตรเต็ม | `GET /api/officer/queue` (ใส่ `idNo`) | B05 |
| B10 ทันกำหนด % ÷ รับเรื่อง | dashboard | B08 |
| B11 unmask ไม่ลง audit | `POST /api/officer/cases/:no/unmask` | B05 |
| B12 ตีกลับครั้งที่ 3 ได้ | return | B05 |

## 11. ข้อควรรู้

- เวลาเก็บเป็นสตริง ISO `+07:00` เสมอ → เทียบ `<=` แบบสตริงได้ (offset เดียวกัน) · input จาก test อาจเป็น `Z` → ผ่าน `clock.normalize()` ก่อนเก็บ
- อัปโหลด: ใช้ `multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } })` แล้วตรวจ `size > 5242880` เอง → 400 `FILE_TOO_LARGE` (อย่าให้ multer ตอบ 413) · ตรวจชนิดจาก magic bytes
- seed PDF ใช้ `seed.pdfBytes(n)` ได้ · ไฟล์ใหม่ใช้ `db.nextSeq('file')`
- ปุ่ม "ต้องไม่มี" = ไม่ render · "ใช้ไม่ได้" = `disabled` (CONTRACT 0.5)
- เจ้าหน้าที่/หัวหน้า: ห้ามมีเลขบัตร 13 หลักใน response ใด ๆ (ใช้ `maskId(citizens.id_last3)`) · เลขเต็ม = `crypto.decrypt(citizens.id_enc)` เฉพาะเจ้าของ/unmask
- node:sqlite คืนแถวเป็น object ธรรมดา (core แปลงให้แล้ว) · ค่า `undefined` ถูกแปลงเป็น NULL
