'use strict';
// [B04] ฝั่งประชาชน: แคตตาล็อก · ฟอร์ม 3 บริการ · ร่าง · แนบไฟล์ · ชำระ QR · ติดตาม · ยกเลิก · ส่งแก้ไข
// ที่มา: REQUIREMENTS FR-04..11 · BR-04..11 BR-20 BR-22 · CONTRACT §2.4 §2.5 §2.6 §5 §6.2 §6.7 · TEST-DATA §4 §6 §11
// โหลดผ่าน src/modules/citizen.js (re-export ไฟล์นี้ · loader ของ B01 โหลดจาก src/modules/ เท่านั้น)
// กฎธุรกิจทั้งหมดเรียกจาก ctx.rules (B03): calcFee · feeClientScript · slaInfo · resumeDueAt · isFixExpired
// ชำระเงิน/QR/เลขคำขอ: ctx.payments (B01) createQr · statusOf · pay (test hook) · holidaySet
//
// หน้า:  GET /citizen · GET /citizen/new/:service[?draft=DR-xxxx] · GET /citizen/cases/:caseNo
// API :  POST/GET /api/drafts · GET/PUT/DELETE /api/drafts/:id · POST /api/drafts/:id/files · DELETE /api/drafts/:id/files/:fileId
//        POST /api/drafts/:id/payment · GET /api/payments/:ref · GET /api/payments/:ref/qr.svg
//        GET /api/cases · GET /api/cases/:caseNo (citizen เจ้าของ · officer · head) · POST /api/cases/:caseNo/cancel|resubmit
//        GET /api/cases/:caseNo/files · GET /api/files/:fileId (citizen เจ้าของ · officer ตามแผนก/ขั้น · head)
// บั๊ก (BUGS.md) ที่อยู่ในไฟล์นี้: B02 (ไฟล์ 5,242,880 ไบต์ถูกปฏิเสธ) · B06 (IDOR หน้า/API คำขอ) · B04 อยู่ใน rules.resumeDueAt
//
// ฟังก์ชันที่ provide ให้โมดูลอื่น (ctx.hooks.use(name)):
//   caseByNo(caseNo) → แถว cases (ยกเลิกอัตโนมัติถ้า NEED_FIX เลย 168 ชม. แล้ว) | undefined
//   caseJson(caseRow, user) → JSON ตาม CONTRACT 6.7 (citizen ได้ idNo · staff ได้ idMasked เท่านั้น)
//   caseFileAccess(user, caseRow) → true หรือ throw HttpError 404/403 (กติกา A-59 / DECISIONS 18)
//   caseFilesHtml(caseRow) → <ul> doc-item + doc-download-link · caseTimelineHtml(caseRow) → <ol data-testid="case-timeline">
//   cancelExpiredFix(caseRow) → true ถ้ายกเลิก (status CANCELLED · cancel_reason 'fix-expired' · cancelled_at = fix_deadline)
//   serviceRow(id) → แถว services + docs (array)
const multer = require('multer');
const QRCode = require('qrcode');

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5,242,880 (BR-07 รวมค่านี้)
const MAX_FILES = 5;
const EXTRA = { key: 'extra', name: 'เอกสารเพิ่มเติม', required: false };
const DRAFT_STATUSES = ['DRAFT', 'PENDING_PAYMENT'];
const CLOSED = ['COMPLETED', 'REJECTED', 'CANCELLED'];
const STEP_LABEL = { 1: 'ขั้นตอน 1/3 · ฝ่ายทะเบียน', 2: 'ขั้นตอน 2/3 · ฝ่ายโยธา', 3: 'ขั้นตอน 3/3 · หัวหน้าฝ่าย' };
const WIZARD_LABEL = { 1: '1/3 กรอกข้อมูล', 2: '2/3 แนบเอกสาร', 3: '3/3 ชำระเงิน' };
const PAY_TH = { PENDING: 'รอชำระ', PAID: 'ชำระแล้ว', EXPIRED: 'QR หมดอายุ' };
const NO_REFUND = 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน';

/** ชนิดไฟล์จาก magic bytes เท่านั้น (BR-06 · A-49) */
function sniffMime(buf) {
  if (!buf || buf.length < 3) return null;
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf'; // %PDF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  return null;
}
const pad = (n, w) => String(n).padStart(w, '0');
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const cleanName = (n) => String(n || 'file').replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f]/g, '').slice(0, 200) || 'file';
const toIntish = (v) => (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v) ? parseInt(v, 10) : v);

// หน้าเว็บ: สไตล์เฉพาะฝั่งประชาชน (B11 ทับได้ใน /ui.css)
const CSS = `<style>
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.table-wrap{position:relative}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr));gap:1rem;margin:1rem 0}
.card{background:#fff;border:1px solid #d1d5db;border-radius:8px;padding:1rem;display:flex;flex-direction:column;gap:.5rem}
.card h3{margin:0;font-size:1.1rem}.card p{margin:0}
a.btn{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;color:#fff;background:#0f3d6e;border:1px solid #0f3d6e;border-radius:6px;padding:.45rem .9rem;min-height:44px}
.btn-secondary,a.btn.btn-secondary{background:#fff;color:#0f3d6e}
.btn-danger{background:#9b1c1c;border-color:#9b1c1c}
.actions{display:flex;flex-wrap:wrap;gap:.5rem;margin:.75rem 0}
.panel{background:#fff;border:1px solid #d1d5db;border-radius:8px;padding:1rem;margin:1rem 0}
.stepper{display:flex;flex-wrap:wrap;gap:.5rem;list-style:none;padding:0;margin:.5rem 0}
.stepper li{padding:.2rem .6rem;border-radius:999px;border:1px solid #6b7280;color:#374151}
.stepper li[aria-current=step]{background:#0f3d6e;color:#fff;border-color:#0f3d6e;font-weight:700}
.fee-line{font-size:1.1rem}.fee-line strong{font-size:1.4rem}
.upload-slot{margin:.75rem 0}.upload-slot input[type=file]{display:block;max-width:100%}
.file-list{list-style:none;padding:0}.file-list li{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;justify-content:space-between;border-bottom:1px solid #e5e7eb;padding:.35rem 0;overflow-wrap:anywhere}
.warn{color:#92400e;font-weight:600}
.qr-card img{width:200px;height:200px;max-width:100%;background:#fff;border:1px solid #d1d5db}
dl.kv{display:grid;grid-template-columns:minmax(7rem,max-content) 1fr;gap:.35rem 1rem;margin:0}
dl.kv dt{font-weight:600}dl.kv dd{margin:0;overflow-wrap:anywhere}
.confirm{border:2px solid #9b1c1c;border-radius:8px;padding:.75rem;margin-top:.5rem;background:#fff}
.note{border-left:4px solid #9b1c1c;padding:.5rem .75rem;background:#fff;font-weight:600}
.timeline{padding-left:1.25rem}.timeline li{margin:.25rem 0}
.muted{color:#4b5563}
</style>`;

module.exports = {
  order: 40,
  sniffMime,
  register(app, ctx) {
    const { db, clock, bugs, crypto, payments, hooks, html, format, errors: { HttpError, wrap, missingDocs }, session: { guard } } = ctx;
    const rules = ctx.rules;
    const { esc, money, timeEl, statusEl, levelEl } = format;

    // ───────────────────────── ข้อมูลพื้นฐาน ─────────────────────────
    function serviceRow(id) {
      const s = db.get('SELECT * FROM services WHERE id = ?', String(id || ''));
      if (!s) return null;
      let docs = [];
      try { docs = JSON.parse(s.docs || '[]'); } catch (_) { docs = []; }
      return { ...s, docs };
    }
    const slotsOf = (svc) => svc.docs.concat([EXTRA]);
    const docName = (svc, key) => (slotsOf(svc).find((d) => d.key === key) || { name: key }).name;
    const holidays = () => payments.holidaySet();
    const filesOf = (caseId) => db.all('SELECT file_id, doc_key, name, mime, size, uploaded_at FROM case_files WHERE case_id = ? ORDER BY uploaded_at, file_id', caseId);
    const fileJson = (f) => ({ fileId: f.file_id, name: f.name, docKey: f.doc_key, size: f.size, mime: f.mime, uploadedAt: f.uploaded_at });
    /** ชื่อเอกสารบังคับที่ขาด ตามลำดับในตาราง 4.3 (BR-08) */
    function missingNames(caseId, svc) {
      const have = new Set(filesOf(caseId).map((f) => f.doc_key));
      return svc.docs.filter((d) => d.required && !have.has(d.key)).map((d) => d.name);
    }
    function addEvent(caseId, time, event, actor, text) {
      db.run('INSERT INTO case_events(case_id, time, event, actor, text) VALUES (?,?,?,?,?)', caseId, time, event, actor, text);
    }
    /** ค่าธรรมเนียมจาก rules.calcFee ด้วยค่าที่ admin ตั้งปัจจุบัน → { fee, qty, areaSqm } หรือ throw 400 */
    function feeOf(svc, input) {
      const inp = input || {};
      const r = rules.calcFee(svc.id, { qty: toIntish(inp.qty), areaSqm: toIntish(inp.areaSqm !== undefined ? inp.areaSqm : inp.area) }, svc);
      if (!r.ok) throw new HttpError(r.status || 400, r.code, r.message);
      return r;
    }

    // ───────────────────────── ยกเลิกอัตโนมัติ (BR-20 · A-46) ─────────────────────────
    // ปกติ B07 ทำใน hooks.beforeRequest · ตรงนี้เป็นตัวสำรองเมื่ออ่าน/ส่งแก้คำขอ (ผลเหมือนกัน · ทำซ้ำไม่ได้เพราะเช็กสถานะ)
    function cancelExpiredFix(c) {
      if (!c || c.status !== 'NEED_FIX' || !c.fix_deadline) return false;
      const now = clock.nowISO();
      if (!rules.isFixExpired(c.fix_deadline, now)) return false;
      const ext = hooks.use('autoCancelFix');
      if (typeof ext === 'function') { ext(c); return true; }
      const at = c.fix_deadline;
      const ch = db.run(`UPDATE cases SET status='CANCELLED', cancelled_at=?, cancel_reason='fix-expired', closed_at=NULL, dept=NULL, owner=NULL, updated_at=?
                         WHERE id=? AND status='NEED_FIX'`, at, now, c.id).changes;
      if (ch) addEvent(c.id, at, 'CANCEL', 'system', 'หมดเวลาแก้ไข 168 ชั่วโมง · ระบบยกเลิกคำขออัตโนมัติ');
      return ch > 0;
    }
    function caseByNo(caseNo) {
      let c = db.get('SELECT * FROM cases WHERE case_no = ?', String(caseNo || ''));
      if (c && cancelExpiredFix(c)) c = db.get('SELECT * FROM cases WHERE id = ?', c.id);
      return c;
    }
    const isOwner = (user, c) => !!(c && user && user.role === 'citizen' && c.citizen_id === user.citizenId);
    /** ประชาชนเปิดคำขอ: ไม่ใช่เจ้าของ = 404 เหมือนเลขที่ไม่มีจริง (BR-22) · B06: ข้ามการตรวจเจ้าของ */
    const citizenCanView = (user, c) => !!c && (isOwner(user, c) || bugs.on('B06'));

    // ───────────────────────── JSON ─────────────────────────
    function slaOf(c) {
      if (!c.case_no) return { level: null, daysLeft: null };
      return rules.slaInfo(c, clock.nowISO(), holidays());
    }
    function caseJson(c, user) {
      const cit = db.get('SELECT * FROM citizens WHERE id = ?', c.citizen_id) || {};
      const doc = c.doc_no ? db.get('SELECT verify_code, issued_at, valid_until FROM documents WHERE doc_no = ?', c.doc_no) : null;
      const sla = slaOf(c);
      const out = {
        caseNo: c.case_no, serviceId: c.service_id, status: c.status,
        step: c.service_id === 'SV-03' ? (c.step || null) : null,
        fee: c.fee, paidAt: c.paid_at || null, dueAt: c.due_at || null, slaLevel: sla.level,
        owner: c.owner || null, returnCount: c.return_count || 0,
        closedAt: ['COMPLETED', 'REJECTED'].includes(c.status) ? (c.closed_at || null) : null,
        applicantName: cit.name || '',
      };
      if (user && user.role === 'citizen') {
        let idNo = null;
        try { idNo = crypto.decrypt(cit.id_enc); } catch (_) { idNo = null; }
        out.idNo = idNo;
      } else {
        out.idMasked = format.maskId(cit.id_last3);
      }
      Object.assign(out, {
        fixDeadline: c.status === 'NEED_FIX' ? (c.fix_deadline || null) : null,
        docNo: c.doc_no || null, verifyCode: doc ? doc.verify_code : null,
        serviceName: format.SERVICE_NAME[c.service_id] || c.service_id,
        receiptNo: c.receipt_no || null, qty: c.qty, areaSqm: c.area_sqm, dept: c.dept || null,
        daysLeft: sla.daysLeft, cancelledAt: c.cancelled_at || null, cancelReason: c.cancel_reason || null,
      });
      return out;
    }
    function latestPayment(caseId) {
      return db.get('SELECT * FROM payments WHERE case_id = ? ORDER BY qr_created_at DESC, ref DESC LIMIT 1', caseId);
    }
    function paymentJson(p, c) {
      const status = payments.statusOf(p);
      const paid = status === 'PAID';
      return {
        ref: p.ref, amount: p.amount, status, qrCreatedAt: p.qr_created_at, qrExpiresAt: p.qr_expires_at,
        paidAt: paid ? (p.paid_at || (c && c.paid_at) || null) : null,
        caseNo: paid && c ? c.case_no : null, receiptNo: paid && c ? c.receipt_no : null,
        draftId: c ? c.draft_id : null,
      };
    }
    function draftJson(c, { full = true } = {}) {
      const out = {
        draftId: c.draft_id, serviceId: c.service_id, status: c.status, fee: c.fee,
        qty: c.qty, areaSqm: c.area_sqm, createdAt: c.created_at, updatedAt: c.updated_at, caseNo: c.case_no || null,
      };
      if (full) {
        const svc = serviceRow(c.service_id);
        out.files = filesOf(c.id).map(fileJson);
        out.missing = svc ? missingNames(c.id, svc) : [];
        const p = latestPayment(c.id);
        out.payment = p ? paymentJson(p, c) : null;
      } else {
        out.fileCount = db.get('SELECT COUNT(*) AS n FROM case_files WHERE case_id = ?', c.id).n;
      }
      return out;
    }
    function ownDraft(req, id) {
      const c = db.get('SELECT * FROM cases WHERE draft_id = ?', String(id || ''));
      if (!c || c.citizen_id !== req.user.citizenId) throw new HttpError(404, 'NOT_FOUND');
      return c;
    }
    const editable = (c) => { if (c.case_no || c.status !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE'); };

    // ───────────────────────── ไฟล์แนบ (BR-06 BR-07 BR-08 · A-49) ─────────────────────────
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: MAX_FILE_BYTES + 1024 * 1024, files: 10, fields: 20 }, // > 5 MB ผ่านมาก่อน แล้วตรวจเองเพื่อตอบ 400 FILE_TOO_LARGE
      defParamCharset: 'utf8',
    });
    const multipart = (mw) => (req, res, next) => mw(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(400, 'FILE_TOO_LARGE'));
      if (err.code === 'LIMIT_FILE_COUNT') return next(new HttpError(400, 'FILE_COUNT'));
      return next(new HttpError(400, 'BAD_REQUEST'));
    });
    /** ตรวจแล้วเก็บไฟล์ · ลำดับ: ขนาด → ชนิด → แบบแปลน PDF → จำนวน · ไฟล์ที่ถูกปฏิเสธไม่เก็บ/ไม่นับ */
    function storeFile(c, svc, docKey, file) {
      if (!file || !file.buffer) throw new HttpError(400, 'BAD_REQUEST', 'กรุณาเลือกไฟล์');
      const slot = slotsOf(svc).find((d) => d.key === docKey);
      if (!slot) throw new HttpError(400, 'BAD_REQUEST', 'ช่องเอกสารไม่ถูกต้อง');
      const size = file.buffer.length;
      const tooLarge = bugs.on('B02') ? size >= MAX_FILE_BYTES : size > MAX_FILE_BYTES; // B02: < แทน ≤
      if (tooLarge) throw new HttpError(400, 'FILE_TOO_LARGE');
      const mime = sniffMime(file.buffer);
      if (!mime) throw new HttpError(400, 'FILE_TYPE');
      if (slot.pdfOnly && mime !== 'application/pdf') throw new HttpError(400, 'PLAN_NOT_PDF');
      const count = db.get('SELECT COUNT(*) AS n FROM case_files WHERE case_id = ?', c.id).n;
      if (count >= MAX_FILES) throw new HttpError(400, 'FILE_COUNT');
      const fileId = `F-${pad(db.nextSeq('file'), 6)}`;
      const now = clock.nowISO();
      db.run('INSERT INTO case_files(file_id, case_id, doc_key, name, mime, size, data, uploaded_at) VALUES (?,?,?,?,?,?,?,?)',
        fileId, c.id, docKey, cleanName(file.originalname), mime, size, file.buffer, now);
      return { fileId, name: cleanName(file.originalname), docKey, size, mime, uploadedAt: now };
    }
    /** สิทธิ์ไฟล์แนบ (DECISIONS 18 · A-59): citizen เจ้าของ · head ทุกแผนก · officer ทะเบียน = ทุกคำขอที่ชำระแล้ว · โยธา = SV-03 ที่ถึงขั้น 2 */
    function caseFileAccess(user, c) {
      if (!user) throw new HttpError(401, 'UNAUTHENTICATED');
      if (user.role === 'citizen') { if (!isOwner(user, c)) throw new HttpError(404, 'NOT_FOUND'); return true; }
      if (user.role !== 'officer' && user.role !== 'head') throw new HttpError(403, 'FORBIDDEN');
      if (!c) throw new HttpError(404, 'NOT_FOUND');
      if (!c.case_no) throw new HttpError(403, 'FORBIDDEN');
      if (user.role === 'head') return true;
      if (user.dept === 'registry') return true;
      if (user.dept === 'works' && c.service_id === 'SV-03' && ((c.step || 0) >= 2 || c.step2_by)) return true;
      throw new HttpError(403, 'FORBIDDEN');
    }

    // ───────────────────────── HTML ชิ้นส่วนร่วม (ใช้ทั้งหน้า citizen และ officer ได้) ─────────────────────────
    function caseFilesHtml(c) {
      const svc = serviceRow(c.service_id);
      const list = filesOf(c.id);
      if (!list.length) return '<p class="muted">ยังไม่มีไฟล์แนบ</p>';
      return `<ul class="file-list">${list.map((f) => `<li data-testid="doc-item" data-name="${esc(f.name)}" data-file-id="${esc(f.file_id)}" data-doc-key="${esc(f.doc_key)}">
<span>${esc(svc ? docName(svc, f.doc_key) : f.doc_key)}: ${esc(f.name)} <span class="muted">(${esc(Math.max(1, Math.round(f.size / 1024)).toLocaleString('en-US'))} KB)</span></span>
<a data-testid="doc-download-link" href="/api/files/${esc(f.file_id)}" target="_blank" rel="noopener">เปิด/ดาวน์โหลด<span class="sr-only"> ${esc(f.name)}</span></a></li>`).join('')}</ul>`;
    }
    function caseTimelineHtml(c) {
      const ev = db.all('SELECT time, event, text FROM case_events WHERE case_id = ? ORDER BY time, id', c.id);
      if (!ev.length) return '<ol class="timeline" data-testid="case-timeline"></ol>';
      return `<ol class="timeline" data-testid="case-timeline">${ev.map((e) => `<li data-testid="timeline-item" data-iso="${esc(e.time)}" data-event="${esc(e.event)}">${timeEl(e.time)} · ${esc(e.text || e.event)}</li>`).join('')}</ol>`;
    }

    hooks.provide('serviceRow', serviceRow);
    hooks.provide('caseByNo', caseByNo);
    hooks.provide('caseJson', caseJson);
    hooks.provide('caseFileAccess', caseFileAccess);
    hooks.provide('caseFilesHtml', caseFilesHtml);
    hooks.provide('caseTimelineHtml', caseTimelineHtml);
    hooks.provide('cancelExpiredFix', cancelExpiredFix);

    // ───────────────────────── API ร่าง (CONTRACT 6.2) ─────────────────────────
    app.post('/api/drafts', guard.api('citizen'), wrap((req, res) => {
      const b = req.body || {};
      const svc = serviceRow(b.serviceId);
      if (!svc) throw new HttpError(400, 'BAD_REQUEST', 'ไม่พบบริการ');
      const f = feeOf(svc, b);
      const now = clock.nowISO();
      const draftId = db.tx(() => {
        const id = `DR-${pad(db.nextSeq('draft'), 4)}`;
        const r = db.run(`INSERT INTO cases(draft_id, service_id, citizen_id, qty, area_sqm, fee, status, created_at, updated_at)
                          VALUES (?,?,?,?,?,?,?,?,?)`, id, svc.id, req.user.citizenId, f.qty, f.areaSqm, f.fee, 'DRAFT', now, now);
        addEvent(r.lastInsertRowid, now, 'DRAFT', 'citizen', 'บันทึกร่างคำขอ');
        return id;
      });
      res.status(201).json({ draftId, serviceId: svc.id, status: 'DRAFT', fee: f.fee, qty: f.qty, areaSqm: f.areaSqm });
    }));

    app.get('/api/drafts', guard.api('citizen'), wrap((req, res) => {
      const rows = db.all(`SELECT * FROM cases WHERE citizen_id = ? AND case_no IS NULL AND status IN ('DRAFT','PENDING_PAYMENT')
                           ORDER BY draft_id`, req.user.citizenId);
      res.json({ items: rows.map((c) => draftJson(c, { full: false })) });
    }));

    app.get('/api/drafts/:id', guard.api('citizen'), wrap((req, res) => {
      res.json(draftJson(ownDraft(req, req.params.id)));
    }));

    app.put('/api/drafts/:id', guard.api('citizen'), wrap((req, res) => {
      const c = ownDraft(req, req.params.id);
      editable(c);
      const svc = serviceRow(c.service_id);
      const f = feeOf(svc, req.body || {});
      db.run('UPDATE cases SET qty=?, area_sqm=?, fee=?, updated_at=? WHERE id=?', f.qty, f.areaSqm, f.fee, clock.nowISO(), c.id);
      res.json(draftJson(db.get('SELECT * FROM cases WHERE id = ?', c.id)));
    }));

    // ลบร่าง (DRAFT / PENDING_PAYMENT ที่ยังไม่ชำระ · A-62) → ref ชำระของร่างนั้นหายไปด้วย (ON DELETE CASCADE)
    app.delete('/api/drafts/:id', guard.api('citizen'), wrap((req, res) => {
      const c = ownDraft(req, req.params.id);
      db.tx(() => {
        const cur = db.get('SELECT * FROM cases WHERE id = ?', c.id);
        const paid = db.get("SELECT 1 AS x FROM payments WHERE case_id = ? AND status = 'PAID'", c.id);
        if (cur.case_no || paid || !DRAFT_STATUSES.includes(cur.status)) throw new HttpError(409, 'INVALID_STATE');
        db.run('DELETE FROM payments WHERE case_id = ?', c.id);
        db.run('DELETE FROM case_files WHERE case_id = ?', c.id);
        db.run('DELETE FROM case_events WHERE case_id = ?', c.id);
        db.run('DELETE FROM cases WHERE id = ?', c.id);
      });
      res.status(204).end();
    }));

    app.post('/api/drafts/:id/files', guard.api('citizen'), multipart(upload.single('file')), wrap((req, res) => {
      const c = ownDraft(req, req.params.id);
      editable(c);
      const svc = serviceRow(c.service_id);
      const docKey = String((req.body && req.body.docKey) || '').trim();
      const out = db.tx(() => storeFile(c, svc, docKey, req.file));
      db.run('UPDATE cases SET updated_at=? WHERE id=?', clock.nowISO(), c.id);
      res.status(201).json(out);
    }));

    app.delete('/api/drafts/:id/files/:fileId', guard.api('citizen'), wrap((req, res) => {
      const c = ownDraft(req, req.params.id);
      editable(c);
      const ch = db.run('DELETE FROM case_files WHERE file_id = ? AND case_id = ?', req.params.fileId, c.id).changes;
      if (!ch) throw new HttpError(404, 'NOT_FOUND', 'ไม่พบไฟล์');
      res.status(204).end();
    }));

    // สร้าง QR (ref ใหม่ทุกครั้ง) · ตรวจเอกสารบังคับ (BR-08) · ร่าง → PENDING_PAYMENT และล็อกยอด ณ ตอนนี้ (BR-11 · A-42)
    app.post('/api/drafts/:id/payment', guard.api('citizen'), wrap((req, res) => {
      const c = ownDraft(req, req.params.id);
      if (c.case_no || !DRAFT_STATUSES.includes(c.status)) throw new HttpError(409, 'INVALID_STATE');
      const svc = serviceRow(c.service_id);
      const missing = missingNames(c.id, svc);
      if (missing.length) throw missingDocs(missing);
      const p = db.tx(() => {
        if (c.status === 'DRAFT') {
          const f = feeOf(svc, { qty: c.qty, areaSqm: c.area_sqm });
          const now = clock.nowISO();
          db.run("UPDATE cases SET fee=?, qty=?, area_sqm=?, status='PENDING_PAYMENT', updated_at=? WHERE id=? AND status='DRAFT'", f.fee, f.qty, f.areaSqm, now, c.id);
          addEvent(c.id, now, 'PENDING_PAYMENT', 'citizen', 'สร้าง QR ชำระเงิน · รอชำระ');
        }
        return payments.createQr(c.id);
      });
      res.status(201).json(paymentJson(p, db.get('SELECT * FROM cases WHERE id = ?', c.id)));
    }));

    function ownPayment(req) {
      const p = db.get('SELECT * FROM payments WHERE ref = ?', String(req.params.ref || ''));
      const c = p && db.get('SELECT * FROM cases WHERE id = ?', p.case_id);
      if (!p || !c || c.citizen_id !== req.user.citizenId) throw new HttpError(404, 'NOT_FOUND', 'ไม่พบรายการชำระ');
      return { p, c };
    }
    app.get('/api/payments/:ref', guard.api('citizen'), wrap((req, res) => {
      const { p, c } = ownPayment(req);
      res.json(paymentJson(p, c));
    }));
    app.get('/api/payments/:ref/qr.svg', guard.api('citizen'), wrap(async (req, res) => {
      const { p } = ownPayment(req);
      // payload จำลอง (ไม่ใช่ EMVCo จริง): ธนาคารจำลองอ่าน ref + ยอด
      const svg = await QRCode.toString(`PROMPTPAY-MOCK|ref=${p.ref}|amount=${Number(p.amount).toFixed(2)}|exp=${p.qr_expires_at}`, { type: 'svg', margin: 1, width: 200 });
      res.type('image/svg+xml').send(svg);
    }));

    // ───────────────────────── API คำขอ (CONTRACT 6.2 · 6.7) ─────────────────────────
    app.get('/api/cases', guard.api('citizen'), wrap((req, res) => {
      const rows = db.all('SELECT * FROM cases WHERE citizen_id = ? AND case_no IS NOT NULL ORDER BY case_no DESC', req.user.citizenId);
      const items = rows.map((c0) => {
        const c = cancelExpiredFix(c0) ? db.get('SELECT * FROM cases WHERE id = ?', c0.id) : c0;
        const sla = slaOf(c);
        return { caseNo: c.case_no, serviceId: c.service_id, status: c.status, dueAt: c.due_at || null, slaLevel: sla.level,
          step: c.service_id === 'SV-03' ? c.step : null, fee: c.fee, paidAt: c.paid_at || null, receiptNo: c.receipt_no || null };
      });
      res.json({ items });
    }));

    app.get('/api/cases/:caseNo', guard.api('citizen', 'officer', 'head'), wrap((req, res) => {
      const c = caseByNo(req.params.caseNo);
      if (req.user.role === 'citizen' ? !citizenCanView(req.user, c) : !c) throw new HttpError(404, 'NOT_FOUND');
      res.json(caseJson(c, req.user));
    }));

    // ยกเลิก: เฉพาะ SUBMITTED ที่ยังไม่มีผู้รับ (BR-22 · A-62) · UPDATE แบบมีเงื่อนไข → ชนกับรับเรื่องสำเร็จฝั่งเดียว
    app.post('/api/cases/:caseNo/cancel', guard.api('citizen'), wrap((req, res) => {
      const c = caseByNo(req.params.caseNo);
      if (!isOwner(req.user, c)) throw new HttpError(404, 'NOT_FOUND');
      if (CLOSED.includes(c.status)) throw new HttpError(409, 'INVALID_STATE');
      const now = clock.nowISO();
      const done = db.tx(() => {
        const ch = db.run(`UPDATE cases SET status='CANCELLED', cancelled_at=?, cancel_reason='citizen', closed_at=NULL, dept=NULL, updated_at=?
                           WHERE id=? AND status='SUBMITTED' AND owner IS NULL`, now, now, c.id).changes;
        if (ch) addEvent(c.id, now, 'CANCEL', 'citizen', 'ประชาชนยกเลิกคำขอ · ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
        return ch > 0;
      });
      if (!done) throw new HttpError(409, 'CANNOT_CANCEL');
      res.json({ status: 'CANCELLED', cancelledAt: now });
    }));

    // ส่งแก้ไข (FR-11 · BR-13 · BR-20 · A-29): กลับ IN_REVIEW ผู้ถือเดิม ขั้นเดิม · ขยายกำหนดด้วย rules.resumeDueAt · แนบไฟล์ใหม่ไม่บังคับ
    app.post('/api/cases/:caseNo/resubmit', guard.api('citizen'), multipart(upload.any()), wrap((req, res) => {
      const c = caseByNo(req.params.caseNo);
      if (!isOwner(req.user, c)) throw new HttpError(404, 'NOT_FOUND');
      if (c.status === 'CANCELLED' && c.cancel_reason === 'fix-expired') throw new HttpError(409, 'FIX_WINDOW_EXPIRED');
      if (c.status !== 'NEED_FIX') throw new HttpError(409, 'INVALID_STATE');
      const now = clock.nowISO();
      if (c.fix_deadline && rules.isFixExpired(c.fix_deadline, now)) { cancelExpiredFix(c); throw new HttpError(409, 'FIX_WINDOW_EXPIRED'); }
      const svc = serviceRow(c.service_id);
      const keys = [].concat((req.body && req.body.docKey) || []);
      const files = (req.files || []).filter((f) => f.fieldname === 'file' || f.fieldname === 'files');
      const out = db.tx(() => {
        files.forEach((f, i) => storeFile(c, svc, String(keys[i] || keys[0] || 'extra').trim() || 'extra', f));
        const ret = db.get('SELECT * FROM case_returns WHERE case_id = ? AND resubmitted_at IS NULL ORDER BY n DESC, id DESC LIMIT 1', c.id);
        const returnedAt = (ret && ret.returned_at) || c.need_fix_at || now;
        const r = c.due_at ? rules.resumeDueAt(c.due_at, returnedAt, now, holidays()) : { dueAt: null, pausedDays: 0 };
        db.run(`UPDATE cases SET status='IN_REVIEW', due_at=?, need_fix_at=NULL, fix_deadline=NULL, updated_at=? WHERE id=? AND status='NEED_FIX'`,
          r.dueAt, now, c.id);
        if (ret) db.run('UPDATE case_returns SET resubmitted_at=?, paused_days=? WHERE id=?', now, r.pausedDays, ret.id);
        addEvent(c.id, now, 'RESUBMIT', 'citizen', files.length ? `ส่งเอกสารแก้ไขแล้ว (แนบไฟล์ใหม่ ${files.length} ไฟล์)` : 'ส่งเอกสารแก้ไขแล้ว');
        return { status: 'IN_REVIEW', dueAt: r.dueAt, pausedDays: r.pausedDays, owner: c.owner || null };
      });
      res.json(out);
    }));

    // ───────────────────────── API ไฟล์แนบ ─────────────────────────
    app.get('/api/cases/:caseNo/files', guard.api(), wrap((req, res) => {
      if (!['citizen', 'officer', 'head'].includes(req.user.role)) throw new HttpError(403, 'FORBIDDEN');
      const c = caseByNo(req.params.caseNo);
      caseFileAccess(req.user, c);
      res.json({ items: filesOf(c.id).map(fileJson) });
    }));
    app.get('/api/files/:fileId', guard.api(), wrap((req, res) => {
      if (!['citizen', 'officer', 'head'].includes(req.user.role)) throw new HttpError(403, 'FORBIDDEN');
      const f = db.get('SELECT * FROM case_files WHERE file_id = ?', String(req.params.fileId || ''));
      if (!f) throw new HttpError(404, 'NOT_FOUND', 'ไม่พบไฟล์');
      caseFileAccess(req.user, db.get('SELECT * FROM cases WHERE id = ?', f.case_id));
      const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      res.set('Content-Type', f.mime);
      res.set('Content-Disposition', `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
      res.set('X-Content-Type-Options', 'nosniff');
      res.send(Buffer.from(f.data));
    }));

    // ───────────────────────── หน้า /citizen (CONTRACT 2.4) ─────────────────────────
    function feeText(svc) {
      if (svc.id === 'SV-01') return `${money(svc.fee)} ต่อฉบับ (1–5 ฉบับ)`;
      if (svc.id === 'SV-03') return `${money(svc.fee)} (1–100 ตร.ม.) + ${money(svc.fee_per_sqm)}/ตร.ม. ส่วนที่เกิน 100 (สูงสุด 500 ตร.ม.)`;
      return `${money(svc.fee)} คงที่`;
    }
    app.get('/citizen', guard.page('citizen'), wrap((req, res) => {
      const me = req.user;
      const services = ['SV-01', 'SV-02', 'SV-03'].map(serviceRow).filter(Boolean);
      const cases = db.all('SELECT * FROM cases WHERE citizen_id = ? AND case_no IS NOT NULL ORDER BY case_no DESC', me.citizenId)
        .map((c) => (cancelExpiredFix(c) ? db.get('SELECT * FROM cases WHERE id = ?', c.id) : c));
      const drafts = db.all("SELECT * FROM cases WHERE citizen_id = ? AND case_no IS NULL AND status IN ('DRAFT','PENDING_PAYMENT') ORDER BY draft_id DESC", me.citizenId);
      const now = clock.nowISO();
      const hol = holidays();

      const cards = services.map((s) => `<article class="card" aria-labelledby="svc-${s.id}">
  <h3 id="svc-${s.id}">${esc(s.id)} ${esc(s.name)}</h3>
  <p>ค่าธรรมเนียม: ${esc(feeText(s))}</p>
  <p>ระยะเวลา: ${esc(s.sla)} วันทำการ</p>
  <p>เอกสาร: ${s.docs.map((d) => `${esc(d.name)}${d.required ? ' ✱' : ' (ไม่บังคับ)'}${d.pdfOnly ? ' (PDF เท่านั้น)' : ''}`).join(' · ')}</p>
  <p><a class="btn" data-testid="start-service-${s.id}" href="/citizen/new/${s.id}">ยื่นคำขอ<span class="sr-only"> ${esc(s.name)}</span></a></p>
</article>`).join('');

      const draftRows = drafts.map((d) => {
        const p = d.status === 'PENDING_PAYMENT' ? latestPayment(d.id) : null;
        return `<tr data-testid="my-draft-row" data-draft-id="${esc(d.draft_id)}" data-status="${esc(d.status)}">
  <td data-testid="row-draft-id">${esc(d.draft_id)}</td>
  <td data-testid="row-service">${esc(d.service_id)} ${esc(format.SERVICE_NAME[d.service_id] || '')}</td>
  <td>${statusEl(d.status, 'row-status')}${p ? ` <span class="muted">${esc(PAY_TH[payments.statusOf(p)])}</span>` : ''}</td>
  <td data-testid="row-fee">${esc(money(d.fee))}</td>
  <td>${timeEl(d.updated_at, 'row-updated')}</td>
  <td><div class="actions"><a class="btn" data-testid="open-draft-btn" href="/citizen/new/${esc(d.service_id)}?draft=${esc(d.draft_id)}">ทำต่อ<span class="sr-only"> ${esc(d.draft_id)}</span></a>
  <button type="button" class="btn-secondary" data-testid="delete-draft-btn" data-draft-id="${esc(d.draft_id)}">ลบร่าง<span class="sr-only"> ${esc(d.draft_id)}</span></button></div></td>
</tr>`;
      }).join('');

      const caseRows = cases.map((c) => {
        const lv = rules.slaLevel(c, now, hol);
        return `<tr data-testid="my-case-row" data-case-no="${esc(c.case_no)}" data-status="${esc(c.status)}">
  <td data-testid="row-case-no"><a href="/citizen/cases/${esc(c.case_no)}">${esc(c.case_no)}</a></td>
  <td data-testid="row-service">${esc(c.service_id)} ${esc(format.SERVICE_NAME[c.service_id] || '')}</td>
  <td>${statusEl(c.status, 'row-status')}</td>
  <td>${timeEl(c.due_at, 'row-due')}</td>
  <td>${lv ? levelEl(lv, 'row-sla-level') : '–'}</td>
</tr>`;
      }).join('');

      const body = `${CSS}
<h1 data-testid="citizen-welcome">สวัสดี ${esc(me.name)}</h1>
<p data-testid="action-error" role="alert" hidden></p>
<section aria-labelledby="h-services"><h2 id="h-services">เริ่มบริการ</h2><div class="cards">${cards}</div></section>
<section aria-labelledby="h-drafts"><h2 id="h-drafts">ร่างและรอชำระเงิน</h2>
${drafts.length ? `<div class="table-wrap"><table><caption class="sr-only">ร่างคำขอที่ยังไม่มีเลขคำขอ</caption>
<thead><tr><th scope="col">รหัสร่าง</th><th scope="col">บริการ</th><th scope="col">สถานะ</th><th scope="col">ค่าธรรมเนียม</th><th scope="col">แก้ไขล่าสุด</th><th scope="col">ดำเนินการ</th></tr></thead>
<tbody>${draftRows}</tbody></table></div>` : '<p class="muted">ไม่มีร่าง</p>'}
</section>
<section aria-labelledby="h-cases"><h2 id="h-cases">คำขอของฉัน</h2>
${cases.length ? `<div class="table-wrap"><table><caption class="sr-only">คำขอที่มีเลขคำขอแล้ว เรียงจากใหม่ไปเก่า</caption>
<thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">สถานะ</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับ</th></tr></thead>
<tbody>${caseRows}</tbody></table></div>` : '<p class="muted">ยังไม่มีคำขอ</p>'}
</section>`;
      const scripts = `<script>
document.addEventListener('click', async function (e) {
  var b = e.target.closest('[data-testid="delete-draft-btn"]'); if (!b) return;
  var id = b.getAttribute('data-draft-id');
  if (!window.confirm('ลบร่าง ' + id + ' ? (QR ที่สร้างไว้จะใช้ไม่ได้)')) return;
  b.disabled = true;
  var r = await api('DELETE', '/api/drafts/' + encodeURIComponent(id));
  if (r.ok) { location.reload(); return; }
  b.disabled = false; showError((r.data && r.data.message) || 'ลบร่างไม่สำเร็จ');
});
</script>`;
      html.send(req, res, { title: 'คำขอของฉัน', body, scripts });
    }));

    // ───────────────────────── หน้า /citizen/new/:service (CONTRACT 2.5) ─────────────────────────
    app.get('/citizen/new/:service', guard.page('citizen'), wrap((req, res) => {
      const svc = serviceRow(req.params.service);
      if (!svc) return html.notFound(req, res, 'ไม่พบบริการ', 'page-not-found');
      let draft = null;
      if (req.query.draft) {
        const c = db.get('SELECT * FROM cases WHERE draft_id = ?', String(req.query.draft));
        if (!c || c.citizen_id !== req.user.citizenId) return html.notFound(req, res);
        if (c.case_no) return res.redirect(`/citizen/cases/${encodeURIComponent(c.case_no)}`);
        if (!DRAFT_STATUSES.includes(c.status)) return html.notFound(req, res);
        if (c.service_id !== svc.id) return res.redirect(`/citizen/new/${encodeURIComponent(c.service_id)}?draft=${encodeURIComponent(c.draft_id)}`);
        draft = draftJson(c);
      }
      const step = draft && draft.status === 'PENDING_PAYMENT' ? 3 : 1;
      const slots = slotsOf(svc);
      const state = { service: { id: svc.id, name: svc.name, docs: slots }, draft, step, maxFiles: MAX_FILES, labels: WIZARD_LABEL, payTh: PAY_TH };

      let inputHtml = '';
      let initRaw;
      if (svc.id === 'SV-01') {
        initRaw = draft && draft.qty != null ? String(draft.qty) : '1';
        inputHtml = `<label for="qty-input">จำนวนฉบับ (1–5 ฉบับ)</label>
<input id="qty-input" name="qty" type="number" inputmode="numeric" min="1" max="5" step="1" data-testid="qty-input" value="${esc(initRaw)}">`;
      } else if (svc.id === 'SV-03') {
        initRaw = draft && draft.areaSqm != null ? String(draft.areaSqm) : '';
        inputHtml = `<label for="area-input">พื้นที่ก่อสร้าง/ต่อเติม (ตร.ม. จำนวนเต็ม 1–500)</label>
<input id="area-input" name="areaSqm" type="number" inputmode="numeric" min="1" step="1" data-testid="area-input" value="${esc(initRaw)}">`;
      } else {
        inputHtml = '<p>บริการนี้ไม่มีข้อมูลที่ต้องกรอกเพิ่ม · ค่าธรรมเนียมคงที่</p>';
      }
      const init = rules.calcFee(svc.id, svc.id === 'SV-01' ? { qty: initRaw } : svc.id === 'SV-03' ? { areaSqm: initRaw === '' ? undefined : initRaw } : {}, svc);
      const feeInit = init.ok ? money(init.fee) : '–';

      const uploadSlots = slots.map((d) => `<div class="upload-slot">
  <label for="upload-${d.key}">${esc(d.name)}${d.required ? ' <span aria-hidden="true">✱</span><span class="sr-only">(บังคับ)</span>' : ' (ไม่บังคับ)'} <span class="muted">· ${d.pdfOnly ? 'PDF เท่านั้น' : 'PDF/JPG/PNG'} ไม่เกิน 5 MB${d.key === 'extra' ? ' · เลือกได้หลายไฟล์' : ''}</span></label>
  <input type="file" id="upload-${d.key}" data-testid="upload-input-${d.key}" data-doc-key="${d.key}"${d.key === 'extra' ? ' multiple' : ''}>
</div>`).join('');

      const body = `${CSS}
<p><a href="/citizen">← คำขอของฉัน</a></p>
<h1 data-testid="service-name">${esc(svc.name)}</h1>
<p data-testid="wizard-step" aria-live="polite">${esc(WIZARD_LABEL[step])}</p>
<ol class="stepper" aria-label="ขั้นตอนการยื่น">${[1, 2, 3].map((n) => `<li data-step="${n}"${n === step ? ' aria-current="step"' : ''}>${esc(WIZARD_LABEL[n])}</li>`).join('')}</ol>
<p id="draft-info"${draft ? '' : ' hidden'}>รหัสร่าง <strong data-testid="draft-id">${draft ? esc(draft.draftId) : ''}</strong></p>
<p data-testid="action-error" role="alert" hidden></p>

<section id="step-1" class="panel" aria-labelledby="h-step-1"${step === 1 ? '' : ' hidden'}>
  <h2 id="h-step-1">กรอกข้อมูล</h2>
  ${inputHtml}
  <div id="fee-error-slot"></div>
  <p class="fee-line">ค่าธรรมเนียม <strong data-testid="fee-total" aria-live="polite">${esc(feeInit)}</strong></p>
  <div class="actions">
    <button type="button" data-testid="to-upload-btn"${init.ok ? '' : ' disabled'}>ถัดไป: แนบเอกสาร</button>
    <button type="button" class="btn-secondary" data-testid="save-draft-btn"${init.ok ? '' : ' disabled'}>บันทึกร่าง</button>
  </div>
</section>

<section id="step-2" class="panel" aria-labelledby="h-step-2"${step === 2 ? '' : ' hidden'}>
  <h2 id="h-step-2">แนบเอกสาร</h2>
  <p class="muted">แนบได้รวมไม่เกิน ${MAX_FILES} ไฟล์ต่อคำขอ · ✱ = เอกสารบังคับ</p>
  ${uploadSlots}
  <div id="upload-error-slot"></div>
  <h3 id="h-files">ไฟล์ที่แนบแล้ว</h3>
  <ul class="file-list" id="file-list" aria-labelledby="h-files"></ul>
  <div id="missing-slot"></div>
  <div class="actions">
    <button type="button" data-testid="to-payment-btn" disabled>ไปชำระเงิน</button>
    <button type="button" class="btn-secondary" data-testid="wizard-back-btn" data-back="1">ย้อนกลับ</button>
  </div>
</section>

<section id="step-3" class="panel" aria-labelledby="h-step-3"${step === 3 ? '' : ' hidden'}>
  <h2 id="h-step-3">ชำระเงิน (PromptPay QR จำลอง)</h2>
  <p class="fee-line">ยอดที่ต้องชำระ <strong data-testid="payment-amount">${esc(money(draft ? (draft.payment ? draft.payment.amount : draft.fee) : (init.ok ? init.fee : 0)))}</strong></p>
  <p class="muted">QR ใช้ได้ 15 นาทีนับจากเวลาที่สร้าง · ยอดต้องตรงกับค่าธรรมเนียมพอดี</p>
  <div class="actions"><button type="button" data-testid="create-qr-btn">สร้าง QR</button></div>
  <div id="qr-box" aria-live="polite"></div>
  <div class="actions"><button type="button" class="btn-secondary" data-testid="wizard-back-btn" data-back="2" id="back-from-3">ย้อนกลับ</button></div>
</section>
<script type="application/json" id="wizard-state">${jsonForScript(state)}</script>`;

      const scripts = `<script>${rules.feeClientScript(svc)}</script><script>${WIZARD_JS}</script>`;
      html.send(req, res, { title: svc.name, body, scripts });
    }));

    // ───────────────────────── หน้า /citizen/cases/:caseNo (CONTRACT 2.6) ─────────────────────────
    app.get('/citizen/cases/:caseNo', guard.page('citizen'), wrap((req, res) => {
      const c = caseByNo(req.params.caseNo);
      if (!citizenCanView(req.user, c)) return html.notFound(req, res);
      const svc = serviceRow(c.service_id);
      const cit = db.get('SELECT * FROM citizens WHERE id = ?', c.citizen_id) || {};
      let idFull = '';
      try { idFull = format.formatId(crypto.decrypt(cit.id_enc)); } catch (_) { idFull = format.maskId(cit.id_last3); }
      const sla = slaOf(c);
      const now = clock.nowISO();
      const detail = c.service_id === 'SV-01' ? `${c.qty || 1} ฉบับ` : c.service_id === 'SV-03' ? `${c.area_sqm} ตร.ม.` : '–';

      const kv = [
        ['สถานะ', statusEl(c.status)],
        ['บริการ', `<span data-testid="case-service">${esc(c.service_id)} ${esc(svc ? svc.name : '')}</span>`],
        c.service_id === 'SV-03' && STEP_LABEL[c.step] ? ['ขั้นตอน', `<span data-testid="case-step" data-step="${esc(c.step)}">${esc(STEP_LABEL[c.step])}</span>`] : null,
        ['ข้อมูลที่กรอก', esc(detail)],
        ['ค่าธรรมเนียม', `<span data-testid="case-fee">${esc(money(c.fee))}</span>`],
        ['ผู้ยื่น', `<span data-testid="case-applicant">${esc(cit.name || '')}</span>`],
        ['เลขบัตรประชาชน', `<span data-testid="case-id-full">${esc(idFull)}</span>`],
        ['ชำระเมื่อ', timeEl(c.paid_at, 'case-paid-at')],
        ['เลขใบเสร็จ', `<span data-testid="case-receipt-no">${esc(c.receipt_no || '–')}</span>`],
        ['กำหนดเสร็จ', timeEl(c.due_at, 'sla-due')],
        ['ระดับเตือน', `${sla.level ? levelEl(sla.level) : '–'}${sla.daysLeft != null ? ` <span data-testid="sla-days-left" class="muted">เหลือ ${esc(sla.daysLeft)} วันทำการ</span>` : ''}`],
        ['COMPLETED', 'REJECTED'].includes(c.status) ? ['ปิดงานเมื่อ', timeEl(c.closed_at, 'closed-at')] : null,
        c.status === 'CANCELLED' ? ['ยกเลิกเมื่อ', timeEl(c.cancelled_at, 'cancelled-at')] : null,
      ].filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');

      let fixHtml = '';
      if (c.status === 'NEED_FIX') {
        const ret = db.get('SELECT * FROM case_returns WHERE case_id = ? ORDER BY (resubmitted_at IS NULL) DESC, n DESC, id DESC LIMIT 1', c.id);
        const expired = c.fix_deadline ? rules.isFixExpired(c.fix_deadline, now) : false;
        const opts = slotsOf(svc).map((d) => `<option value="${esc(d.key)}"${d.key === 'extra' ? ' selected' : ''}>${esc(d.name)}</option>`).join('');
        fixHtml = `<section class="panel" aria-labelledby="h-fix"><h2 id="h-fix">ต้องแก้ไขเอกสาร (ครั้งที่ ${esc(c.return_count || 1)})</h2>
<p>เหตุผลที่ถูกตีกลับ: <strong data-testid="return-reason-display">${esc(ret ? ret.reason : '')}</strong></p>
<p>ส่งแก้ไขได้ภายใน ${timeEl(c.fix_deadline, 'fix-deadline')} (168 ชั่วโมงนับจากเวลาที่ตีกลับ · เลยกำหนดระบบยกเลิกคำขออัตโนมัติ)</p>
${expired ? '<p class="warn">หมดเวลาแก้ไขแล้ว</p>' : `<label for="fix-doc-key">ประเภทเอกสารที่แนบใหม่</label>
<select id="fix-doc-key">${opts}</select>
<label for="fix-upload">แนบไฟล์ใหม่ (ไม่บังคับ · PDF/JPG/PNG ไม่เกิน 5 MB)</label>
<input type="file" id="fix-upload" data-testid="fix-upload-input" multiple>
<div class="actions"><button type="button" data-testid="submit-fix-btn">ส่งแก้ไข</button></div>`}
</section>`;
      }

      let docHtml = '';
      if (c.doc_no) {
        const doc = db.get('SELECT * FROM documents WHERE doc_no = ?', c.doc_no);
        if (doc) {
          const qrFn = hooks.use('docQrHtml');
          docHtml = `<section class="panel" aria-labelledby="h-doc"><h2 id="h-doc">เอกสารดิจิทัล</h2>
<dl class="kv"><dt>เลขเอกสาร</dt><dd data-testid="doc-no">${esc(doc.doc_no)}</dd>
<dt>รหัสตรวจสอบ</dt><dd data-testid="verify-code">${esc(doc.verify_code)}</dd>
<dt>วันออก</dt><dd>${timeEl(doc.issued_at, 'doc-issued-at')}</dd>
<dt>ใช้ได้ถึง</dt><dd>${timeEl(doc.valid_until, 'doc-valid-until')}</dd></dl>
${typeof qrFn === 'function' ? qrFn(req, doc.verify_code) : `<a data-testid="doc-qr" data-url="/verify/${esc(doc.verify_code)}" href="/verify/${esc(doc.verify_code)}">/verify/${esc(doc.verify_code)}</a>`}
<div class="actions"><a class="btn" data-testid="download-doc-btn" href="/api/documents/${esc(doc.doc_no)}/pdf" download="${esc(doc.doc_no)}.pdf">ดาวน์โหลดเอกสาร</a></div>
</section>`;
        }
      }

      const canCancel = c.status === 'SUBMITTED' && !c.owner && isOwner(req.user, c);
      const cancelHtml = canCancel ? `<div class="actions"><button type="button" class="btn-danger" data-testid="cancel-case-btn" aria-expanded="false" aria-controls="cancel-confirm">ยกเลิกคำขอ</button></div>
<div id="cancel-confirm" class="confirm" role="group" aria-labelledby="cancel-q" hidden>
  <p id="cancel-q">ยืนยันยกเลิกคำขอ ${esc(c.case_no)} ?</p>
  <p data-testid="cancel-confirm-text">${NO_REFUND}</p>
  <div class="actions"><button type="button" class="btn-danger" data-testid="confirm-cancel-btn">ยืนยันยกเลิก</button>
  <button type="button" class="btn-secondary" id="cancel-abort">ไม่ยกเลิก</button></div>
</div>` : '';

      const body = `${CSS}
<p><a href="/citizen">← คำขอของฉัน</a></p>
<h1>คำขอ <span data-testid="case-no">${esc(c.case_no)}</span></h1>
<p data-testid="action-error" role="alert" hidden></p>
${['REJECTED', 'CANCELLED'].includes(c.status) ? `<p class="note" data-testid="no-refund-note">${NO_REFUND}</p>` : ''}
<section class="panel" aria-labelledby="h-detail"><h2 id="h-detail">รายละเอียด</h2><dl class="kv">${kv}</dl>${cancelHtml}</section>
${fixHtml}
${docHtml}
<section class="panel" aria-labelledby="h-files"><h2 id="h-files">เอกสารแนบ</h2>${caseFilesHtml(c)}</section>
<section class="panel" aria-labelledby="h-tl"><h2 id="h-tl">ไทม์ไลน์</h2>${caseTimelineHtml(c)}</section>`;

      const scripts = `<script>
(function () {
  var caseNo = ${jsonForScript(c.case_no)};
  var btn = document.querySelector('[data-testid="cancel-case-btn"]');
  var box = document.getElementById('cancel-confirm');
  if (btn && box) {
    btn.addEventListener('click', function () { box.hidden = false; btn.setAttribute('aria-expanded', 'true'); document.querySelector('[data-testid="confirm-cancel-btn"]').focus(); });
    document.getElementById('cancel-abort').addEventListener('click', function () { box.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.focus(); });
    document.querySelector('[data-testid="confirm-cancel-btn"]').addEventListener('click', async function (e) {
      var b = e.currentTarget; b.disabled = true; showError('');
      var r = await api('POST', '/api/cases/' + encodeURIComponent(caseNo) + '/cancel');
      if (r.ok) { location.reload(); return; }
      b.disabled = false; box.hidden = true; showError((r.data && r.data.message) || 'ยกเลิกไม่สำเร็จ');
    });
  }
  var fix = document.querySelector('[data-testid="submit-fix-btn"]');
  if (fix) fix.addEventListener('click', async function () {
    fix.disabled = true; showError('');
    var input = document.querySelector('[data-testid="fix-upload-input"]');
    var key = document.getElementById('fix-doc-key').value;
    var body;
    if (input && input.files && input.files.length) {
      body = new FormData();
      for (var i = 0; i < input.files.length; i++) { body.append('docKey', key); body.append('file', input.files[i], input.files[i].name); }
    }
    var r = await api('POST', '/api/cases/' + encodeURIComponent(caseNo) + '/resubmit', body);
    if (r.ok) { location.reload(); return; }
    fix.disabled = false; showError((r.data && r.data.message) || 'ส่งแก้ไขไม่สำเร็จ');
  });
})();
</script>`;
      html.send(req, res, { title: `คำขอ ${c.case_no}`, body, scripts });
    }));
  },
};

// ───────────────────────── JS ของหน้า wizard (ฝั่งเบราว์เซอร์ · ใช้ api() showError() toast() จาก /app.js) ─────────────────────────
const WIZARD_JS = String.raw`(function () {
  var S = JSON.parse(document.getElementById('wizard-state').textContent);
  var svc = S.service, LABELS = S.labels, PAY_TH = S.payTh;
  var draft = S.draft, files = draft ? draft.files.slice() : [], payment = draft ? draft.payment : null, step = S.step;
  var MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  function T(id) { return document.querySelector('[data-testid="' + id + '"]'); }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(n) { return '฿' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
  function thaiDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || '');
    return m ? (+m[3]) + ' ' + MONTHS[+m[2] - 1] + ' ' + (+m[1] + 543) + ' ' + m[4] + ':' + m[5] : '';
  }
  function timeHtml(iso, testid) { return '<time data-testid="' + testid + '" data-iso="' + esc(iso) + '" datetime="' + esc(iso) + '">' + esc(thaiDate(iso)) + '</time>'; }
  function msg(r, fallback) { return (r && r.data && r.data.message) || fallback; }

  var input = T('qty-input') || T('area-input');
  var dirty = false, busy = false;
  function calc() { return window.egovFee(input ? input.value : undefined); }
  function bodyOf() {
    var b = { serviceId: svc.id }, v = input ? input.value : '';
    var n = /^\s*[+-]?\d+\s*$/.test(v) ? parseInt(v, 10) : v;
    if (svc.id === 'SV-01') b.qty = n;
    if (svc.id === 'SV-03') b.areaSqm = n;
    return b;
  }

  // ── ขั้น 1: ค่าธรรมเนียมสด (rules.feeClientScript) ──
  function renderFee() {
    var r = calc();
    T('fee-total').textContent = r.ok ? money(r.fee) : '–';
    var slot = document.getElementById('fee-error-slot'), err = T('fee-error');
    var show = !r.ok && input && (dirty || input.value !== '');
    if (show) {
      if (!err) { err = document.createElement('p'); err.id = 'fee-error'; err.setAttribute('data-testid', 'fee-error'); err.setAttribute('role', 'alert'); slot.appendChild(err); }
      err.textContent = r.message || '';
      input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', 'fee-error');
    } else {
      if (err) err.remove();
      if (input) { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
    }
    T('to-upload-btn').disabled = !r.ok;
    T('save-draft-btn').disabled = !r.ok;
    return r;
  }
  if (input) input.addEventListener('input', function () { dirty = true; renderFee(); });

  function renderDraftId() {
    if (!draft) return;
    T('draft-id').textContent = draft.draftId;
    document.getElementById('draft-info').hidden = false;
  }
  // บันทึกร่างทีละครั้ง (คำขอซ้อนกันใช้ promise เดิม) · ไฟล์ที่เลือกระหว่างสร้างร่างจะรอร่างเสร็จก่อนอัปโหลด
  var pending = null;
  function saveDraft() {
    if (pending) return pending;
    pending = doSaveDraft().finally(function () { pending = null; });
    return pending;
  }
  async function ensureDraft() {
    if (pending) await pending.catch(function () {});
    if (!draft) await saveDraft();
    return !!draft;
  }
  async function doSaveDraft() {
    if (draft && draft.status !== 'DRAFT') return true;
    if (!calc().ok) { dirty = true; renderFee(); return false; }
    showError('');
    var r = draft ? await api('PUT', '/api/drafts/' + encodeURIComponent(draft.draftId), bodyOf()) : await api('POST', '/api/drafts', bodyOf());
    if (!r.ok) { showError(msg(r, 'บันทึกร่างไม่สำเร็จ')); return false; }
    if (!draft) {
      draft = { draftId: r.data.draftId, status: 'DRAFT', files: [], payment: null };
      try { history.replaceState(null, '', location.pathname + '?draft=' + encodeURIComponent(draft.draftId)); } catch (_) {}
    }
    draft.fee = r.data.fee; draft.qty = r.data.qty; draft.areaSqm = r.data.areaSqm;
    renderDraftId();
    return true;
  }
  async function withBusy(btn, fn) {
    if (busy) return; busy = true; if (btn) btn.disabled = true;
    try { await fn(); } finally { busy = false; if (btn) btn.disabled = false; if (step === 1) renderFee(); if (step === 2) renderFiles(); }
  }

  function show(n, focusEl) {
    step = n;
    [1, 2, 3].forEach(function (k) { document.getElementById('step-' + k).hidden = k !== n; });
    T('wizard-step').textContent = LABELS[n];
    document.querySelectorAll('.stepper li').forEach(function (li) { if (+li.getAttribute('data-step') === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
    if (focusEl) focusEl.focus();
  }

  T('to-upload-btn').addEventListener('click', function (e) {
    withBusy(e.currentTarget, async function () { if (await saveDraft()) { show(2); renderFiles(); var f = T('upload-input-' + svc.docs[0].key); if (f) f.focus(); } });
  });
  T('save-draft-btn').addEventListener('click', function (e) {
    withBusy(e.currentTarget, async function () { if (await saveDraft()) toast('บันทึกร่างแล้ว · รหัส ' + draft.draftId); });
  });

  // ── ขั้น 2: แนบเอกสาร ──
  function docName(key) { for (var i = 0; i < svc.docs.length; i++) if (svc.docs[i].key === key) return svc.docs[i].name; return key; }
  function missing() {
    var have = {}; files.forEach(function (f) { have[f.docKey] = true; });
    return svc.docs.filter(function (d) { return d.required && !have[d.key]; }).map(function (d) { return d.name; });
  }
  function setUploadError(text) {
    var slot = document.getElementById('upload-error-slot'), el = T('upload-error');
    if (!text) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('p'); el.setAttribute('data-testid', 'upload-error'); el.setAttribute('role', 'alert'); slot.appendChild(el); }
    el.textContent = text;
  }
  function renderFiles() {
    var ul = document.getElementById('file-list');
    ul.innerHTML = files.map(function (f) {
      return '<li data-testid="file-item" data-name="' + esc(f.name) + '" data-doc-key="' + esc(f.docKey) + '" data-file-id="' + esc(f.fileId) + '">' +
        '<span>' + esc(docName(f.docKey)) + ': ' + esc(f.name) + ' <span class="muted">(' + Math.max(1, Math.round(f.size / 1024)).toLocaleString('en-US') + ' KB)</span></span>' +
        '<button type="button" class="btn-secondary" data-testid="file-remove-btn" data-file-id="' + esc(f.fileId) + '" aria-label="ลบไฟล์ ' + esc(f.name) + '">ลบ</button></li>';
    }).join('');
    var miss = missing(), slot = document.getElementById('missing-slot'), el = T('missing-docs');
    if (miss.length) {
      if (!el) { el = document.createElement('p'); el.className = 'warn'; el.setAttribute('data-testid', 'missing-docs'); el.setAttribute('role', 'status'); slot.appendChild(el); }
      el.textContent = 'ยังขาดเอกสาร: ' + miss.join(', ');
    } else if (el) el.remove();
    T('to-payment-btn').disabled = miss.length > 0 || busy;
  }
  document.querySelectorAll('#step-2 input[type=file]').forEach(function (inp) {
    inp.addEventListener('change', async function () {
      var list = Array.prototype.slice.call(inp.files || []);
      if (!list.length) return;
      var key = inp.getAttribute('data-doc-key');
      setUploadError('');
      busy = true; T('to-payment-btn').disabled = true;
      try {
        if (!(await ensureDraft())) { setUploadError('กรุณากรอกข้อมูลให้ถูกต้องก่อนแนบเอกสาร'); return; }
        for (var i = 0; i < list.length; i++) {
          var fd = new FormData(); fd.append('docKey', key); fd.append('file', list[i], list[i].name);
          var r = await api('POST', '/api/drafts/' + encodeURIComponent(draft.draftId) + '/files', fd);
          if (!r.ok) { setUploadError(msg(r, 'แนบไฟล์ไม่สำเร็จ')); break; }
          files.push(r.data);
        }
      } finally { busy = false; inp.value = ''; renderFiles(); }
    });
  });
  document.getElementById('file-list').addEventListener('click', async function (e) {
    var b = e.target.closest('[data-testid="file-remove-btn"]'); if (!b || busy) return;
    var id = b.getAttribute('data-file-id'), f = files.filter(function (x) { return x.fileId === id; })[0];
    busy = true; b.disabled = true; setUploadError('');
    try {
      var r = await api('DELETE', '/api/drafts/' + encodeURIComponent(draft.draftId) + '/files/' + encodeURIComponent(id));
      if (r.ok || r.status === 404) files = files.filter(function (x) { return x.fileId !== id; });
      else setUploadError(msg(r, 'ลบไฟล์ไม่สำเร็จ'));
    } finally {
      busy = false; renderFiles();
      var back = f && T('upload-input-' + f.docKey); if (back) back.focus();
    }
  });
  T('to-payment-btn').addEventListener('click', function () {
    if (missing().length) return;
    show(3); renderPayment();
    var c = T('create-qr-btn'); if (c && !c.hidden) c.focus();
  });
  document.querySelectorAll('[data-testid="wizard-back-btn"]').forEach(function (b) {
    b.addEventListener('click', function () {
      var to = +b.getAttribute('data-back');
      show(to); if (to === 1) { renderFee(); if (input) input.focus(); else T('to-upload-btn').focus(); } else { renderFiles(); T('to-payment-btn').focus(); }
    });
  });

  // ── ขั้น 3: QR / สถานะ / ใบเสร็จ ──
  function renderPayment(focus) {
    var locked = draft && draft.status !== 'DRAFT';
    document.getElementById('back-from-3').hidden = !!locked;
    T('payment-amount').textContent = money(payment ? payment.amount : (draft ? draft.fee : 0));
    var create = T('create-qr-btn');
    create.hidden = !!payment;
    var box = document.getElementById('qr-box');
    if (!payment) { box.innerHTML = ''; return; }
    var st = payment.status, h = '<div class="qr-card">';
    if (st === 'PENDING') h += '<p><img data-testid="qr-image" src="/api/payments/' + encodeURIComponent(payment.ref) + '/qr.svg" width="200" height="200" alt="QR พร้อมเพย์จำลอง เลขอ้างอิง ' + esc(payment.ref) + ' ยอด ' + esc(money(payment.amount)) + '"></p>';
    h += '<p>เลขอ้างอิง <strong data-testid="qr-ref">' + esc(payment.ref) + '</strong></p>';
    h += '<p data-testid="qr-expires" data-iso="' + esc(payment.qrExpiresAt) + '">หมดอายุ ' + esc(thaiDate(payment.qrExpiresAt)) + '</p>';
    h += '<p>สถานะ: <span class="badge" data-testid="payment-status" data-status="' + esc(st) + '">' + esc(PAY_TH[st] || st) + '</span></p>';
    if (st === 'EXPIRED') h += '<p data-testid="qr-expired-msg" role="alert">QR หมดอายุ กรุณาสร้าง QR ใหม่</p>';
    h += '<div class="actions">';
    if (st === 'EXPIRED') h += '<button type="button" data-testid="regenerate-qr-btn">สร้าง QR ใหม่</button>';
    h += '<button type="button" class="btn-secondary" data-testid="refresh-payment-btn">ตรวจสอบการชำระเงิน</button></div>';
    if (st === 'PAID') {
      h += '<section class="panel" aria-labelledby="h-receipt"><h3 id="h-receipt">ใบเสร็จรับเงิน</h3><dl class="kv">' +
        '<dt>เลขคำขอ</dt><dd data-testid="submitted-case-no">' + esc(payment.caseNo) + '</dd>' +
        '<dt>เลขใบเสร็จ</dt><dd data-testid="receipt-no">' + esc(payment.receiptNo) + '</dd>' +
        '<dt>ยอดชำระ</dt><dd data-testid="receipt-amount">' + esc(money(payment.amount)) + '</dd>' +
        '<dt>วันเวลาชำระ</dt><dd>' + timeHtml(payment.paidAt, 'receipt-paid-at') + '</dd></dl>' +
        '<div class="actions"><a class="btn" data-testid="go-case-btn" href="/citizen/cases/' + encodeURIComponent(payment.caseNo) + '">ดูคำขอ</a></div></section>';
    }
    box.innerHTML = h + '</div>';
    if (focus) { var f = T(st === 'PAID' ? 'go-case-btn' : st === 'EXPIRED' ? 'regenerate-qr-btn' : 'refresh-payment-btn'); if (f) f.focus(); }
  }
  async function createQr(btn) {
    await withBusy(btn, async function () {
      showError('');
      var r = await api('POST', '/api/drafts/' + encodeURIComponent(draft.draftId) + '/payment');
      if (!r.ok) { showError(msg(r, 'สร้าง QR ไม่สำเร็จ')); return; }
      payment = r.data; draft.status = 'PENDING_PAYMENT';
      renderPayment(true);
    });
  }
  async function refresh(focus) {
    if (!payment) return;
    var r = await api('GET', '/api/payments/' + encodeURIComponent(payment.ref));
    if (!r.ok) { if (focus) showError(msg(r, 'ตรวจสอบไม่สำเร็จ')); return; }
    var changed = r.data.status !== payment.status;
    payment = r.data;
    if (changed || focus) renderPayment(focus);
  }
  T('create-qr-btn').addEventListener('click', function (e) { if (draft) createQr(e.currentTarget); });
  document.getElementById('qr-box').addEventListener('click', function (e) {
    var t = e.target.closest('button'); if (!t) return;
    var id = t.getAttribute('data-testid');
    if (id === 'regenerate-qr-btn') createQr(t);
    if (id === 'refresh-payment-btn') refresh(true);
  });
  setInterval(function () { if (step === 3 && payment && payment.status === 'PENDING' && !busy && !document.hidden) refresh(false); }, 4000);

  // เริ่มต้น
  renderFee(); renderDraftId(); renderFiles();
  if (step === 3) renderPayment(false);
})();`;
