'use strict';
// [B01] โครงสร้างฐานข้อมูล SQLite (node:sqlite) · ไฟล์ที่ DB_PATH
// กติกา: เวลาเก็บเป็น TEXT 'YYYY-MM-DDTHH:mm:ss+07:00' (เทียบแบบสตริงได้) · วันที่ล้วน 'YYYY-MM-DD'
// เลขบัตร/เบอร์โทร เก็บเข้ารหัส AES-256-GCM (*_enc) + HMAC สำหรับค้นหา (*_hash) · ห้ามเก็บเลขตรง ๆ (NFR-04)
// บล็อกอื่นต้องการคอลัมน์/ตารางเพิ่ม → เพิ่มผ่าน ctx.hooks.extendSchema(sql) ในโมดูลตัวเอง (ห้ามแก้ไฟล์นี้)

const TABLES = [
  // ---------- ค่าตั้ง / ตัวนับเลขรัน ----------
  `CREATE TABLE counters (
     name  TEXT PRIMARY KEY,            -- 'case:2569' 'receipt:2569' 'doc:2569' 'draft' 'payment' 'file'
     value INTEGER NOT NULL
   )`,
  `CREATE TABLE services (
     id          TEXT PRIMARY KEY,      -- SV-01 SV-02 SV-03
     name        TEXT NOT NULL,         -- ข้อความ service-name
     fee         INTEGER NOT NULL,      -- SV-01 ต่อฉบับ · SV-02 เหมา · SV-03 = feeBase
     fee_per_sqm INTEGER,               -- เฉพาะ SV-03 (อื่น ๆ NULL)
     sla         INTEGER NOT NULL,      -- วันทำการ
     docs        TEXT NOT NULL          -- JSON [{key,name,required,pdfOnly}] ตามลำดับ missing-docs
   )`,
  `CREATE TABLE holidays (
     date TEXT PRIMARY KEY,             -- 'YYYY-MM-DD'
     name TEXT NOT NULL
   )`,

  // ---------- ผู้ใช้ ----------
  `CREATE TABLE users (                 -- เจ้าหน้าที่และบทบาทอื่น (ล็อกอิน username/password)
     username      TEXT PRIMARY KEY,
     password_hash TEXT NOT NULL,       -- scrypt: 'salt:hexhash' · ตรวจด้วย ctx.crypto.verifyPassword
     name          TEXT NOT NULL,
     role          TEXT NOT NULL,       -- officer head executive auditor admin
     dept          TEXT NOT NULL DEFAULT '' -- registry works หรือ ''
   )`,
  `CREATE TABLE citizens (              -- ทะเบียน ThaiD จำลอง + ข้อมูลลงทะเบียน
     id          INTEGER PRIMARY KEY,
     id_hash     TEXT NOT NULL UNIQUE,  -- ctx.crypto.lookupHash(idNo)
     id_enc      TEXT NOT NULL,         -- ctx.crypto.encrypt(idNo)
     id_last3    TEXT NOT NULL,         -- 3 หลักท้าย (ใช้ทำเลขปิดบัง X-XXXX-XXXXX-45-6 โดยไม่ต้องถอดรหัส)
     name        TEXT NOT NULL,         -- ชื่อ-สกุลจาก ThaiD จำลอง
     mobile_enc  TEXT,                  -- encrypt(mobile) · NULL = ยังไม่ลงทะเบียน
     email       TEXT NOT NULL DEFAULT '',
     registered  INTEGER NOT NULL DEFAULT 0,
     consent_at  TEXT,
     registered_at TEXT
   )`,
  `CREATE TABLE otp_state (             -- ตัวนับ OTP ผิด / การล็อก (ต่อเลขบัตร)
     id_hash      TEXT PRIMARY KEY,
     fails        INTEGER NOT NULL DEFAULT 0,
     locked_until TEXT                  -- ISO หรือ NULL
   )`,
  `CREATE TABLE sessions (
     sid         TEXT PRIMARY KEY,
     kind        TEXT NOT NULL,         -- 'staff' | 'citizen' | 'register' (ThaiD ผ่านแต่ยังไม่ลงทะเบียน)
     username    TEXT,                  -- staff
     role        TEXT NOT NULL,         -- บทบาท ณ ตอนล็อกอิน (เปลี่ยนบทบาทมีผลล็อกอินครั้งถัดไป)
     dept        TEXT NOT NULL DEFAULT '',
     citizen_id  INTEGER REFERENCES citizens(id),
     data        TEXT NOT NULL DEFAULT '{}', -- JSON ใด ๆ ของโมดูล
     created_at  TEXT NOT NULL
   )`,

  // ---------- คำขอ (ร่าง + คำขอที่มีเลขแล้ว อยู่ตารางเดียวกัน) ----------
  `CREATE TABLE cases (
     id            INTEGER PRIMARY KEY,
     draft_id      TEXT UNIQUE,         -- 'DR-0003' (ร่างที่สร้างในระบบ) · seed ที่มีเลขแล้ว = NULL ยกเว้น DR-0001/2
     case_no       TEXT UNIQUE,         -- 'EG-2569-000031' ออกตอนชำระสำเร็จ · ร่าง = NULL
     receipt_no    TEXT UNIQUE,         -- 'RC-2569-000031'
     service_id    TEXT NOT NULL REFERENCES services(id),
     citizen_id    INTEGER NOT NULL REFERENCES citizens(id),
     qty           INTEGER,             -- SV-01
     area_sqm      INTEGER,             -- SV-03
     fee           INTEGER NOT NULL,    -- ยอด (ล็อกตอนเข้า PENDING_PAYMENT · A-42)
     sla_days      INTEGER,             -- SLA ที่ใช้คำนวณ dueAt (ตอนชำระ)
     status        TEXT NOT NULL,       -- DRAFT PENDING_PAYMENT SUBMITTED IN_REVIEW NEED_FIX PENDING_APPROVAL APPROVED COMPLETED REJECTED CANCELLED
     dept          TEXT,                -- คิวที่ถือเรื่องอยู่: 'registry' | 'works' | 'head' | NULL (ปิด/ร่าง)
     step          INTEGER,             -- SV-03: 1 ทะเบียน · 2 โยธา · 3 หัวหน้า · อื่น ๆ NULL
     owner         TEXT REFERENCES users(username), -- ผู้ถือเรื่อง (ผู้รับเรื่องขั้นปัจจุบัน) · NULL = ยังไม่มีผู้รับ
     issuer        TEXT REFERENCES users(username), -- ผู้ออกเอกสาร (A-27: ทะเบียนที่รับขั้นแรก)
     step1_by      TEXT,                -- ผู้ตรวจขั้นทะเบียน (SV-02/03)
     step2_by      TEXT,                -- ผู้ตรวจขั้นโยธา (SV-03)
     return_count  INTEGER NOT NULL DEFAULT 0,
     need_fix_at   TEXT,                -- เวลาตีกลับล่าสุด (เมื่อ NEED_FIX)
     fix_deadline  TEXT,                -- need_fix_at + 168 ชม.
     approved_by   TEXT,
     approved_at   TEXT,
     paid_at       TEXT,
     due_at        TEXT,                -- กำหนดเสร็จ (seed เก็บตายตัว · A-35)
     closed_at     TEXT,                -- เฉพาะ COMPLETED / REJECTED (ทันกำหนด ⇔ closed_at ≤ due_at)
     cancelled_at  TEXT,                -- เฉพาะ CANCELLED (ไม่ใช่ "ปิดงาน" ใน dashboard)
     cancel_reason TEXT,                -- 'citizen' | 'fix-expired'
     doc_no        TEXT,                -- เอกสารที่ออก (ถ้ามี)
     seed_label    TEXT,                -- ป้ายใน TEST-DATA (H01 R05 …) ไว้ดีบัก
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL
   )`,
  `CREATE INDEX idx_cases_citizen ON cases(citizen_id)`,
  `CREATE INDEX idx_cases_status ON cases(status)`,
  `CREATE TABLE case_files (
     file_id     TEXT PRIMARY KEY,      -- 'F-000001'
     case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
     doc_key     TEXT NOT NULL,         -- id-card map site-photo plan deed
     name        TEXT NOT NULL,
     mime        TEXT NOT NULL,         -- จาก magic bytes
     size        INTEGER NOT NULL,
     data        BLOB NOT NULL,         -- เนื้อไฟล์ (เก็บใน DB → reset ล้างไฟล์อัปโหลดใหม่ให้เอง)
     uploaded_at TEXT NOT NULL
   )`,
  `CREATE INDEX idx_files_case ON case_files(case_id)`,
  `CREATE TABLE payments (
     ref           TEXT PRIMARY KEY,    -- 'PP-0002'
     case_id       INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
     amount        INTEGER NOT NULL,
     status        TEXT NOT NULL,       -- PENDING | PAID (EXPIRED คำนวณตอนอ่าน: ctx.payments.statusOf)
     qr_created_at TEXT NOT NULL,
     qr_expires_at TEXT NOT NULL,       -- created + 15:00
     paid_at       TEXT
   )`,
  `CREATE TABLE case_returns (          -- ประวัติตีกลับ / ส่งแก้
     id             INTEGER PRIMARY KEY,
     case_id        INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
     n              INTEGER NOT NULL,   -- ครั้งที่
     returned_at    TEXT NOT NULL,
     returned_by    TEXT,
     reason         TEXT NOT NULL,
     resubmitted_at TEXT,
     paused_days    INTEGER            -- วันทำการใน (ตีกลับ, ส่งแก้]
   )`,
  `CREATE TABLE case_events (           -- ไทม์ไลน์ (case-timeline / timeline-item)
     id      INTEGER PRIMARY KEY,
     case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
     time    TEXT NOT NULL,
     event   TEXT NOT NULL,             -- DRAFT PAID CLAIM RETURN RESUBMIT FORWARD APPROVE REJECT ISSUE CANCEL …
     actor   TEXT,                      -- username หรือ 'citizen' / 'system'
     text    TEXT NOT NULL DEFAULT ''   -- ข้อความไทยที่แสดง
   )`,
  `CREATE INDEX idx_events_case ON case_events(case_id)`,

  // ---------- เอกสารดิจิทัล ----------
  `CREATE TABLE documents (
     doc_no          TEXT PRIMARY KEY,  -- 'DOC-2569-000001'
     case_id         INTEGER NOT NULL REFERENCES cases(id),
     case_no         TEXT NOT NULL,
     verify_code     TEXT NOT NULL UNIQUE,
     service_id      TEXT NOT NULL,
     applicant_name  TEXT NOT NULL,     -- ชื่อเต็ม (หน้า verify แสดงแบบปิดบัง)
     issued_at       TEXT NOT NULL,
     valid_until     TEXT NOT NULL,     -- 'YYYY-MM-DD' (หมดอายุตั้งแต่วันถัดไป 00:00)
     signer          TEXT NOT NULL,     -- ชื่อแสดงของผู้ลงนาม
     signer_username TEXT,
     signature       TEXT NOT NULL      -- ctx.sign.signDoc(row) · ตรวจด้วย ctx.sign.verifyDoc(row)
   )`,

  // ---------- แจ้งเตือน / Audit ----------
  `CREATE TABLE notifications (
     id         INTEGER PRIMARY KEY,
     username   TEXT NOT NULL,
     case_no    TEXT NOT NULL,
     level      TEXT NOT NULL,          -- near | overdue
     text       TEXT NOT NULL,
     created_at TEXT NOT NULL,
     read_at    TEXT,
     UNIQUE (username, case_no, level)  -- 1 ครั้งต่อระดับต่อคำขอต่อคน
   )`,
  `CREATE TABLE audit (
     id          INTEGER PRIMARY KEY,
     time        TEXT NOT NULL,
     username    TEXT NOT NULL,
     role        TEXT NOT NULL,
     event       TEXT NOT NULL,         -- STAFF_LOGIN CLAIM RETURN FORWARD APPROVE REJECT ISSUE UNMASK EXPORT ADMIN_CHANGE
     case_no     TEXT,
     from_status TEXT,
     to_status   TEXT,
     detail      TEXT NOT NULL DEFAULT ''
   )`,
  // append-only: ห้ามแก้/ลบแถว audit (reset ใช้ DROP TABLE)
  `CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END`,
  `CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END`,
];

module.exports = { TABLES };
