'use strict';
// [B06] เอกสารดิจิทัล + หน้าตรวจเอกสาร (FR-17 FR-18 BR-23 · CONTRACT §2.13 §3 §6.4 §8 · TEST-DATA §5)
// หน้า: GET /verify/:code (ไม่ต้องล็อกอิน · ไม่ขึ้นกับ TEST_MODE)
// API : GET /api/verify/:code · GET /api/documents/:docNo/pdf (citizen เจ้าของ · officer · head · คนอื่น → 404)
// tamper hook อยู่ใน core (src/core/testHooks.js) แก้ applicant_name โดยไม่เซ็นใหม่ → verifyDoc() = false → TAMPERED
//
// ฟังก์ชันที่ provide ให้โมดูลอื่น (ctx.hooks.use(name)):
//   issueDocument(caseRowOrNo, user) → { docNo, verifyCode, issuedAt, validUntil, signer }
//       สร้างแถว documents (ลงนาม HMAC-SHA256 ผ่าน ctx.sign.signDoc) + ตั้ง cases.doc_no เท่านั้น
//       ผู้เรียก (B05) ทำเอง: ตรวจสิทธิ์ A-27 · ตรวจ APPROVED (409 INVALID_STATE) · เปลี่ยนเป็น COMPLETED/closed_at · case_events · audit ISSUE
//       เรียกซ้ำกับคำขอที่มีเอกสารแล้ว → คืนเอกสารเดิม (ไม่ออกเลขใหม่)
//   documentOfCase(caseId) → แถว documents หรือ null
//   docValidUntil(serviceId, issuedISO) → 'YYYY-MM-DD' (BR-23 · A-43 · A-61)
//   verifyStatus(code) → { result, doc } (NOT_FOUND / TAMPERED / EXPIRED / VALID · ลำดับ A-43)
//   verifyUrl(req, code) → '<BASE_URL>/verify/<code>'
//   docQrHtml(req, code) → '<figure ...><svg data-testid="doc-qr" data-url="..."/></figure>' (sync · ใช้ในหน้าเคส)
//   maskApplicant(name) → 'สมชาย ใ***' · ไม่มีนามสกุล → 'มานะ ***' (A-54 A-58)
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');

const VERIFY_TH = { VALID: 'เอกสารถูกต้อง', EXPIRED: 'เอกสารหมดอายุ', TAMPERED: 'ลายเซ็นไม่ถูกต้อง', NOT_FOUND: 'ไม่พบเอกสาร' };
const CODE_RE = /^[A-Z0-9]{8}$/;
const pad6 = (n) => String(n).padStart(6, '0');

/** A-54 A-58: ชื่อเต็ม + อักษรแรกของนามสกุล + *** · ไม่มีนามสกุล → ชื่อ + ' ***' */
function maskApplicant(name) {
  const [first = '', ...rest] = String(name || '').trim().split(/\s+/);
  const last = rest.join(' ');
  return last ? `${first} ${Array.from(last)[0]}***` : `${first} ***`;
}

/** BR-23 · A-43 · A-61: วันสุดท้ายที่ใช้ได้ (หมดอายุตั้งแต่ 00:00 ของวันถัดไป) */
function validUntilFor(clock, serviceId, issuedISO) {
  const issued = clock.dateStr(issuedISO); // วันที่ตามเวลาไทย
  if (serviceId === 'SV-01') return clock.addDays(issued, 89); // 90 วัน รวมวันออก
  const [y, m, d] = issued.split('-').map(Number);
  // วันครบรอบปีถัดไป · ออก 29 ก.พ. แล้วปีถัดไปไม่มี 29 ก.พ. → ใช้ 28 ก.พ.
  const leap = (yy) => (yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0;
  const annivDay = m === 2 && d === 29 && !leap(y + 1) ? 28 : d;
  const anniv = `${y + 1}-${clock.pad(m)}-${clock.pad(annivDay)}`;
  return clock.addDays(anniv, -1);
}

/** QR → SVG (sync · ไม่ต้องรอ promise) */
function qrSvg(text, { size = 160, label = 'QR ตรวจสอบเอกสาร', attrs = '' } = {}) {
  const q = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = q.modules.size;
  const quiet = 4;
  const total = n + quiet * 2;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (q.modules.get(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" role="img" aria-label="${label}" shape-rendering="crispEdges"${attrs}>`
    + `<rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

module.exports = {
  order: 60,
  maskApplicant,
  validUntilFor,
  VERIFY_TH,
  register(app, ctx) {
    const { db, clock, sign, crypto, hooks, html, format, config, session: { guard } } = ctx;
    const { HttpError, wrap } = ctx.errors;
    const { esc, timeEl, SERVICE_NAME } = format;

    const docValidUntil = (serviceId, issuedISO) => validUntilFor(clock, serviceId, issuedISO);
    const displayName = (username) => {
      if (!username) return null;
      const u = db.get('SELECT name FROM users WHERE username = ?', username);
      return u ? u.name : null;
    };
    const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;
    const verifyUrl = (req, code) => `${baseUrl(req)}/verify/${encodeURIComponent(code)}`;
    const documentOfCase = (caseId) => db.get('SELECT * FROM documents WHERE case_id = ? ORDER BY issued_at DESC LIMIT 1', caseId) || null;

    function newVerifyCode() {
      for (;;) {
        const code = crypto.randomCode(8);
        if (CODE_RE.test(code) && !db.get('SELECT 1 AS x FROM documents WHERE verify_code = ?', code)) return code;
      }
    }

    /** ออกเอกสาร (FR-17) · ผู้เรียกตรวจสถานะ/สิทธิ์ก่อน แล้วเปลี่ยนสถานะคำขอเอง */
    function issueDocument(caseRowOrNo, user) {
      return db.tx(() => {
        const key = caseRowOrNo && typeof caseRowOrNo === 'object' ? caseRowOrNo.id : caseRowOrNo;
        const c = typeof key === 'number'
          ? db.get('SELECT * FROM cases WHERE id = ?', key)
          : db.get('SELECT * FROM cases WHERE case_no = ?', key);
        if (!c || !c.case_no) throw new HttpError(404, 'NOT_FOUND');
        const existing = documentOfCase(c.id);
        if (existing) {
          return { docNo: existing.doc_no, verifyCode: existing.verify_code, issuedAt: existing.issued_at, validUntil: existing.valid_until, signer: existing.signer, existing: true };
        }
        const issuedAt = clock.nowISO();
        const be = clock.yearBE(clock.now()); // A-48: พ.ศ. ของเวลาออก เริ่มใหม่ทุกปี
        const citizen = db.get('SELECT name FROM citizens WHERE id = ?', c.citizen_id);
        // ผู้ลงนาม = ผู้อนุมัติ (SV-01 เจ้าหน้าที่ · SV-02/03 หัวหน้าฝ่าย) · ไม่มีข้อมูลผู้อนุมัติ → ผู้กดออกเอกสาร
        const signerUsername = c.approved_by || (user && user.username) || null;
        const signer = displayName(signerUsername) || (user && user.name) || signerUsername || '';
        const doc = {
          doc_no: `DOC-${be}-${pad6(db.nextSeq(`doc:${be}`))}`,
          case_id: c.id,
          case_no: c.case_no,
          verify_code: newVerifyCode(),
          service_id: c.service_id,
          applicant_name: citizen ? citizen.name : '',
          issued_at: issuedAt,
          valid_until: docValidUntil(c.service_id, issuedAt),
          signer,
          signer_username: signerUsername,
        };
        doc.signature = sign.signDoc(doc);
        db.run(`INSERT INTO documents(doc_no, case_id, case_no, verify_code, service_id, applicant_name, issued_at, valid_until, signer, signer_username, signature)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        doc.doc_no, doc.case_id, doc.case_no, doc.verify_code, doc.service_id, doc.applicant_name, doc.issued_at, doc.valid_until, doc.signer, doc.signer_username, doc.signature);
        db.run('UPDATE cases SET doc_no = ? WHERE id = ?', doc.doc_no, c.id);
        return { docNo: doc.doc_no, verifyCode: doc.verify_code, issuedAt: doc.issued_at, validUntil: doc.valid_until, signer: doc.signer, existing: false };
      });
    }

    /** A-43: ไม่พบ → NOT_FOUND · ลายเซ็นไม่ตรง (แม้หมดอายุด้วย) → TAMPERED · วันนี้ > valid_until → EXPIRED · อื่น ๆ VALID */
    function verifyStatus(code) {
      const c = String(code || '').trim().toUpperCase();
      const doc = CODE_RE.test(c) ? db.get('SELECT * FROM documents WHERE verify_code = ?', c) : null;
      if (!doc) return { result: 'NOT_FOUND', doc: null };
      let ok = false;
      try { ok = sign.verifyDoc(doc); } catch (_) { ok = false; }
      if (!ok) return { result: 'TAMPERED', doc };
      if (clock.today() > doc.valid_until) return { result: 'EXPIRED', doc };
      return { result: 'VALID', doc };
    }

    const docQrHtml = (req, code) => {
      const url = verifyUrl(req, code);
      return `<figure class="doc-qr">${qrSvg(url, { attrs: ` data-testid="doc-qr" data-url="${esc(url)}"` })}<figcaption><a href="${esc(url)}">${esc(url)}</a></figcaption></figure>`;
    };

    hooks.provide('issueDocument', issueDocument);
    hooks.provide('documentOfCase', documentOfCase);
    hooks.provide('docValidUntil', docValidUntil);
    hooks.provide('verifyStatus', verifyStatus);
    hooks.provide('verifyUrl', verifyUrl);
    hooks.provide('docQrHtml', docQrHtml);
    hooks.provide('maskApplicant', maskApplicant);

    // ---------- API ตรวจเอกสาร (CONTRACT 6.4) ----------
    app.get('/api/verify/:code', wrap((req, res) => {
      const { result, doc } = verifyStatus(req.params.code);
      if (result === 'NOT_FOUND') return res.status(404).json({ result });
      if (result === 'TAMPERED') return res.json({ result }); // ห้ามเผยข้อมูลเมื่อลายเซ็นไม่ตรง
      res.json({
        result,
        docNo: doc.doc_no,
        applicantMasked: maskApplicant(doc.applicant_name),
        serviceId: doc.service_id,
        issuedAt: doc.issued_at,
        validUntil: doc.valid_until,
        signer: doc.signer,
      });
    }));

    // ---------- หน้า /verify/:code (CONTRACT 2.13 · ไม่ต้องล็อกอิน) ----------
    app.get('/verify/:code', (req, res) => {
      const { result, doc } = verifyStatus(req.params.code);
      const show = result === 'VALID' || result === 'EXPIRED';
      const icon = { VALID: '✔', EXPIRED: '⚠', TAMPERED: '✖', NOT_FOUND: '✖' }[result];
      let details = '';
      if (show) {
        details = `
<dl class="verify-details">
  <dt>เลขเอกสาร</dt><dd data-testid="verify-doc-no">${esc(doc.doc_no)}</dd>
  <dt>ผู้ยื่น</dt><dd data-testid="verify-applicant">${esc(maskApplicant(doc.applicant_name))}</dd>
  <dt>บริการ</dt><dd data-testid="verify-service">${esc(`${doc.service_id} ${SERVICE_NAME[doc.service_id] || ''}`.trim())}</dd>
  <dt>วันออก</dt><dd>${timeEl(doc.issued_at, 'verify-issued')}</dd>
  <dt>ใช้ได้ถึง</dt><dd>${timeEl(doc.valid_until, 'verify-expires')}</dd>
  <dt>ผู้ลงนาม</dt><dd data-testid="verify-signer">${esc(doc.signer)}</dd>
</dl>`;
      }
      const note = {
        VALID: 'ลายเซ็นดิจิทัลตรงกับข้อมูลที่ออกโดยระบบ และเอกสารยังอยู่ในอายุการใช้งาน',
        EXPIRED: 'ลายเซ็นดิจิทัลถูกต้อง แต่เอกสารพ้นวันที่ใช้ได้แล้ว',
        TAMPERED: 'ข้อมูลเอกสารไม่ตรงกับลายเซ็นดิจิทัล อาจถูกแก้ไข กรุณาติดต่อเทศบาล',
        NOT_FOUND: 'ไม่พบเอกสารตามรหัสตรวจสอบนี้ กรุณาตรวจสอบรหัสอีกครั้ง',
      }[result];
      const body = `
<h1>ตรวจสอบเอกสารดิจิทัล</h1>
<section class="verify-box verify-${result.toLowerCase()}" aria-labelledby="verify-result">
  <!-- [B12] ไอคอนอยู่นอก testid: CONTRACT 2.13 verify-result ต้องเป็นข้อความตรงตัว -->
  <p class="verify-result" data-result="${result}"><span aria-hidden="true">${icon}</span> <span id="verify-result" data-testid="verify-result" data-result="${result}" role="status">${esc(VERIFY_TH[result])}</span></p>
  <p class="verify-note">${esc(note)}</p>
  ${details}
</section>
<p data-testid="action-error" role="alert" hidden></p>`;
      const head = `<style>
.verify-box{max-width:640px;border:2px solid #6b7280;border-radius:8px;padding:1rem 1.25rem;background:#fff}
.verify-box.verify-valid{border-color:#166534}.verify-box.verify-expired{border-color:#92400e}
.verify-box.verify-tampered,.verify-box.verify-not_found{border-color:#991b1b}
.verify-result{font-size:1.5rem;font-weight:700;margin:0 0 .5rem}
.verify-valid .verify-result{color:#166534}.verify-expired .verify-result{color:#92400e}
.verify-tampered .verify-result,.verify-not_found .verify-result{color:#991b1b}
.verify-details{display:grid;grid-template-columns:max-content 1fr;gap:.4rem 1rem;margin:1rem 0 0;overflow-wrap:anywhere}
.verify-details dt{font-weight:700}.verify-details dd{margin:0}
@media (max-width:480px){.verify-details{grid-template-columns:1fr}.verify-details dd{margin-bottom:.4rem}}
</style>`;
      html.send(req, res, { title: VERIFY_TH[result], body, head }, result === 'NOT_FOUND' ? 404 : 200);
    });

    // ---------- PDF เอกสาร (CONTRACT §3 · A-52) ----------
    app.get('/api/documents/:docNo/pdf', guard.api(), wrap(async (req, res) => {
      const u = req.user;
      const doc = db.get('SELECT * FROM documents WHERE doc_no = ?', String(req.params.docNo || ''));
      if (!doc) throw new HttpError(404, 'NOT_FOUND');
      if (u.role === 'citizen') {
        const c = db.get('SELECT citizen_id FROM cases WHERE id = ?', doc.case_id);
        if (!c || c.citizen_id !== u.citizenId) throw new HttpError(404, 'NOT_FOUND'); // ของคนอื่น → 404 เหมือนไม่มี
      } else if (u.role !== 'officer' && u.role !== 'head') {
        throw new HttpError(404, 'NOT_FOUND');
      }
      const buf = await renderPdf(doc, verifyUrl(req, doc.verify_code));
      res.status(200);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="${doc.doc_no}.pdf"`);
      res.set('Content-Length', String(buf.length));
      res.end(buf);
    }));

    /** สร้าง PDF (ไม่บีบอัด เพื่อให้บรรทัด ASCII อ่านได้จากไฟล์ดิบ · CONTRACT §3) */
    function renderPdf(doc, url) {
      const asciiLine = `docNo=${doc.doc_no} caseNo=${doc.case_no} verify=${doc.verify_code} validUntil=${doc.valid_until}`;
      return new Promise((resolve, reject) => {
        const pdf = new PDFDocument({
          size: 'A4', margin: 56, compress: false,
          info: { Title: doc.doc_no, Subject: asciiLine, Keywords: asciiLine, Author: 'e-Service', Creator: 'e-Service' },
        });
        const chunks = [];
        pdf.on('data', (b) => chunks.push(b));
        pdf.on('end', () => resolve(Buffer.concat(chunks)));
        pdf.on('error', reject);

        const thai = !!config.THAI_FONT;
        if (thai) { try { pdf.registerFont('thai', config.THAI_FONT); pdf.font('thai'); } catch (_) { pdf.font('Helvetica'); } } else pdf.font('Helvetica');
        const T = (th, en) => (thai ? th : en);
        const svcName = SERVICE_NAME[doc.service_id] || '';
        const rows = [
          [T('เลขเอกสาร', 'Document No.'), doc.doc_no],
          [T('เลขคำขอ', 'Case No.'), doc.case_no],
          [T('ชื่อผู้ยื่น', 'Applicant'), thai ? doc.applicant_name : maskAscii(doc.applicant_name)],
          [T('บริการ', 'Service'), thai ? `${doc.service_id} ${svcName}` : doc.service_id],
          [T('วันออก', 'Issued'), thai ? format.thaiDate(doc.issued_at) : doc.issued_at],
          [T('ใช้ได้ถึง', 'Valid until'), thai ? format.thaiDate(doc.valid_until) : doc.valid_until],
          [T('ผู้ลงนาม', 'Signer'), thai ? doc.signer : (doc.signer_username || '')],
          [T('รหัสตรวจสอบ', 'Verify code'), doc.verify_code],
        ];
        pdf.fontSize(18).text(T('เทศบาลนครตัวอย่าง · เอกสารดิจิทัล', 'Municipality e-Service · Digital Document'), { align: 'center' });
        pdf.moveDown(0.3).fontSize(14).text(thai ? svcName : doc.service_id, { align: 'center' });
        pdf.moveDown(1).fontSize(12);
        for (const [k, v] of rows) pdf.text(`${k}: ${v}`);
        pdf.moveDown(0.8).fontSize(10).text(T('ลายเซ็นดิจิทัลจำลอง (HMAC-SHA256)', 'Simulated digital signature (HMAC-SHA256)'));
        pdf.font('Courier').fontSize(8).text(doc.signature);
        if (thai) { try { pdf.font('thai'); } catch (_) { /* ignore */ } } else pdf.font('Helvetica');

        // QR → /verify/<รหัส>
        const q = QRCode.create(url, { errorCorrectionLevel: 'M' });
        const n = q.modules.size; const cell = 4; const x0 = 56; const y0 = pdf.y + 16;
        pdf.rect(x0 - 8, y0 - 8, n * cell + 16, n * cell + 16).fill('#ffffff');
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.modules.get(r, c)) pdf.rect(x0 + c * cell, y0 + r * cell, cell, cell);
        pdf.fill('#000000');
        pdf.fillColor('#000000').fontSize(10).text(`${T('ตรวจสอบเอกสารที่', 'Verify at')} ${url}`, x0 + n * cell + 24, y0, { width: 300 });
        pdf.text(' ', 56, y0 + n * cell + 24);

        // บรรทัด ASCII ที่เครื่องอ่านได้ (อยู่ใน Info dict เป็น literal string และพิมพ์ลงหน้า)
        pdf.font('Courier').fontSize(8).text(asciiLine, 56, pdf.y + 8);
        pdf.end();
      });
    }
    // PDF ไม่มีฟอนต์ไทย → แสดงเฉพาะส่วนที่เป็น ASCII ไม่ได้ จึงใส่ชื่อแบบปิดบังเป็น '***'
    function maskAscii(name) { return /^[\x20-\x7e]*$/.test(name || '') ? name : '***'; }
  },
};
