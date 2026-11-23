'use strict';
// [B05] ฝั่งเจ้าหน้าที่ / หัวหน้า · โหลดโดย loader ของ B01 (src/modules/*.js) · ไฟล์ผล <app>/officer.js re-export ไฟล์นี้
// ที่มา: FR-12..16 FR-21 FR-29 · BR-16..19 BR-21 BR-24 BR-29 · CONTRACT §2.6 §2.7 §2.8 §5 §6.3 §6.7 §6.8 · TEST-DATA §9
//        DECISIONS §1 §5 §9 §10 §11 §13 §18 · A-19 A-20 A-24 A-27 A-28 A-32 A-34 A-40 A-44 A-59 A-62
//
// หน้า:  GET /officer/queue (officer · head อ่านอย่างเดียว) · GET /officer/cases/:caseNo (officer · head) · GET /head/approvals (head)
// API:   GET  /api/officer/queue?filter=all|unclaimed|mine          → {items:[{caseNo,serviceId,applicantName,idMasked,status,step,owner,dueAt,slaLevel}]}
//        POST /api/officer/cases/:caseNo/claim                       → {owner,status,workload}   (สิทธิ์ → ALREADY_CLAIMED → WORKLOAD_LIMIT)
//        POST /api/officer/cases/:caseNo/return   {reason}           → {status:'NEED_FIX',returnCount,fixDeadline}
//        POST /api/officer/cases/:caseNo/forward  {note?}            → {status:'IN_REVIEW',step:2} | {status:'PENDING_APPROVAL'}
//        POST /api/cases/:caseNo/approve                             → {status:'APPROVED'}
//        POST /api/cases/:caseNo/reject           {reason}           → {status:'REJECTED',closedAt}
//        POST /api/officer/cases/:caseNo/issue                       → {docNo,verifyCode,status:'COMPLETED'}   (เรียก hooks 'issueDocument' ของ B06)
//        POST /api/officer/cases/:caseNo/unmask   {reason}           → {idNo} + Audit UNMASK
//        GET  /api/officer/cases/:caseNo · GET /api/head/approvals   (เสริม)
// ของ B04 (citizen.js): GET /api/cases/:caseNo · GET /api/cases/:caseNo/files · GET /api/files/:fileId (ฝั่งเจ้าหน้าที่ BR-29 กติกาเดียวกับ staffCanViewFiles)
//        หน้า /officer/cases ใช้ hooks 'caseFileAccess' ของ B04 ตัดสินว่าแสดง doc-item ได้ไหม (ไม่มี hook → staffCanViewFiles)
// hooks.provide: staffCaseJson(caseNo) · staffCanViewFiles(user, caseRow) · officerWorkload(username)
//
// BUG_MODE ที่อยู่ในไฟล์นี้: B07 (approve SV-02/03 ไม่เช็กอำนาจของเจ้าหน้าที่) · B08 (claim ข้ามการตรวจผู้ถือ) · B09 (คิวส่ง idNo เต็ม)
//                          B11 (unmask ไม่ลง Audit) · B12 (ตีกลับครั้งที่ 3 ได้ ทั้ง API และปุ่ม)

const CLAIMABLE = ['SUBMITTED', 'IN_REVIEW'];
const QUEUE_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'APPROVED'];      // A-34 (NEED_FIX / PENDING_APPROVAL ไม่อยู่ในคิว)
const FILTERS = ['all', 'unclaimed', 'mine'];
const MAX_WORKLOAD = 10;                                             // BR-18
const MAX_RETURNS = 2;                                               // BR-19
const MIN_REASON = 10;                                               // BR-19 · A-12 A-44
const STEP_LABEL = { 1: 'ขั้นตอน 1/3 · ฝ่ายทะเบียน', 2: 'ขั้นตอน 2/3 · ฝ่ายโยธา', 3: 'ขั้นตอน 3/3 · หัวหน้าฝ่าย' }; // A-40
const ACTOR_TH = { citizen: 'ประชาชน', system: 'ระบบ' };

/** ความยาวเหตุผลหลังตัดช่องว่างหัวท้าย (A-44) */
const cleanReason = (v) => String(v == null ? '' : v).trim();
const reasonLen = (v) => Array.from(cleanReason(v)).length;

module.exports = {
  order: 50,
  register(app, ctx) {
    const { db, clock, bugs, crypto, hooks, audit, html, format, session: { guard }, errors: { HttpError, wrap } } = ctx;
    const { esc, money, maskId, timeEl, statusEl, levelEl, STATUS_TH, SERVICE_NAME, DEPT_TH } = format;
    const rules = ctx.rules;

    // ───────────── ข้อมูล ─────────────
    const CASE_SQL = `SELECT c.*, z.name AS applicant_name, z.id_last3 AS id_last3, z.id_enc AS id_enc, d.verify_code AS verify_code
      FROM cases c JOIN citizens z ON z.id = c.citizen_id LEFT JOIN documents d ON d.doc_no = c.doc_no`;

    const holidays = () => ctx.payments.holidaySet();
    const loadCase = (caseNo) => {
      const no = String(caseNo || '').trim();
      return no ? db.get(`${CASE_SQL} WHERE c.case_no = ?`, no) || null : null;
    };
    const mustCase = (caseNo) => {
      const c = loadCase(caseNo);
      if (!c) throw new HttpError(404, 'NOT_FOUND');
      return c;
    };
    const workload = (username) => db.get("SELECT COUNT(*) AS n FROM cases WHERE status = 'IN_REVIEW' AND owner = ?", username).n; // BR-18
    const level = (c, now, hol) => (typeof rules.slaLevel === 'function' ? rules.slaLevel(c, now, hol) : null);
    const stepOf = (c) => (c.service_id === 'SV-03' ? (c.step || 1) : null);
    const issuerOf = (c) => c.issuer || (c.service_id !== 'SV-01' ? c.step1_by : null) || null; // A-27
    const serviceText = (id) => `${id} ${SERVICE_NAME[id] || ''}`.trim();

    /** BR-29 · A-59: officer = แผนกตนเอง (ขั้นปัจจุบันหรือเคยผ่าน) · head = ทุกแผนก · บทบาทอื่น = ไม่ได้ */
    function staffCanViewFiles(user, c) {
      if (!user || !c || !c.case_no) return false;
      if (user.role === 'head') return true;
      if (user.role !== 'officer') return false;
      if (user.dept === 'registry') return true;                       // ทุกใบที่ชำระแล้วเข้าขั้นทะเบียนก่อนเสมอ
      if (user.dept === 'works') return c.service_id === 'SV-03' && ((c.step || 0) >= 2 || !!c.step2_by);
      return false;
    }

    /** JSON ของคำขอสำหรับเจ้าหน้าที่ (CONTRACT 6.7) · มีเฉพาะ idMasked ห้ามมี idNo */
    function caseJson(c, now = clock.nowISO(), hol = holidays()) {
      return {
        caseNo: c.case_no,
        serviceId: c.service_id,
        status: c.status,
        step: stepOf(c),
        fee: c.fee,
        paidAt: c.paid_at || null,
        dueAt: c.due_at || null,
        slaLevel: level(c, now, hol),
        owner: c.owner || null,
        returnCount: c.return_count || 0,
        closedAt: c.closed_at || null,
        applicantName: c.applicant_name,
        idMasked: maskId(c.id_last3),
        fixDeadline: c.status === 'NEED_FIX' ? c.fix_deadline || null : null,
        docNo: c.doc_no || null,
        verifyCode: c.verify_code || null,
        qty: c.qty == null ? null : c.qty,
        areaSqm: c.area_sqm == null ? null : c.area_sqm,
        receiptNo: c.receipt_no || null,
        dept: c.dept || null,
        issuer: issuerOf(c),
        approvedBy: c.approved_by || null,
        cancelledAt: c.cancelled_at || null,
      };
    }

    /** แถวคิว (A-34) เรียง BR-16: กำหนดเสร็จเร็วก่อน · เท่ากันเลขคำขอน้อยก่อน */
    function queueCases(user, filter) {
      const p = [];
      let where = `c.case_no IS NOT NULL AND c.status IN (${QUEUE_STATUSES.map(() => '?').join(',')})`;
      p.push(...QUEUE_STATUSES);
      if (user.role === 'officer') { where += ' AND c.dept = ?'; p.push(user.dept || '-'); } else where += " AND c.dept IN ('registry','works')";
      if (filter === 'unclaimed') where += " AND c.status IN ('SUBMITTED','IN_REVIEW') AND c.owner IS NULL";
      else if (filter === 'mine') { where += " AND c.status = 'IN_REVIEW' AND c.owner = ?"; p.push(user.username); }
      return db.all(`${CASE_SQL} WHERE ${where} ORDER BY c.due_at ASC, c.case_no ASC`, ...p);
    }
    function queueItem(c, now, hol) {
      const it = {
        caseNo: c.case_no,
        serviceId: c.service_id,
        serviceName: SERVICE_NAME[c.service_id] || '',
        applicantName: c.applicant_name,
        idMasked: maskId(c.id_last3),
        status: c.status,
        step: stepOf(c),
        dept: c.dept,
        owner: c.status === 'APPROVED' ? null : c.owner || null,
        dueAt: c.due_at,
        slaLevel: level(c, now, hol),
      };
      if (bugs.on('B09')) it.idNo = crypto.decrypt(c.id_enc); // BUG B09: API คิวส่งเลขบัตรเต็ม (หน้าจอยังปิดบัง)
      return it;
    }
    const pendingApprovals = () => db.all(`${CASE_SQL} WHERE c.case_no IS NOT NULL AND c.status = 'PENDING_APPROVAL' ORDER BY c.due_at ASC, c.case_no ASC`);

    // ───────────── ตัวช่วยเขียน ─────────────
    function updateCase(id, sets) {
      const keys = Object.keys(sets);
      db.run(`UPDATE cases SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => sets[k]), id);
    }
    const event = (caseId, time, ev, actor, text) =>
      db.run('INSERT INTO case_events(case_id, time, event, actor, text) VALUES (?,?,?,?,?)', caseId, time, ev, actor, text || '');

    /** ผู้ถือเรื่อง (A-28): แผนกเดียวกัน → สถานะ IN_REVIEW → เป็นผู้ถือ */
    function assertHolder(c, user) {
      if (user.role !== 'officer' || (c.dept && c.dept !== user.dept)) throw new HttpError(403, 'FORBIDDEN');
      if (c.status !== 'IN_REVIEW') throw new HttpError(409, 'INVALID_STATE');
      if (c.owner !== user.username) throw new HttpError(403, 'FORBIDDEN');
    }
    /** อำนาจตัดสิน (BR-21 · A-28): SV-01 ผู้ถือเรื่อง (officer) · SV-02/03 head ที่ PENDING_APPROVAL */
    function assertDecider(c, user, { approve = false } = {}) {
      if (c.service_id === 'SV-01') {
        if (user.role !== 'officer') throw new HttpError(403, 'FORBIDDEN');   // หัวหน้าอนุมัติแทน SV-01 ไม่ได้
        assertHolder(c, user);
        return;
      }
      if (user.role === 'head') {
        if (c.status !== 'PENDING_APPROVAL') throw new HttpError(409, 'INVALID_STATE');
        return;
      }
      if (approve && bugs.on('B07')) { // BUG B07: API อนุมัติไม่เช็กอำนาจ เจ้าหน้าที่อนุมัติ SV-02/03 เองได้ (ปุ่มยังซ่อน)
        if (!['IN_REVIEW', 'PENDING_APPROVAL'].includes(c.status)) throw new HttpError(409, 'INVALID_STATE');
        return;
      }
      throw new HttpError(403, 'FORBIDDEN');
    }

    // ───────────── hooks ให้โมดูลอื่น ─────────────
    hooks.provide('staffCanViewFiles', staffCanViewFiles);
    hooks.provide('staffCaseJson', (caseNo) => { const c = loadCase(caseNo); return c ? caseJson(c) : null; });
    hooks.provide('officerWorkload', workload);

    // ═════════════ API ═════════════
    app.get('/api/officer/queue', guard.api('officer', 'head'), wrap((req, res) => {
      const filter = FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
      const now = clock.nowISO();
      const hol = holidays();
      const items = queueCases(req.user, filter).map((c) => queueItem(c, now, hol));
      const out = { filter, items };
      if (req.user.role === 'officer') out.workload = workload(req.user.username);
      res.json(out);
    }));

    app.get('/api/head/approvals', guard.api('head'), wrap((req, res) => {
      const now = clock.nowISO();
      const hol = holidays();
      res.json({ items: pendingApprovals().map((c) => queueItem(c, now, hol)) });
    }));

    app.get('/api/officer/cases/:caseNo', guard.api('officer', 'head'), wrap((req, res) => {
      res.json(caseJson(mustCase(req.params.caseNo)));
    }));

    // BR-17 BR-18 · CONTRACT 6.3 ลำดับตรวจ: สิทธิ์ → ALREADY_CLAIMED → WORKLOAD_LIMIT
    app.post('/api/officer/cases/:caseNo/claim', guard.api('officer'), wrap((req, res) => {
      const user = req.user;
      const out = db.tx(() => {
        const c = mustCase(req.params.caseNo);
        if (c.dept && c.dept !== user.dept) throw new HttpError(403, 'FORBIDDEN');             // ข้ามแผนก (A-28)
        if (!CLAIMABLE.includes(c.status) || !c.dept) throw new HttpError(409, 'INVALID_STATE'); // A-62: ยกเลิกไปแล้ว
        if (c.owner && !bugs.on('B08')) throw new HttpError(409, 'ALREADY_CLAIMED');           // BUG B08: ข้ามการตรวจผู้ถือ
        if (workload(user.username) >= MAX_WORKLOAD) throw new HttpError(409, 'WORKLOAD_LIMIT');
        const now = clock.nowISO();
        const sets = { status: 'IN_REVIEW', owner: user.username, updated_at: now };
        if (c.dept === 'registry') {
          sets.issuer = user.username;                                  // A-27: ทะเบียนที่รับเรื่องขั้นแรก (SV-01 ยืนยันอีกครั้งตอนอนุมัติ)
          if (c.service_id !== 'SV-01') sets.step1_by = user.username;
          if (c.service_id === 'SV-03' && !c.step) sets.step = 1;
        } else if (c.dept === 'works') {
          sets.step2_by = user.username;
        }
        updateCase(c.id, sets);
        event(c.id, now, 'CLAIM', user.username, `รับเรื่องโดย ${user.username}`);
        audit.log(user, 'CLAIM', { caseNo: c.case_no, from: c.status, to: 'IN_REVIEW' });
        return { owner: user.username, status: 'IN_REVIEW', workload: workload(user.username) };
      });
      res.json(out);
    }));

    // BR-19: ≤ 2 ครั้ง · เหตุผล ≥ 10 ตัวอักษรหลังตัดช่องว่าง
    app.post('/api/officer/cases/:caseNo/return', guard.api('officer'), wrap((req, res) => {
      const user = req.user;
      const out = db.tx(() => {
        const c = mustCase(req.params.caseNo);
        assertHolder(c, user);
        if ((c.return_count || 0) >= MAX_RETURNS && !bugs.on('B12')) throw new HttpError(409, 'RETURN_LIMIT'); // BUG B12: ครั้งที่ 3 ได้
        const reason = cleanReason(req.body && req.body.reason);
        if (reasonLen(reason) < MIN_REASON) throw new HttpError(400, 'REASON_TOO_SHORT');
        const now = clock.nowISO();
        const n = (c.return_count || 0) + 1;
        const fixDeadline = typeof rules.fixDeadline === 'function' ? rules.fixDeadline(now) : clock.toISO(clock.parse(now) + 168 * 3600 * 1000);
        updateCase(c.id, { status: 'NEED_FIX', return_count: n, need_fix_at: now, fix_deadline: fixDeadline, updated_at: now });
        db.run('INSERT INTO case_returns(case_id, n, returned_at, returned_by, reason) VALUES (?,?,?,?,?)', c.id, n, now, user.username, reason);
        event(c.id, now, 'RETURN', user.username, `ตีกลับครั้งที่ ${n}: ${reason}`);
        audit.log(user, 'RETURN', { caseNo: c.case_no, from: 'IN_REVIEW', to: 'NEED_FIX', detail: reason });
        return { status: 'NEED_FIX', returnCount: n, fixDeadline };
      });
      res.json(out);
    }));

    // FR-15: ส่งต่ออัตโนมัติตามเส้นทาง (ไม่มีช่องเลือกปลายทาง) · SV-01 ไม่มีการส่งต่อ
    app.post('/api/officer/cases/:caseNo/forward', guard.api('officer'), wrap((req, res) => {
      const user = req.user;
      const out = db.tx(() => {
        const c = mustCase(req.params.caseNo);
        assertHolder(c, user);
        if (c.service_id === 'SV-01') throw new HttpError(409, 'INVALID_STATE');
        const note = cleanReason(req.body && req.body.note);
        const now = clock.nowISO();
        let sets;
        let text;
        let result;
        if (c.service_id === 'SV-03' && c.dept === 'registry') {
          sets = { status: 'IN_REVIEW', dept: 'works', step: 2, owner: null, step1_by: c.step1_by || user.username };
          text = 'ส่งต่อฝ่ายโยธา (ขั้นตอน 2/3)';
          result = { status: 'IN_REVIEW', step: 2 };
        } else {
          sets = { status: 'PENDING_APPROVAL', dept: 'head', owner: null, step: c.service_id === 'SV-03' ? 3 : null };
          if (c.dept === 'works') sets.step2_by = c.step2_by || user.username;
          else sets.step1_by = c.step1_by || user.username;
          text = 'ส่งต่อหัวหน้าฝ่ายพิจารณาอนุมัติ';
          result = c.service_id === 'SV-03' ? { status: 'PENDING_APPROVAL', step: 3 } : { status: 'PENDING_APPROVAL' };
        }
        sets.updated_at = now;
        updateCase(c.id, sets);
        event(c.id, now, 'FORWARD', user.username, note ? `${text} · หมายเหตุ: ${note}` : text);
        audit.log(user, 'FORWARD', { caseNo: c.case_no, from: c.status, to: sets.status, detail: note });
        return result;
      });
      res.json(out);
    }));

    // FR-16 BR-21: อนุมัติตามอำนาจ
    app.post('/api/cases/:caseNo/approve', guard.api('officer', 'head'), wrap((req, res) => {
      const user = req.user;
      const out = db.tx(() => {
        const c = mustCase(req.params.caseNo);
        assertDecider(c, user, { approve: true });
        const now = clock.nowISO();
        const issuer = c.service_id === 'SV-01' ? user.username : issuerOf(c) || (user.role === 'officer' ? user.username : null);
        updateCase(c.id, { status: 'APPROVED', approved_by: user.username, approved_at: now, owner: null, dept: 'registry', issuer, updated_at: now });
        event(c.id, now, 'APPROVE', user.username, 'อนุมัติ · รอออกเอกสาร');
        audit.log(user, 'APPROVE', { caseNo: c.case_no, from: c.status, to: 'APPROVED' });
        return { status: 'APPROVED' };
      });
      res.json(out);
    }));

    app.post('/api/cases/:caseNo/reject', guard.api('officer', 'head'), wrap((req, res) => {
      const user = req.user;
      const out = db.tx(() => {
        const c = mustCase(req.params.caseNo);
        assertDecider(c, user);
        const reason = cleanReason(req.body && req.body.reason);
        if (reasonLen(reason) < MIN_REASON) throw new HttpError(400, 'REASON_TOO_SHORT');
        const now = clock.nowISO();
        const sets = { status: 'REJECTED', closed_at: now, owner: null, dept: null, updated_at: now };
        if (c.service_id === 'SV-01') sets.issuer = user.username;
        updateCase(c.id, sets);
        event(c.id, now, 'REJECT', user.username, `ไม่อนุมัติ: ${reason}`);
        audit.log(user, 'REJECT', { caseNo: c.case_no, from: c.status, to: 'REJECTED', detail: reason });
        return { status: 'REJECTED', closedAt: now };
      });
      res.json(out);
    }));

    // FR-17 · A-27: ผู้ออกเอกสาร = ทะเบียนที่รับเรื่องขั้นแรก (SV-01 = ผู้อนุมัติ) · เอกสารสร้างโดย hooks 'issueDocument' (B06)
    app.post('/api/officer/cases/:caseNo/issue', guard.api('officer'), wrap((req, res) => {
      const user = req.user;
      const out = db.tx(() => {
        const c = mustCase(req.params.caseNo);
        if (c.dept && c.dept !== user.dept) throw new HttpError(403, 'FORBIDDEN');
        if (c.status !== 'APPROVED') throw new HttpError(409, 'INVALID_STATE');
        if (issuerOf(c) !== user.username) throw new HttpError(403, 'FORBIDDEN');
        const issueDocument = hooks.use('issueDocument');
        if (typeof issueDocument !== 'function') throw new HttpError(500, 'INTERNAL', 'ระบบออกเอกสารยังไม่พร้อม');
        const doc = issueDocument(c, user);
        const now = clock.nowISO();
        updateCase(c.id, { status: 'COMPLETED', closed_at: now, owner: null, dept: null, doc_no: doc.docNo, updated_at: now });
        event(c.id, now, 'ISSUE', user.username, `ออกเอกสาร ${doc.docNo} · เสร็จสิ้น`);
        audit.log(user, 'ISSUE', { caseNo: c.case_no, from: 'APPROVED', to: 'COMPLETED', detail: doc.docNo });
        return { docNo: doc.docNo, verifyCode: doc.verifyCode, status: 'COMPLETED' };
      });
      res.json(out);
    }));

    // FR-21 BR-24 · A-32: เหตุผลไม่ว่าง (หลังตัดช่องว่าง) · ผิด = ไม่แสดงและไม่บันทึก
    app.post('/api/officer/cases/:caseNo/unmask', guard.api('officer', 'head'), wrap((req, res) => {
      const c = mustCase(req.params.caseNo);
      const reason = cleanReason(req.body && req.body.reason);
      if (!reason) throw new HttpError(400, 'REASON_REQUIRED');
      const idNo = crypto.decrypt(c.id_enc);
      if (!bugs.on('B11')) audit.log(req.user, 'UNMASK', { caseNo: c.case_no, detail: reason }); // BUG B11: ไม่ลง Audit
      res.json({ idNo });
    }));

    // GET /api/cases/:caseNo · /api/cases/:caseNo/files · /api/files/:fileId เป็นของ B04 (citizen.js order 40 · ฝั่งเจ้าหน้าที่ใช้กติกา BR-29 เดียวกัน)
    // หน้าคำขอของเจ้าหน้าที่ใช้ hooks 'caseFileAccess' ของ B04 ถ้ามี (แหล่งความจริงเดียว) ไม่งั้นใช้ staffCanViewFiles ด้านบน
    function canViewFiles(user, c) {
      const b04 = hooks.use('caseFileAccess');
      if (typeof b04 !== 'function') return staffCanViewFiles(user, c);
      try { return b04(user, c) === true; } catch (_) { return false; }
    }

    // ═════════════ หน้า ═════════════
    const STYLE = `<style>
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.card{background:#fff;border:1px solid #d1d5db;border-radius:8px;padding:1rem;margin:1rem 0}
.card h2{margin:.2rem 0 .6rem;font-size:1.15rem}
.muted{color:#4b5563}
.case-dl{display:grid;grid-template-columns:minmax(7rem,max-content) 1fr;gap:.35rem 1rem;margin:0}
.case-dl dt{font-weight:600}.case-dl dd{margin:0;overflow-wrap:anywhere}
@media (max-width:480px){.case-dl{grid-template-columns:1fr}.case-dl dd{margin-bottom:.4rem}}
.bar{display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;align-items:flex-end}
.bar label{margin:0 0 .25rem}
.actions{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:.5rem 0}
.action-group{border:1px solid #d1d5db;border-radius:8px;padding:.75rem;margin:.75rem 0}
.action-group legend{font-weight:700;padding:0 .3rem}
.action-group textarea,.action-group input[type=text]{width:100%}
.btn-danger{background:#9b1c1c;border-color:#9b1c1c}
.btn-light{background:#fff;color:#0f3d6e}
.timeline{margin:0;padding-left:1.2rem}.timeline li{margin:.25rem 0}
.doc-list{margin:0;padding-left:1.2rem}.doc-list li{margin:.3rem 0}
.doc-qr svg{max-width:180px;height:auto}
.step{display:block;font-size:.85rem}
#full-id-wrap{font-weight:700}
</style>`;

    // ---------- /officer/queue (CONTRACT 2.7) ----------
    app.get('/officer/queue', guard.page('officer', 'head'), wrap((req, res) => {
      const user = req.user;
      const isOfficer = user.role === 'officer';
      const filter = FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
      const now = clock.nowISO();
      const hol = holidays();
      const rows = queueCases(user, 'all').map((c) => {
        const lv = level(c, now, hol) || 'normal';
        const owner = c.status === 'APPROVED' ? '' : c.owner || '';
        const canClaim = isOfficer && c.dept === user.dept && CLAIMABLE.includes(c.status) && !c.owner;
        const hint = c.status === 'APPROVED'
          ? `<span class="muted step">รอออกเอกสาร${issuerOf(c) ? ` · ${esc(issuerOf(c))}` : ''}</span>`
          : owner ? '' : '<span class="muted step">ยังไม่มีผู้รับ</span>';
        const step = stepOf(c) ? `<span class="muted step">${esc(STEP_LABEL[stepOf(c)])}</span>` : '';
        return `<tr data-testid="queue-row" data-case-no="${esc(c.case_no)}" data-owner="${esc(owner)}" data-status="${esc(c.status)}" data-sla-level="${esc(lv)}">
<td data-testid="row-case-no"><a href="/officer/cases/${encodeURIComponent(c.case_no)}">${esc(c.case_no)}</a></td>
<td><span data-testid="row-service">${esc(serviceText(c.service_id))}</span>${step}</td>
<td data-testid="row-applicant">${esc(c.applicant_name)}</td>
<td data-testid="row-id-masked">${esc(maskId(c.id_last3))}</td>
<td>${statusEl(c.status, 'row-status')}</td>
<td>${timeEl(c.due_at, 'row-due')}</td>
<td>${levelEl(lv, 'row-sla-level')}</td>
<td><span data-testid="row-owner">${esc(owner)}</span>${hint}</td>
<td>${canClaim ? `<button type="button" data-testid="claim-btn" data-case-no="${esc(c.case_no)}">รับเรื่อง</button>` : ''}</td>
</tr>`;
      }).join('\n');
      const opt = (v, t) => `<option value="${v}"${v === filter ? ' selected' : ''}>${t}</option>`;
      const title = isOfficer ? `คิวงาน · ${DEPT_TH[user.dept] || user.dept}` : 'คิวงานทุกแผนก (อ่านอย่างเดียว)';
      const body = `<h1>${esc(title)}</h1>
<div class="bar">
  <div><label for="queue-filter">ตัวกรองคิว</label>
  <select id="queue-filter" data-testid="queue-filter">${opt('all', 'ทั้งหมด')}${opt('unclaimed', 'ยังไม่มีผู้รับ')}${opt('mine', 'ของฉัน')}</select></div>
  ${isOfficer ? `<p class="workload">งานในมือของฉัน: <strong data-testid="workload-count" id="workload-count">${workload(user.username)}</strong> / ${MAX_WORKLOAD} เรื่อง</p>` : '<p class="muted">หัวหน้าฝ่ายดูคิวได้อย่างเดียว · อนุมัติที่หน้า <a href="/head/approvals">รออนุมัติ</a></p>'}
</div>
<p data-testid="action-error" role="alert" hidden></p>
<div class="table-wrap">
<table data-testid="queue-table">
<caption class="sr-only">คิวงาน เรียงตามกำหนดเสร็จ</caption>
<thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">ผู้ยื่น</th><th scope="col">เลขบัตร</th><th scope="col">สถานะ</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับเตือน</th><th scope="col">ผู้ถือเรื่อง</th><th scope="col">ดำเนินการ</th></tr></thead>
<tbody id="queue-body">
${rows}
</tbody>
</table>
</div>
<div id="queue-empty-slot"></div>`;
      const scripts = `<script>
(function () {
  var ME = ${JSON.stringify(user.username).replace(/</g, '\\u003c')};
  var TH = ${JSON.stringify({ SUBMITTED: STATUS_TH.SUBMITTED, IN_REVIEW: STATUS_TH.IN_REVIEW, APPROVED: STATUS_TH.APPROVED })};
  var sel = document.getElementById('queue-filter');
  var tbody = document.getElementById('queue-body');
  var slot = document.getElementById('queue-empty-slot');
  var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr[data-testid="queue-row"]'));
  function match(tr, f) {
    var s = tr.getAttribute('data-status'), o = tr.getAttribute('data-owner');
    if (f === 'unclaimed') return (s === 'SUBMITTED' || s === 'IN_REVIEW') && !o;
    if (f === 'mine') return s === 'IN_REVIEW' && o === ME;
    return true;
  }
  function apply() {
    var f = sel.value, n = 0;
    rows.forEach(function (tr) {
      if (match(tr, f)) { tbody.appendChild(tr); n++; } else if (tr.parentNode) { tr.parentNode.removeChild(tr); }
    });
    var empty = document.querySelector('[data-testid="queue-empty"]');
    if (!n && !empty) { empty = document.createElement('p'); empty.setAttribute('data-testid', 'queue-empty'); empty.textContent = 'ไม่มีงานในคิว'; slot.appendChild(empty); }
    else if (n && empty) { empty.parentNode.removeChild(empty); }
    try { var u = new URL(location.href); if (f === 'all') u.searchParams.delete('filter'); else u.searchParams.set('filter', f); history.replaceState(null, '', u.toString()); } catch (e) {}
  }
  function setRow(tr, owner, status) {
    tr.setAttribute('data-owner', status === 'APPROVED' ? '' : (owner || ''));
    tr.setAttribute('data-status', status);
    var o = tr.querySelector('[data-testid="row-owner"]'); if (o) o.textContent = status === 'APPROVED' ? '' : (owner || '');
    var hint = o && o.parentNode.querySelector('.muted'); if (hint && owner) hint.parentNode.removeChild(hint);
    var st = tr.querySelector('[data-testid="row-status"]');
    if (st) { st.textContent = TH[status] || status; st.setAttribute('data-status', status); st.className = 'badge st-' + status; }
    if (owner || status === 'APPROVED') { var b = tr.querySelector('[data-testid="claim-btn"]'); if (b) b.parentNode.removeChild(b); }
  }
  async function refreshRow(tr, no) {
    try {
      var r = await api('GET', '/api/officer/queue?filter=all');
      var it = r.ok && r.data && r.data.items.filter(function (x) { return x.caseNo === no; })[0];
      if (it) setRow(tr, it.owner, it.status);
    } catch (e) {}
  }
  sel.addEventListener('change', apply);
  apply();
  tbody.addEventListener('click', async function (ev) {
    var b = ev.target.closest('[data-testid="claim-btn"]');
    if (!b || b.disabled) return;
    var no = b.getAttribute('data-case-no'), tr = b.closest('tr');
    showError('');
    b.disabled = true;
    var r;
    try { r = await api('POST', '/api/officer/cases/' + encodeURIComponent(no) + '/claim'); } catch (e) { r = { ok: false, data: null }; }
    if (r.ok) {
      setRow(tr, r.data.owner, r.data.status || 'IN_REVIEW');
      var wl = document.getElementById('workload-count');
      if (wl && r.data.workload != null) wl.textContent = String(r.data.workload);
      toast('รับเรื่อง ' + no + ' แล้ว');
      apply();
    } else {
      b.disabled = false;
      showError((r.data && r.data.message) || 'เกิดข้อผิดพลาด กรุณาลองใหม่');
      if (r.data && (r.data.code === 'ALREADY_CLAIMED' || r.data.code === 'INVALID_STATE')) refreshRow(tr, no);
    }
  });
})();
</script>`;
      html.send(req, res, { title: 'คิวงาน', body, head: STYLE, scripts });
    }));

    // ---------- /head/approvals (CONTRACT 2.8) ----------
    app.get('/head/approvals', guard.page('head'), wrap((req, res) => {
      const now = clock.nowISO();
      const hol = holidays();
      const list = pendingApprovals();
      const rows = list.map((c) => {
        const lv = level(c, now, hol) || 'normal';
        const step = stepOf(c) ? `<span class="muted step">${esc(STEP_LABEL[stepOf(c)])}</span>` : '';
        return `<tr data-testid="approval-row" data-case-no="${esc(c.case_no)}" data-sla-level="${esc(lv)}">
<td data-testid="row-case-no">${esc(c.case_no)}</td>
<td><span data-testid="row-service">${esc(serviceText(c.service_id))}</span>${step}</td>
<td data-testid="row-applicant">${esc(c.applicant_name)}</td>
<td>${timeEl(c.due_at, 'row-due')}</td>
<td>${levelEl(lv, 'row-sla-level')}</td>
<td><a data-testid="approval-open" href="/officer/cases/${encodeURIComponent(c.case_no)}">เปิดคำขอ</a></td>
</tr>`;
      }).join('\n');
      const body = `<h1>รายการรออนุมัติ</h1>
<p class="muted">คำขอ SV-02 / SV-03 ที่ผ่านการตรวจของแผนกแล้ว เรียงตามกำหนดเสร็จ</p>
<div class="table-wrap">
<table data-testid="approval-table">
<caption class="sr-only">รายการรออนุมัติ</caption>
<thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">ผู้ยื่น</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับเตือน</th><th scope="col">ดำเนินการ</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
${list.length ? '' : '<p data-testid="approvals-empty">ไม่มีคำขอรออนุมัติ</p>'}`;
      html.send(req, res, { title: 'รายการรออนุมัติ', body, head: STYLE });
    }));

    // ---------- /officer/cases/:caseNo (CONTRACT 2.6 ฝั่งเจ้าหน้าที่) ----------
    app.get('/officer/cases/:caseNo', guard.page('officer', 'head'), wrap((req, res) => {
      const user = req.user;
      const c = loadCase(req.params.caseNo);
      if (!c) return html.notFound(req, res);
      const now = clock.nowISO();
      const hol = holidays();
      const lv = level(c, now, hol);
      const isOfficer = user.role === 'officer';
      const svc = c.service_id;
      const holder = isOfficer && c.dept === user.dept && c.status === 'IN_REVIEW' && c.owner === user.username;
      const can = {
        claim: isOfficer && c.dept === user.dept && CLAIMABLE.includes(c.status) && !c.owner,
        ret: holder && ((c.return_count || 0) < MAX_RETURNS || bugs.on('B12')),   // BR-19: ครบ 2 ครั้ง → ไม่ render (B12: ยังแสดง)
        forward: holder && svc !== 'SV-01',
        approve: svc === 'SV-01' ? holder : user.role === 'head' && c.status === 'PENDING_APPROVAL',
        issue: isOfficer && c.status === 'APPROVED' && (!c.dept || c.dept === user.dept) && issuerOf(c) === user.username,
      };
      can.reject = can.approve;

      const svcRow = db.get('SELECT docs FROM services WHERE id = ?', svc);
      let docNames = {};
      try { docNames = Object.fromEntries(JSON.parse((svcRow && svcRow.docs) || '[]').map((d) => [d.key, d.name])); } catch (_) { docNames = {}; }
      const detail = svc === 'SV-01' ? `${c.qty || 1} ฉบับ` : svc === 'SV-03' ? `พื้นที่ ${c.area_sqm} ตร.ม.` : '–';

      const timeline = db.all('SELECT * FROM case_events WHERE case_id = ? ORDER BY time ASC, id ASC', c.id).map((e) => {
        const who = e.actor ? ACTOR_TH[e.actor] || e.actor : '';
        return `<li data-testid="timeline-item" data-iso="${esc(e.time)}" data-event="${esc(e.event)}">${timeEl(e.time)} · ${esc(e.text || e.event)}${who ? ` <span class="muted">(${esc(who)})</span>` : ''}</li>`;
      }).join('');

      let filesHtml;
      if (canViewFiles(user, c)) {
        const files = db.all('SELECT file_id, name, doc_key, size FROM case_files WHERE case_id = ? ORDER BY file_id', c.id);
        filesHtml = files.length
          ? `<ul class="doc-list" data-testid="doc-list">${files.map((f) => `<li data-testid="doc-item" data-name="${esc(f.name)}" data-file-id="${esc(f.file_id)}" data-doc-key="${esc(f.doc_key)}">${esc(docNames[f.doc_key] || f.doc_key)} · ${esc(f.name)} <span class="muted">(${Number(f.size).toLocaleString('en-US')} ไบต์)</span> <a data-testid="doc-download-link" href="/api/files/${encodeURIComponent(f.file_id)}" download="${esc(f.name)}">ดาวน์โหลด<span class="sr-only"> ${esc(f.name)}</span></a></li>`).join('')}</ul>`
          : '<p class="muted">ไม่มีไฟล์แนบ</p>';
      } else {
        filesHtml = '<p class="muted" data-testid="doc-forbidden">ไม่มีสิทธิ์เปิดไฟล์แนบของคำขอนี้ (เฉพาะแผนกที่คำขอผ่านมาแล้ว)</p>';
      }

      let docHtml = '';
      if (c.doc_no) {
        const qr = hooks.use('docQrHtml');
        docHtml = `<section class="card" aria-labelledby="h-doc"><h2 id="h-doc">เอกสารดิจิทัล</h2>
<dl class="case-dl"><dt>เลขเอกสาร</dt><dd data-testid="doc-no">${esc(c.doc_no)}</dd>
<dt>รหัสตรวจสอบ</dt><dd data-testid="verify-code">${esc(c.verify_code || '')}</dd></dl>
${c.verify_code && typeof qr === 'function' ? qr(req, c.verify_code) : ''}</section>`;
      }

      const lastReturn = c.status === 'NEED_FIX' ? db.get('SELECT reason FROM case_returns WHERE case_id = ? ORDER BY n DESC LIMIT 1', c.id) : null;

      const actions = [];
      if (can.claim) actions.push('<div class="actions"><button type="button" data-testid="claim-btn">รับเรื่อง</button></div>');
      if (can.approve) actions.push('<div class="actions"><button type="button" data-testid="approve-btn">อนุมัติ</button></div>');
      if (can.forward) {
        actions.push(`<fieldset class="action-group"><legend>ผ่านการตรวจและส่งต่อ (ระบบเลือกปลายทางตามเส้นทางของบริการ)</legend>
<label for="forward-note">หมายเหตุส่งต่อ (ไม่บังคับ)</label>
<textarea id="forward-note" data-testid="forward-note" rows="2"></textarea>
<div class="actions"><button type="button" data-testid="forward-btn">ผ่าน/ส่งต่อ</button></div></fieldset>`);
      }
      if (can.ret) {
        actions.push(`<fieldset class="action-group"><legend>ส่งกลับให้ประชาชนแก้ไข (ครั้งที่ ${(c.return_count || 0) + 1} จาก ${MAX_RETURNS})</legend>
<label for="return-reason">เหตุผล (อย่างน้อย ${MIN_REASON} ตัวอักษร)</label>
<textarea id="return-reason" data-testid="return-reason" rows="2" aria-describedby="return-reason-error"></textarea>
<p id="return-reason-error" data-testid="return-reason-error" role="alert" hidden></p>
<div class="actions"><button type="button" class="btn-danger" data-testid="return-btn">ตีกลับ</button>
<button type="button" class="btn-light" data-testid="return-submit">ยืนยัน</button></div></fieldset>`);
      }
      if (can.reject) {
        actions.push(`<fieldset class="action-group"><legend>ผลพิจารณา: ไม่ผ่าน</legend>
<label for="reject-reason">เหตุผลที่ไม่อนุมัติ (อย่างน้อย ${MIN_REASON} ตัวอักษร)</label>
<textarea id="reject-reason" data-testid="reject-reason" rows="2" aria-describedby="reject-reason-error"></textarea>
<p id="reject-reason-error" data-testid="reject-reason-error" role="alert" hidden></p>
<div class="actions"><button type="button" class="btn-danger" data-testid="reject-btn">ไม่อนุมัติ</button>
<button type="button" class="btn-light" data-testid="reject-submit">ยืนยัน</button></div></fieldset>`);
      }
      if (can.issue) actions.push('<div class="actions"><button type="button" data-testid="issue-btn">ออกเอกสาร</button></div>');
      if (!actions.length) {
        const why = user.role === 'head' && c.status !== 'PENDING_APPROVAL' ? 'หัวหน้าฝ่ายดูได้อย่างเดียวในขั้นนี้' : 'ไม่มีรายการที่คุณดำเนินการได้ในขั้นนี้';
        actions.push(`<p class="muted">${why}</p>`);
      }

      const owner = c.owner && c.status !== 'APPROVED' ? c.owner : '';
      const body = `<div id="officer-case" data-case-no="${esc(c.case_no)}">
<h1>คำขอ <span data-testid="case-no">${esc(c.case_no)}</span></h1>
<p data-testid="action-error" role="alert" hidden></p>
<section class="card" aria-labelledby="h-info"><h2 id="h-info">ข้อมูลคำขอ</h2>
<dl class="case-dl">
<dt>สถานะ</dt><dd>${statusEl(c.status)}</dd>
<dt>บริการ</dt><dd data-testid="case-service">${esc(serviceText(svc))}</dd>
${svc === 'SV-03' ? `<dt>ขั้นตอน</dt><dd data-testid="case-step">${esc(STEP_LABEL[stepOf(c)] || '')}</dd>` : ''}
<dt>รายละเอียด</dt><dd>${esc(detail)}</dd>
<dt>ค่าธรรมเนียม</dt><dd data-testid="case-fee">${esc(money(c.fee))}</dd>
<dt>ผู้ยื่น</dt><dd data-testid="applicant-name">${esc(c.applicant_name)}</dd>
<dt>เลขบัตรประชาชน</dt><dd><span data-testid="applicant-id">${esc(maskId(c.id_last3))}</span>
 <span id="full-id-wrap"></span>
 <button type="button" class="btn-light" data-testid="show-full-id-btn" aria-controls="unmask-form">แสดงเลขเต็ม</button>
 <form id="unmask-form" class="action-group" hidden novalidate>
  <label for="unmask-reason">เหตุผลที่ต้องดูเลขบัตรเต็ม (บันทึกใน Audit)</label>
  <input type="text" id="unmask-reason" data-testid="unmask-reason" autocomplete="off" aria-describedby="unmask-error">
  <p id="unmask-error" data-testid="unmask-error" role="alert" hidden></p>
  <div class="actions"><button type="submit" data-testid="unmask-submit">ยืนยัน</button></div>
 </form></dd>
<dt>ชำระเมื่อ</dt><dd>${timeEl(c.paid_at, 'paid-at')}</dd>
<dt>กำหนดเสร็จ</dt><dd>${timeEl(c.due_at, 'sla-due')}</dd>
<dt>ระดับเตือน</dt><dd>${lv ? levelEl(lv) : '<span data-testid="sla-level">–</span>'}</dd>
${['COMPLETED', 'REJECTED'].includes(c.status) ? `<dt>ปิดงานเมื่อ</dt><dd>${timeEl(c.closed_at, 'closed-at')}</dd>` : ''}
${c.status === 'CANCELLED' ? `<dt>ยกเลิกเมื่อ</dt><dd>${timeEl(c.cancelled_at, 'cancelled-at')}</dd>` : ''}
<dt>ผู้ถือเรื่อง</dt><dd data-testid="case-owner">${esc(owner || 'ยังไม่มีผู้รับ')}</dd>
${c.status === 'APPROVED' && issuerOf(c) ? `<dt>ผู้ออกเอกสาร</dt><dd data-testid="case-issuer">${esc(issuerOf(c))}</dd>` : ''}
<dt>ตีกลับแล้ว</dt><dd><span data-testid="return-count">${c.return_count || 0}</span> ครั้ง (สูงสุด ${MAX_RETURNS})</dd>
${c.status === 'NEED_FIX' ? `<dt>เส้นตายแก้ไข</dt><dd>${timeEl(c.fix_deadline, 'fix-deadline')}</dd><dt>เหตุผลที่ตีกลับ</dt><dd>${esc(lastReturn ? lastReturn.reason : '')}</dd>` : ''}
${isOfficer ? `<dt>งานในมือของฉัน</dt><dd><span data-testid="workload-count">${workload(user.username)}</span> / ${MAX_WORKLOAD} เรื่อง</dd>` : ''}
</dl></section>
<section class="card" aria-labelledby="h-act"><h2 id="h-act">ดำเนินการ</h2>
${actions.join('\n')}
</section>
${docHtml}
<section class="card" aria-labelledby="h-files"><h2 id="h-files">เอกสารแนบ</h2>
${filesHtml}
</section>
<section class="card" aria-labelledby="h-tl"><h2 id="h-tl">ไทม์ไลน์</h2>
<ol class="timeline" data-testid="case-timeline">${timeline}</ol>
</section>
<p><a href="${user.role === 'head' ? '/head/approvals' : '/officer/queue'}">← กลับ${user.role === 'head' ? 'รายการรออนุมัติ' : 'คิวงาน'}</a></p>
</div>`;

      const scripts = `<script>
(function () {
  var root = document.getElementById('officer-case');
  var no = encodeURIComponent(root.getAttribute('data-case-no'));
  var P = '/api/officer/cases/' + no, A = '/api/cases/' + no;
  function q(t) { return document.querySelector('[data-testid="' + t + '"]'); }
  function on(t, fn) { var el = q(t); if (el) el.addEventListener('click', function () { if (!el.disabled) fn(el); }); }
  function clear() { ['action-error', 'return-reason-error', 'reject-reason-error'].forEach(function (t) { showMsg(t, ''); }); }
  async function post(btn, url, body, reasonErr) {
    clear();
    if (btn) btn.disabled = true;
    var r;
    try { r = await api('POST', url, body); } catch (e) { r = { ok: false, data: null }; }
    if (r.ok) { location.reload(); return; }
    if (btn) btn.disabled = false;
    var msg = (r.data && r.data.message) || 'เกิดข้อผิดพลาด กรุณาลองใหม่';
    if (reasonErr && r.data && r.data.code === 'REASON_TOO_SHORT') showMsg(reasonErr, msg); else showMsg('action-error', msg);
  }
  function val(t) { var el = q(t); return el ? el.value : ''; }
  on('claim-btn', function (b) { post(b, P + '/claim'); });
  on('forward-btn', function (b) { post(b, P + '/forward', { note: val('forward-note') }); });
  on('approve-btn', function (b) { post(b, A + '/approve'); });
  on('return-btn', function (b) { post(b, P + '/return', { reason: val('return-reason') }, 'return-reason-error'); });
  on('return-submit', function (b) { post(b, P + '/return', { reason: val('return-reason') }, 'return-reason-error'); });
  on('reject-btn', function (b) { post(b, A + '/reject', { reason: val('reject-reason') }, 'reject-reason-error'); });
  on('reject-submit', function (b) { post(b, A + '/reject', { reason: val('reject-reason') }, 'reject-reason-error'); });
  on('issue-btn', function (b) { post(b, P + '/issue'); });
  var form = document.getElementById('unmask-form');
  on('show-full-id-btn', function () { form.hidden = false; q('unmask-reason').focus(); });
  function fmt(s) { s = String(s || ''); return s.length === 13 ? s[0] + '-' + s.slice(1, 5) + '-' + s.slice(5, 10) + '-' + s.slice(10, 12) + '-' + s[12] : s; }
  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var btn = q('unmask-submit');
    if (btn.disabled) return;
    showMsg('unmask-error', ''); showMsg('action-error', '');
    btn.disabled = true;
    var r;
    try { r = await api('POST', P + '/unmask', { reason: q('unmask-reason').value }); } catch (e) { r = { ok: false, data: null }; }
    btn.disabled = false;
    if (r.ok && r.data) {
      var wrap = document.getElementById('full-id-wrap');
      var el = q('full-id');
      if (!el) { el = document.createElement('span'); el.setAttribute('data-testid', 'full-id'); wrap.appendChild(el); }
      el.textContent = fmt(r.data.idNo);
      form.hidden = true;
      q('unmask-reason').value = '';
      return;
    }
    var msg = (r.data && r.data.message) || 'เกิดข้อผิดพลาด กรุณาลองใหม่';
    showMsg(r.data && r.data.code === 'REASON_REQUIRED' ? 'unmask-error' : 'action-error', msg);
  });
})();
</script>`;
      html.send(req, res, { title: `คำขอ ${c.case_no}`, body, head: STYLE, scripts });
    }));
  },
};
