'use strict';
// [B01] seed ตาม /workspace/egov-brief/TEST-DATA.md (ทุกค่าตายตัว · A-35) · เรียกโดย reset() เท่านั้น
// ค่าถัดไปหลัง seed: EG-2569-000031 · RC-2569-000031 · DOC-2569-000001→000002 · DR-0003 · PP-0002
const db = require('./db');
const cr = require('./crypto');
const sign = require('./sign');

const T = (s) => (s ? s.replace(' ', 'T') + ':00+07:00' : null); // '2026-11-30 16:30' → ISO +07:00
const PASSWORD = 'Test@1234';

// ---------- บริการ (TEST-DATA ข้อ 2) ----------
const SERVICES = [
  { id: 'SV-01', name: 'ขอหนังสือรับรอง', fee: 20, fee_per_sqm: null, sla: 3,
    docs: [{ key: 'id-card', name: 'บัตรประชาชน', required: true }] },
  { id: 'SV-02', name: 'ขออนุญาตประกอบกิจการ', fee: 500, fee_per_sqm: null, sla: 10,
    docs: [{ key: 'id-card', name: 'บัตรประชาชน', required: true }, { key: 'map', name: 'แผนที่ตั้ง', required: true }, { key: 'site-photo', name: 'ภาพสถานที่', required: false }] },
  { id: 'SV-03', name: 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร', fee: 1000, fee_per_sqm: 10, sla: 15,
    docs: [{ key: 'id-card', name: 'บัตรประชาชน', required: true }, { key: 'plan', name: 'แบบแปลน', required: true, pdfOnly: true }, { key: 'deed', name: 'โฉนด', required: true }] },
];
const REQUIRED_FILES = { 'SV-01': ['id-card'], 'SV-02': ['id-card', 'map'], 'SV-03': ['id-card', 'plan', 'deed'] };

// ---------- วันหยุด (ข้อ 3) ----------
const HOLIDAYS = [
  ['2026-12-07', 'ชดเชยวันหยุดทดสอบ (สมมติ)'],
  ['2026-12-10', 'วันรัฐธรรมนูญทดสอบ (สมมติ)'],
  ['2026-12-31', 'วันสิ้นปีทดสอบ (สมมติ)'],
  ['2027-01-01', 'วันขึ้นปีใหม่ทดสอบ (สมมติ)'],
];

// ---------- บัญชี (ข้อ 1) ----------
const CITIZENS = [
  { key: 'somchai', idNo: '1101700123456', name: 'สมชาย ใจดี', mobile: '0812345678', registered: true },
  { key: 'somying', idNo: '3100600987659', name: 'สมหญิง รักไทย', mobile: '0823456789', registered: true },
  { key: 'mana', idNo: '5500400111221', name: 'มานะ ตั้งใจ', mobile: null, registered: false },
  { key: 'piti', idNo: '1909900555015', name: 'ปิติ มีสุข', mobile: '0834567890', registered: true },
];
const USERS = [
  ['off.reg1', 'เจ้าหน้าที่ทะเบียน 1', 'officer', 'registry'],
  ['off.reg2', 'เจ้าหน้าที่ทะเบียน 2', 'officer', 'registry'],
  ['off.works1', 'เจ้าหน้าที่โยธา 1', 'officer', 'works'],
  ['head1', 'หัวหน้าฝ่าย', 'head', ''],
  ['exec1', 'ผู้บริหาร', 'executive', ''],
  ['audit1', 'ผู้ตรวจสอบภายใน', 'auditor', ''],
  ['admin1', 'ผู้ดูแลระบบ', 'admin', ''],
];

// ---------- คำขอ 30 ใบ (ข้อ 4.1) ----------
// [seq, ป้าย, บริการ, qty|area, fee, ผู้ยื่น, สถานะ, ชำระเมื่อ, กำหนดเสร็จ, ปิด/ยกเลิก, เพิ่มเติม]
// เพิ่มเติม: owner dept step issuer step1 step2 returns needFix fix approvedBy approvedAt
const R = 'registry';
const CASES = [
  [1, 'H01', 'SV-01', 1, 20, 'somying', 'COMPLETED', '2026-10-14 10:00', '2026-10-19 16:30', '2026-10-16 14:00', { issuer: 'off.reg1' }],
  [2, 'H05', 'SV-03', 120, 1200, 'piti', 'COMPLETED', '2026-11-02 09:00', '2026-11-23 16:30', '2026-11-20 11:00', { issuer: 'off.reg1', step1: 'off.reg1', step2: 'off.works1', approvedBy: 'head1', approvedAt: '2026-11-19 15:00' }],
  [3, 'H02', 'SV-01', 2, 40, 'piti', 'COMPLETED', '2026-11-02 09:30', '2026-11-05 16:30', '2026-11-04 15:00', { issuer: 'off.reg1' }],
  [4, 'H06', 'SV-02', null, 500, 'somchai', 'COMPLETED', '2026-11-02 14:00', '2026-11-16 16:30', '2026-11-13 15:00', { issuer: 'off.reg1', step1: 'off.reg1', approvedBy: 'head1', approvedAt: '2026-11-12 15:00' }],
  [5, 'H03', 'SV-01', 1, 20, 'somchai', 'COMPLETED', '2026-11-03 11:00', '2026-11-06 16:30', '2026-11-05 10:00', { issuer: 'off.reg1', docNo: 'DOC-2569-000001' }],
  [6, 'H08', 'SV-02', null, 500, 'piti', 'COMPLETED', '2026-11-03 15:00', '2026-11-17 16:30', '2026-11-19 10:00', { issuer: 'off.reg1', step1: 'off.reg1', approvedBy: 'head1', approvedAt: '2026-11-18 15:00' }],
  [7, 'H07', 'SV-02', null, 500, 'somying', 'COMPLETED', '2026-11-04 10:00', '2026-11-18 16:30', '2026-11-18 16:00', { issuer: 'off.reg1', step1: 'off.reg1', approvedBy: 'head1', approvedAt: '2026-11-17 15:00' }],
  [8, 'H04', 'SV-01', 1, 20, 'somying', 'REJECTED', '2026-11-09 10:00', '2026-11-12 16:30', '2026-11-11 09:00', { issuer: 'off.reg1' }],
  [9, 'X01', 'SV-01', 1, 20, 'somchai', 'CANCELLED', '2026-11-09 14:30', '2026-11-12 16:30', '2026-11-09 15:00', {}],
  [10, 'W01', 'SV-03', 80, 1000, 'somying', 'IN_REVIEW', '2026-11-12 10:00', '2026-12-03 16:30', null, { dept: 'works', step: 2, issuer: 'off.reg1', step1: 'off.reg1' }],
  [11, 'P02', 'SV-03', 150, 1500, 'somchai', 'PENDING_APPROVAL', '2026-11-16 10:00', '2026-12-08 16:30', null, { dept: 'head', step: 3, issuer: 'off.reg1', step1: 'off.reg1', step2: 'off.works1' }],
  [12, 'R09', 'SV-03', 101, 1010, 'piti', 'IN_REVIEW', '2026-11-18 10:00', '2026-12-11 16:30', null, { owner: 'off.reg2', step: 1 }],
  [13, 'R01', 'SV-02', null, 500, 'somchai', 'IN_REVIEW', '2026-11-20 10:00', '2026-12-04 16:30', null, { owner: 'off.reg2' }],
  [14, 'P01', 'SV-02', null, 500, 'piti', 'PENDING_APPROVAL', '2026-11-20 11:00', '2026-12-04 16:30', null, { dept: 'head', issuer: 'off.reg1', step1: 'off.reg1' }],
  [15, 'R02', 'SV-02', null, 500, 'somying', 'IN_REVIEW', '2026-11-20 15:00', '2026-12-04 16:30', null, { owner: 'off.reg2' }],
  [16, 'R03', 'SV-02', null, 500, 'piti', 'IN_REVIEW', '2026-11-23 09:00', '2026-12-08 16:30', null, { owner: 'off.reg2' }],
  [17, 'F01', 'SV-01', 1, 20, 'somchai', 'NEED_FIX', '2026-11-23 10:00', '2026-11-27 16:30', null, { owner: 'off.reg1', returns: 2, needFix: '2026-11-27 14:00', fix: '2026-12-04 14:00' }],
  [18, 'R04', 'SV-02', null, 500, 'somchai', 'IN_REVIEW', '2026-11-24 10:00', '2026-12-09 16:30', null, { owner: 'off.reg2' }],
  [19, 'A01', 'SV-02', null, 500, 'somying', 'APPROVED', '2026-11-24 14:00', '2026-12-09 16:30', null, { owner: null, issuer: 'off.reg1', step1: 'off.reg1', approvedBy: 'head1', approvedAt: '2026-11-30 15:00' }],
  [20, 'O01', 'SV-01', 1, 20, 'somchai', 'IN_REVIEW', '2026-11-25 10:00', '2026-11-30 16:30', null, { owner: 'off.reg1' }],
  [21, 'R08', 'SV-02', null, 500, 'somying', 'IN_REVIEW', '2026-11-25 12:00', '2026-12-11 16:30', null, { owner: 'off.reg2' }],
  [22, 'N02', 'SV-01', 2, 40, 'somying', 'IN_REVIEW', '2026-11-26 10:00', '2026-12-01 16:30', null, { owner: 'off.reg1' }],
  [23, 'F02', 'SV-01', 1, 20, 'somying', 'IN_REVIEW', '2026-11-26 10:30', '2026-12-03 16:30', null, { owner: 'off.reg1', returns: 2 }],
  [24, 'N01', 'SV-01', 1, 20, 'piti', 'SUBMITTED', '2026-11-27 11:00', '2026-12-02 16:30', null, {}],
  [25, 'R05', 'SV-01', 3, 60, 'somying', 'IN_REVIEW', '2026-11-30 10:00', '2026-12-03 16:30', null, { owner: 'off.reg2' }],
  [26, 'R07', 'SV-01', 5, 100, 'somchai', 'IN_REVIEW', '2026-11-30 16:29', '2026-12-03 16:30', null, { owner: 'off.reg2' }],
  [27, 'R06', 'SV-01', 1, 20, 'piti', 'IN_REVIEW', '2026-11-30 16:30', '2026-12-04 16:30', null, { owner: 'off.reg2' }],
  [28, 'S01', 'SV-01', 1, 20, 'somying', 'SUBMITTED', '2026-12-01 08:10', '2026-12-04 16:30', null, {}],
  [29, 'S02', 'SV-01', 1, 20, 'piti', 'SUBMITTED', '2026-12-01 08:20', '2026-12-04 16:30', null, {}],
  [30, 'S03', 'SV-01', 1, 20, 'somchai', 'SUBMITTED', '2026-12-01 08:30', '2026-12-04 16:30', null, {}],
];

// ประวัติตีกลับ (ข้อ 4.4)
const RETURNS = {
  17: [['2026-11-24 11:00', '2026-11-25 10:00', 1, 'ภาพบัตรประชาชนไม่ชัด กรุณาถ่ายใหม่'], ['2026-11-27 14:00', null, null, 'ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข']],
  23: [['2026-11-27 10:00', '2026-11-30 10:00', 1, 'ภาพเอกสารเบลอ อ่านเลขไม่ได้'], ['2026-11-30 14:00', '2026-12-01 08:30', 1, 'ข้อมูลในแบบฟอร์มไม่ครบถ้วน']],
};

/** PDF จริงขนาด n ไบต์ (เหมือน make_testfiles.py ใน TEST-DATA ข้อ 11) */
function pdfBytes(n = 1024) {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  return Buffer.concat([head, Buffer.alloc(n - head.length - tail.length, 0x20), tail]);
}

function seed() {
  const PDF = pdfBytes(1024);
  const ins = (table, row) => {
    const k = Object.keys(row);
    return db.run(`INSERT INTO ${table}(${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`, ...k.map((x) => row[x]));
  };
  let fileSeq = 0;
  const addFile = (caseId, key, at) => {
    fileSeq++;
    ins('case_files', { file_id: `F-${String(fileSeq).padStart(6, '0')}`, case_id: caseId, doc_key: key, name: `${key}.pdf`, mime: 'application/pdf', size: PDF.length, data: PDF, uploaded_at: at });
  };
  const ev = (caseId, time, event, actor, text) => ins('case_events', { case_id: caseId, time, event, actor, text });

  db.tx(() => {
    for (const s of SERVICES) ins('services', { id: s.id, name: s.name, fee: s.fee, fee_per_sqm: s.fee_per_sqm, sla: s.sla, docs: JSON.stringify(s.docs) });
    for (const [date, name] of HOLIDAYS) ins('holidays', { date, name });
    for (const [username, name, role, dept] of USERS) ins('users', { username, name, role, dept, password_hash: cr.hashPassword(PASSWORD, `seed-${username}`) });

    const cid = {};
    for (const c of CITIZENS) {
      cid[c.key] = ins('citizens', {
        id_hash: cr.lookupHash(c.idNo), id_enc: cr.encrypt(c.idNo), id_last3: c.idNo.slice(-3), name: c.name,
        mobile_enc: c.mobile ? cr.encrypt(c.mobile) : null, email: '', registered: c.registered ? 1 : 0,
        consent_at: c.registered ? '2026-10-01T09:00:00+07:00' : null, registered_at: c.registered ? '2026-10-01T09:00:00+07:00' : null,
      }).lastInsertRowid;
    }

    const caseIds = {};
    for (const [seq, label, svc, qa, fee, who, status, paid, due, closed, x] of CASES) {
      const s6 = String(seq).padStart(6, '0');
      const svcDef = SERVICES.find((s) => s.id === svc);
      const open = !['COMPLETED', 'REJECTED', 'CANCELLED'].includes(status);
      const dept = !open ? null : (x.dept || R);
      const step = svc === 'SV-03' ? (x.step || (open ? 1 : 3)) : null;
      const owner = x.owner || null;
      const id = ins('cases', {
        case_no: `EG-2569-${s6}`, receipt_no: `RC-2569-${s6}`, service_id: svc, citizen_id: cid[who],
        qty: svc === 'SV-01' ? qa : null, area_sqm: svc === 'SV-03' ? qa : null, fee, sla_days: svcDef.sla,
        status, dept, step, owner,
        issuer: x.issuer || (dept === R ? owner : null), // A-27: ผู้รับเรื่องขั้นทะเบียน
        step1_by: x.step1 || (svc !== 'SV-01' && dept === R ? owner : null), step2_by: x.step2 || null,
        return_count: x.returns || 0, need_fix_at: T(x.needFix), fix_deadline: T(x.fix),
        approved_by: x.approvedBy || null, approved_at: T(x.approvedAt),
        paid_at: T(paid), due_at: T(due),
        closed_at: ['COMPLETED', 'REJECTED'].includes(status) ? T(closed) : null,
        cancelled_at: status === 'CANCELLED' ? T(closed) : null, cancel_reason: status === 'CANCELLED' ? 'citizen' : null,
        doc_no: x.docNo || null, seed_label: label, created_at: T(paid), updated_at: T(closed || paid),
      }).lastInsertRowid;
      caseIds[seq] = id;
      for (const key of REQUIRED_FILES[svc]) addFile(id, key, T(paid));

      // ไทม์ไลน์ขั้นต่ำ (โมดูลอื่นเพิ่มเหตุการณ์ใหม่เอง)
      ev(id, T(paid), 'PAID', 'citizen', 'ชำระเงินแล้ว · ส่งคำขอ');
      for (const [i, [ret, resub, , reason]] of (RETURNS[seq] || []).entries()) {
        ev(id, T(ret), 'RETURN', owner, `ตีกลับครั้งที่ ${i + 1}: ${reason}`);
        if (resub) ev(id, T(resub), 'RESUBMIT', 'citizen', 'ส่งเอกสารแก้ไขแล้ว');
      }
      if (x.approvedAt) ev(id, T(x.approvedAt), 'APPROVE', x.approvedBy, 'อนุมัติ');
      if (status === 'COMPLETED') ev(id, T(closed), 'ISSUE', x.issuer, 'ออกเอกสาร · เสร็จสิ้น');
      if (status === 'REJECTED') ev(id, T(closed), 'REJECT', x.issuer, 'ไม่อนุมัติ');
      if (status === 'CANCELLED') ev(id, T(closed), 'CANCEL', 'citizen', 'ประชาชนยกเลิกคำขอ');
    }
    for (const [seq, list] of Object.entries(RETURNS)) {
      const owner = CASES.find((c) => c[0] === Number(seq))[10].owner;
      list.forEach(([ret, resub, paused, reason], i) => ins('case_returns', {
        case_id: caseIds[seq], n: i + 1, returned_at: T(ret), returned_by: owner, reason, resubmitted_at: T(resub), paused_days: paused,
      }));
    }

    // ---------- ร่างของสมชาย (ข้อ 4.2) ----------
    const now0 = '2026-12-01T08:50:00+07:00';
    ins('cases', { draft_id: 'DR-0001', service_id: 'SV-01', citizen_id: cid.somchai, qty: 2, fee: 40, status: 'DRAFT', created_at: '2026-11-30T09:00:00+07:00', updated_at: '2026-11-30T09:00:00+07:00', seed_label: 'DR-0001' });
    const d2 = ins('cases', { draft_id: 'DR-0002', service_id: 'SV-02', citizen_id: cid.somchai, fee: 500, status: 'PENDING_PAYMENT', created_at: now0, updated_at: '2026-12-01T08:55:00+07:00', seed_label: 'DR-0002' }).lastInsertRowid;
    addFile(d2, 'id-card', now0); addFile(d2, 'map', now0);
    ins('payments', { ref: 'PP-0001', case_id: d2, amount: 500, status: 'PENDING', qr_created_at: '2026-12-01T08:55:00+07:00', qr_expires_at: '2026-12-01T09:10:00+07:00' });

    // ---------- เอกสารที่ออกแล้ว (ข้อ 5) ----------
    const doc = {
      doc_no: 'DOC-2569-000001', case_id: caseIds[5], case_no: 'EG-2569-000005', verify_code: 'K7M2Q9XA', service_id: 'SV-01',
      applicant_name: 'สมชาย ใจดี', issued_at: '2026-11-05T10:00:00+07:00', valid_until: '2027-02-02',
      signer: 'เจ้าหน้าที่ทะเบียน 1', signer_username: 'off.reg1',
    };
    doc.signature = sign.signDoc(doc);
    ins('documents', doc);

    // ---------- ตัวนับ (ข้อ 12) ----------
    for (const [name, value] of [['case:2569', 30], ['receipt:2569', 30], ['doc:2569', 1], ['draft', 2], ['payment', 1], ['file', fileSeq]]) ins('counters', { name, value });
  });
}

module.exports = { seed, pdfBytes, SERVICES, HOLIDAYS, CITIZENS, USERS, CASES, PASSWORD };
