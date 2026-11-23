'use strict';
// [B01] ธนาคารจำลอง: ตรวจ QR/ยอด แล้วเปลี่ยนร่างเป็นคำขอ (ออกเลข EG/RC + กำหนดเสร็จ) · ใช้โดย POST /api/test/payments/:ref/pay
// กฎเวลา/กำหนดเสร็จเรียกจาก rules.js (B03) ถ้ามีฟังก์ชัน · ไม่มี → ใช้ fallback ด้านล่าง (ผลเหมือนกฎใน DECISIONS ข้อ 0/7/8)
//   rules.isQrExpired(qrCreatedAtISO, nowISO) → boolean          (B05 บั๊กอยู่ที่ rules ถ้ามี)
//   rules.computeDueAt(paidAtISO, slaDays, holidaysSet) → ISO     (B03 บั๊กอยู่ที่ rules ถ้ามี)
// B04 ใช้ statusOf(payment) ใน GET /api/payments/:ref และ createQr(caseId) ใน POST /api/drafts/:id/payment
const db = require('./db');
const clock = require('./clock');
const bugs = require('./bugs');
const { HttpError } = require('./errors');

const QR_TTL_MS = 15 * 60 * 1000;
const pad6 = (n) => String(n).padStart(6, '0');

function rules() { try { return require('../modules/rules'); } catch (e) { if (e.code === 'MODULE_NOT_FOUND' && /modules[\\/]rules/.test(e.message)) return {}; throw e; } }

function holidaySet() { return new Set(db.all('SELECT date FROM holidays').map((r) => r.date)); }

// ---------- fallback (ถูกแทนโดย rules.js) ----------
function fallbackIsQrExpired(createdISO, nowISO) {
  const age = clock.parse(nowISO) - clock.parse(createdISO);
  return bugs.on('B05') ? age > QR_TTL_MS : age >= QR_TTL_MS;
}
function fallbackComputeDueAt(paidISO, sla, holidays) {
  const isWork = (d) => { const w = clock.dowOf(d); return w !== 0 && w !== 6 && (bugs.on('B03') || !holidays.has(d)); };
  const p = clock.parts(paidISO);
  let d0 = clock.dateStr(paidISO);
  if (!isWork(d0) || p.hh * 60 + p.mm >= 16 * 60 + 30) { do d0 = clock.addDays(d0, 1); while (!isWork(d0)); }
  let d = d0;
  for (let n = 0; n < sla;) { d = clock.addDays(d, 1); if (isWork(d)) n++; }
  return `${d}T16:30:00+07:00`;
}

function isQrExpired(createdISO, nowISO = clock.nowISO()) {
  const r = rules();
  return typeof r.isQrExpired === 'function' ? r.isQrExpired(createdISO, nowISO) : fallbackIsQrExpired(createdISO, nowISO);
}
function computeDueAt(paidISO, sla) {
  const r = rules();
  return typeof r.computeDueAt === 'function' ? r.computeDueAt(paidISO, sla, holidaySet()) : fallbackComputeDueAt(paidISO, sla, holidaySet());
}

/** สถานะที่ API แสดง: PAID / EXPIRED (อายุ ≥ 15:00 ตามนาฬิกา) / PENDING */
function statusOf(p) { return p.status === 'PAID' ? 'PAID' : isQrExpired(p.qr_created_at) ? 'EXPIRED' : 'PENDING'; }

/** สร้าง QR ใหม่ (ref ใหม่ทุกครั้ง) ด้วยยอดที่ล็อกใน cases.fee → แถว payments */
function createQr(caseId) {
  const c = db.get('SELECT id, fee FROM cases WHERE id = ?', caseId);
  if (!c) throw new HttpError(404, 'NOT_FOUND');
  const now = clock.now();
  const ref = `PP-${String(db.nextSeq('payment')).padStart(4, '0')}`;
  db.run('INSERT INTO payments(ref, case_id, amount, status, qr_created_at, qr_expires_at) VALUES (?,?,?,?,?,?)',
    ref, c.id, c.fee, 'PENDING', clock.toISO(now), clock.toISO(now + QR_TTL_MS));
  return db.get('SELECT * FROM payments WHERE ref = ?', ref);
}

/** callback ธนาคารจำลอง → { status:'PAID', caseNo, receiptNo, duplicate } */
function pay(ref, amount) {
  return db.tx(() => {
    const p = db.get('SELECT * FROM payments WHERE ref = ?', ref);
    if (!p) throw new HttpError(404, 'NOT_FOUND', 'ไม่พบรายการชำระ');
    const c = db.get('SELECT * FROM cases WHERE id = ?', p.case_id);
    if (p.status === 'PAID' || (c && c.case_no)) {
      return { status: 'PAID', caseNo: c.case_no, receiptNo: c.receipt_no, duplicate: true };
    }
    const nowISO = clock.nowISO();
    if (isQrExpired(p.qr_created_at, nowISO)) throw new HttpError(410, 'QR_EXPIRED');
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount !== p.amount) throw new HttpError(422, 'AMOUNT_MISMATCH');
    if (!c || c.status !== 'PENDING_PAYMENT') throw new HttpError(409, 'INVALID_STATE');

    const be = clock.yearBE(clock.now());
    const seq = db.nextSeq(`case:${be}`);
    db.nextSeq(`receipt:${be}`);
    const caseNo = `EG-${be}-${pad6(seq)}`;
    const receiptNo = `RC-${be}-${pad6(seq)}`;
    const sla = db.get('SELECT sla FROM services WHERE id = ?', c.service_id).sla;
    const dueAt = computeDueAt(nowISO, sla);
    db.run(`UPDATE cases SET case_no=?, receipt_no=?, status='SUBMITTED', dept='registry', step=?, owner=NULL,
            sla_days=?, paid_at=?, due_at=?, updated_at=? WHERE id=?`,
      caseNo, receiptNo, c.service_id === 'SV-03' ? 1 : null, sla, nowISO, dueAt, nowISO, c.id);
    db.run("UPDATE payments SET status='PAID', paid_at=? WHERE ref=?", nowISO, ref);
    db.run('INSERT INTO case_events(case_id, time, event, actor, text) VALUES (?,?,?,?,?)', c.id, nowISO, 'PAID', 'citizen', 'ชำระเงินแล้ว · ส่งคำขอ');
    return { status: 'PAID', caseNo, receiptNo, duplicate: false };
  });
}

module.exports = { QR_TTL_MS, pay, createQr, statusOf, isQrExpired, computeDueAt, holidaySet, fallbackComputeDueAt, fallbackIsQrExpired };
