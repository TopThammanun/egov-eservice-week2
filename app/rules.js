'use strict';
// [B03] ไลบรารีกฎธุรกิจ (pure functions · ไม่แตะ DB · ไม่อ่าน Date.now())
// ที่มา: REQUIREMENTS BR-04 05 09 10 11 12 13 14 15 20 · DECISIONS §0 §3 §6 §7 §8 §18 · TEST-DATA §3 · BUGS B01 B03 B04 B05
// โหลดผ่าน ctx.rules (src/modules/rules.js re-export ไฟล์นี้) หรือ require('<app>/rules')
// ตรวจเอง: `node rules.js` (กฎถูก) · `TEST_MODE=1 node rules.js` (รวมบั๊ก B01 B03 B04 B05)
//
// ── เวลาและวันทำการ (DECISIONS §0) ─────────────────────────────────────────────
//   holidays รับได้ทั้ง Set<'YYYY-MM-DD'> · ['YYYY-MM-DD'] · [{date}] (แถวจากตาราง holidays)
//   isWorkingDay(ymd, holidays)             → จ.–ศ. ที่ไม่อยู่ในตารางวันหยุด
//   dueHolidays(holidays)                   → ตารางวันหยุดสำหรับคำนวณกำหนดเสร็จ          (B03: ตารางว่าง)
//   nextWorkingDay(ymd, holidays)           → วันทำการถัดไป (ไม่รวมวันนั้นเอง)
//   addWorkingDays(ymd, n, holidays)        → วันทำการที่ n หลัง ymd
//   workingDaysBetween(fromYmd, toYmd, hol) → จำนวนวันทำการในช่วง (from, to]
// ── BR-12 D0 + กำหนดเสร็จ ─────────────────────────────────────────────────────
//   startDay(paidISO, holidays)             → D0 'YYYY-MM-DD' (วันทำการและก่อน 16:30:00 = วันนั้น ไม่งั้นวันทำการถัดไป)
//   computeDueAt(paidISO, slaDays, holidays)→ 'YYYY-MM-DDT16:30:00+07:00' (core payments.pay() เรียกตัวนี้)
// ── BR-13 หยุดนับระหว่าง NEED_FIX ───────────────────────────────────────────────
//   pausedWorkingDays(returnedISO, resubmittedISO, holidays) → n วันทำการใน (วันตีกลับ, วันส่งแก้] ตามวันที่
//   extendDueAt(dueISO, n, holidays)        → กำหนดเดิม + n วันทำการ (เวลาเดิม 16:30)
//   resumeDueAt(dueISO, returnedISO, resubmittedISO, holidays) → { dueAt, pausedDays }   (B04: ไม่ขยาย → pausedDays 0)
//     ใช้ตอน POST /api/cases/:no/resubmit: holidays = ตาราง ณ เวลาที่ส่งแก้ · เก็บ pausedDays ลง case_returns.paused_days
// ── BR-14 วันคงเหลือ / ระดับเตือน ───────────────────────────────────────────────
//   daysLeft(dueISO, nowISO, holidays)      → วันทำการหลังวันนี้ถึงวันกำหนด (รวมวันกำหนด) · ผ่านวันกำหนดแล้ว = 0
//   slaLevel(caseLike, nowISO, holidays)    → 'normal' | 'near' | 'overdue' | 'paused' | 'closed' | null (ร่าง/ยังไม่มี dueAt)
//       caseLike = { status, dueAt } หรือ { status, due_at }
//   slaInfo(caseLike, nowISO, holidays)     → { level, daysLeft }   (daysLeft = null ถ้าไม่ใช่ normal/near)
//   levelOfDue(dueISO, nowISO, holidays)    → 'normal' | 'near' | 'overdue' (ไม่ดูสถานะ)
// ── BR-15 ผู้รับแจ้งเตือน ─────────────────────────────────────────────────────
//   notifyRecipients(caseLike, level, staff) → ['username', ...] ไม่ซ้ำ
//       caseLike = { status, owner, dept, issuer } · staff = แถว users [{ username, role, dept }]
//   noticeText(caseNo, level)               → 'คำขอ EG-2569-000024 ใกล้ครบกำหนด' / '… เกินกำหนด'
//   NOTIFY_LEVELS = ['near','overdue'] · ACTIVE_STATUSES (สถานะที่ประเมินระดับ)
// ── BR-04 / BR-05 ค่าธรรมเนียม (DECISIONS §3) ───────────────────────────────────
//   calcFee(serviceId, input, service)      → { ok:true, fee, qty, areaSqm } | { ok:false, status, code, message }
//       input = { qty } (SV-01 · ไม่ส่ง = 1 ตาม A-56) · { areaSqm } (SV-03 · รับ area ด้วย) · SV-02 ไม่มี
//       service = แถว services { fee, fee_per_sqm } (ค่าที่ admin แก้) · ไม่ส่ง = ค่า seed
//   feeOrThrow(serviceId, input, service)   → fee (number) หรือ throw HttpError(400, INVALID_QTY|INVALID_AREA|AREA_TOO_LARGE)
//   feeCore(serviceId, raw, cfg)            → ฟังก์ชันไร้ dependency ใช้ซ้ำในเบราว์เซอร์ได้
//   feeClientScript(service, varName?)      → สตริง JS `<script>` เนื้อใน: window.egovFee(raw) คำนวณสดบนหน้า /citizen/new/:sv (รวม B01 แล้ว)
//                                             หน้าใช้: const r = egovFee(input.value) → r.ok ? money(r.fee) : (r.message, ปุ่ม disabled)
// ── BR-09 / BR-11 เลขคำขอ / ใบเสร็จ / ยอด ──────────────────────────────────────
//   yearBE(iso) · caseNo(be, seq) 'EG-2569-000031' · receiptNo(be, seq) 'RC-2569-000031' · parseCaseNo(s) → {be, seq}|null
//   CASE_NO_RE · RECEIPT_NO_RE · amountMatches(amount, fee) → ยอดต้องเท่าพอดี (number จำนวนจริง)
//   (เลขจริงออกใน core payments.pay() เท่านั้น ด้วย db.nextSeq('case:<พ.ศ.>') · ปีตามเวลาชำระ)
// ── BR-10 QR 15 นาที ──────────────────────────────────────────────────────────
//   isQrExpired(createdISO, nowISO)         → อายุ ≥ 15:00 หมดอายุ                       (B05: > 15:00)
//   qrExpiresAt(createdISO) · qrSecondsLeft(createdISO, nowISO)
// ── BR-20 เวลาแก้ไข 168 ชม. ───────────────────────────────────────────────────
//   fixDeadline(returnedISO)                → returned + 168:00 (ISO +07:00)
//   isFixExpired(fixDeadlineISO, nowISO)    → ตอนนี้ ≥ เส้นตาย (167:59 ส่งได้ · 168:00 ยกเลิก)
//
// บั๊กทั้งหมดอยู่ที่นี่ (เปิดเมื่อ TEST_MODE=1 + BUG_MODE): B01 calcFee/feeClientScript · B03 dueHolidays (กระทบเฉพาะการคำนวณ
// กำหนดเสร็จ: computeDueAt + resumeDueAt · ไม่กระทบวันคงเหลือ/ระดับเตือน/แจ้งเตือน) · B04 resumeDueAt · B05 isQrExpired
// → โมดูลอื่นห้ามใส่ if (bugs.on('B01'|'B03'|'B04'|'B05')) ซ้ำ
const clock = require('./src/core/clock');
const bugs = require('./src/core/bugs');

const CUTOFF_MIN = 16 * 60 + 30;                 // 16:30:00 ขึ้นไป = วันทำการถัดไป
const DUE_TIME = 'T16:30:00+07:00';
const QR_TTL_MS = 15 * 60 * 1000;
const FIX_WINDOW_MS = 168 * 3600 * 1000;         // 7 วันปฏิทิน
const SCAN_LIMIT = 3660;                         // กันลูปไม่จบ (10 ปี)
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const ACTIVE_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'PENDING_APPROVAL', 'APPROVED'];
const CLOSED_STATUSES = ['COMPLETED', 'REJECTED', 'CANCELLED'];
const NOTIFY_LEVELS = ['near', 'overdue'];
const SEED_FEES = { 'SV-01': { fee: 20 }, 'SV-02': { fee: 500 }, 'SV-03': { fee: 1000, feePerSqm: 10 } };
const FEE_MESSAGES = {
  INVALID_QTY: 'จำนวนฉบับต้อง 1–5 ฉบับ',
  INVALID_AREA: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.',
  AREA_TOO_LARGE: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน',
  NOT_FOUND: 'ไม่พบบริการ',
};

// ───────────────────────── ตัวช่วย ─────────────────────────
function ms(iso) {
  const t = clock.parse(iso);
  if (Number.isNaN(t)) throw new TypeError(`rules: เวลาไม่ถูกต้อง ${JSON.stringify(iso)}`);
  return t;
}
function ymdOf(isoOrYmd) {
  if (typeof isoOrYmd === 'string' && YMD_RE.test(isoOrYmd)) return isoOrYmd;
  return clock.dateStr(ms(isoOrYmd));
}
function toHolidaySet(h) {
  if (h instanceof Set) return h;
  if (Array.isArray(h)) return new Set(h.map((x) => (typeof x === 'string' ? x : x && x.date)).filter(Boolean));
  return new Set();
}
function checkCount(n, what) {
  if (!Number.isInteger(n) || n < 0) throw new TypeError(`rules: ${what} ต้องเป็นจำนวนเต็ม ≥ 0 (ได้ ${JSON.stringify(n)})`);
}

// ───────────────────────── วันทำการ (DECISIONS §0) ─────────────────────────
/** จ.–ศ. ที่ไม่อยู่ในตารางวันหยุด (ฟังก์ชันเดียวใช้ทั้งกำหนดเสร็จ หยุดนับ และวันคงเหลือ · DECISIONS 18) */
function isWorkingDay(ymd, holidays) {
  const w = clock.dowOf(ymd);
  if (w === 0 || w === 6) return false;
  return !toHolidaySet(holidays).has(ymd);
}
/** ตารางวันหยุดที่ใช้ "คำนวณกำหนดเสร็จ" (BR-12 ตอนชำระ · BR-13 ตอนส่งแก้) · B03: ตารางว่าง = ข้ามแค่เสาร์-อาทิตย์
 *  บั๊กอยู่เฉพาะจุดนี้ (BUGS.md กติกา 1) → วันคงเหลือ/ระดับเตือน (BR-14) และแจ้งเตือน (BR-15) ยังใช้ตารางจริง */
function dueHolidays(holidays) {
  return bugs.on('B03') ? new Set() : toHolidaySet(holidays);
}
function nextWorkingDay(ymd, holidays) {
  const h = toHolidaySet(holidays);
  let d = ymd;
  for (let i = 0; i < SCAN_LIMIT; i++) { d = clock.addDays(d, 1); if (isWorkingDay(d, h)) return d; }
  throw new RangeError('rules: ไม่พบวันทำการ');
}
/** วันทำการที่ n หลัง ymd (n = 0 → ymd เดิม) */
function addWorkingDays(ymd, n, holidays) {
  checkCount(n, 'จำนวนวันทำการ');
  const h = toHolidaySet(holidays);
  let d = ymd;
  for (let k = 0; k < n; k++) d = nextWorkingDay(d, h);
  return d;
}
/** จำนวนวันทำการในช่วง (fromYmd, toYmd] · to ≤ from → 0 */
function workingDaysBetween(fromYmd, toYmd, holidays) {
  const h = toHolidaySet(holidays);
  let n = 0;
  for (let d = clock.addDays(fromYmd, 1), i = 0; d <= toYmd && i < SCAN_LIMIT * 3; d = clock.addDays(d, 1), i++) {
    if (isWorkingDay(d, h)) n++;
  }
  return n;
}

// ───────────────────────── BR-12 D0 + กำหนดเสร็จ ─────────────────────────
/** D0: วันที่ชำระ ถ้าเป็นวันทำการและก่อน 16:30:00 · ไม่งั้นวันทำการถัดไป (16:29:59 = วันนั้น · 16:30:00 = ถัดไป) */
function startDay(paidISO, holidays) {
  const h = toHolidaySet(holidays);
  const p = clock.parts(ms(paidISO));
  const d = clock.dateStr(ms(paidISO));
  return isWorkingDay(d, h) && p.hh * 60 + p.mm < CUTOFF_MIN ? d : nextWorkingDay(d, h);
}
/** กำหนดเสร็จ = วันทำการที่ N หลัง D0 เวลา 16:30 · คำนวณครั้งเดียวตอนชำระ (A-42) */
function computeDueAt(paidISO, slaDays, holidays) {
  const n = Number(slaDays);
  checkCount(n, 'SLA');
  const h = dueHolidays(holidays);
  return addWorkingDays(startDay(paidISO, h), n, h) + DUE_TIME;
}

// ───────────────────────── BR-13 หยุดนับ ─────────────────────────
/** วันทำการใน (วันตีกลับ, วันส่งแก้] นับตามวันที่ ไม่ขึ้นกับเวลา (ส่งแก้หลัง 16:30 ก็นับวันนั้น) */
function pausedWorkingDays(returnedISO, resubmittedISO, holidays) {
  return workingDaysBetween(ymdOf(returnedISO), ymdOf(resubmittedISO), holidays);
}
/** กำหนดเดิม + n วันทำการ (คงเวลาเดิม ปกติ 16:30:00) */
function extendDueAt(dueISO, n, holidays) {
  checkCount(n, 'จำนวนวันหยุดนับ');
  const t = ms(dueISO);
  if (n === 0) return clock.toISO(t);
  const p = clock.parts(t);
  const pad = clock.pad;
  return `${addWorkingDays(clock.dateStr(t), n, holidays)}T${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}+07:00`;
}
/** ตอนประชาชนส่งแก้: กำหนดใหม่ = กำหนดเดิม + วันทำการใน (ตีกลับ, ส่งแก้] · B04: ไม่หยุดนับ */
function resumeDueAt(dueISO, returnedISO, resubmittedISO, holidays) {
  if (bugs.on('B04')) return { dueAt: clock.toISO(ms(dueISO)), pausedDays: 0 };
  const h = dueHolidays(holidays);
  const pausedDays = pausedWorkingDays(returnedISO, resubmittedISO, h);
  return { dueAt: extendDueAt(dueISO, pausedDays, h), pausedDays };
}

// ───────────────────────── BR-14 วันคงเหลือ / ระดับเตือน ─────────────────────────
/** วันทำการหลังวันนี้ ถึงวันกำหนดเสร็จ (รวมวันกำหนด) · วันกำหนด ≤ วันนี้ → 0 */
function daysLeft(dueISO, nowISO, holidays) {
  return workingDaysBetween(clock.dateStr(ms(nowISO)), clock.dateStr(ms(dueISO)), holidays);
}
/** ระดับจากกำหนดเสร็จอย่างเดียว: ตอนนี้ > กำหนด → overdue (16:30:01 เกิน) · เหลือ ≤ 1 → near · ≥ 2 → normal */
function levelOfDue(dueISO, nowISO, holidays) {
  if (ms(nowISO) > ms(dueISO)) return 'overdue';
  return daysLeft(dueISO, nowISO, holidays) <= 1 ? 'near' : 'normal';
}
function dueOf(c) { return c && (c.dueAt != null ? c.dueAt : c.due_at); }
/** ระดับของคำขอ (CONTRACT 4.2): closed (COMPLETED/REJECTED/CANCELLED) · paused (NEED_FIX) · ร่าง/ไม่มี dueAt → null */
function slaLevel(c, nowISO, holidays) {
  if (!c) return null;
  if (CLOSED_STATUSES.includes(c.status)) return 'closed';
  if (c.status === 'NEED_FIX') return 'paused';
  const due = dueOf(c);
  if (!ACTIVE_STATUSES.includes(c.status) || !due) return null;
  return levelOfDue(due, nowISO, holidays);
}
function slaInfo(c, nowISO, holidays) {
  const level = slaLevel(c, nowISO, holidays);
  const left = level === 'normal' || level === 'near' ? daysLeft(dueOf(c), nowISO, holidays) : null;
  return { level, daysLeft: left };
}

// ───────────────────────── BR-15 ผู้รับแจ้งเตือน ─────────────────────────
/**
 * ผู้รับ (DECISIONS 18 ผู้รับแจ้งเตือน · A-31):
 *   PENDING_APPROVAL → head ทุกคน · APPROVED → ผู้ออกเอกสาร (issuer; ไม่มี → ผู้ถือ/แผนก) · มีผู้ถือ → ผู้ถือ
 *   ไม่มีผู้ถือ → officer ทุกคนของแผนก c.dept · overdue → + head ทุกคน (ไม่ซ้ำ)
 * ระดับอื่นนอก near/overdue หรือสถานะที่ไม่ประเมิน (NEED_FIX ปิดแล้ว ร่าง) → []
 */
function notifyRecipients(c, level, staff) {
  if (!c || !NOTIFY_LEVELS.includes(level) || !ACTIVE_STATUSES.includes(c.status)) return [];
  const list = Array.isArray(staff) ? staff : [];
  const heads = list.filter((u) => u.role === 'head').map((u) => u.username);
  const deptOfficers = (dept) => list.filter((u) => u.role === 'officer' && dept && u.dept === dept).map((u) => u.username);
  let out;
  if (c.status === 'PENDING_APPROVAL' || c.dept === 'head') out = heads.slice();
  else if (c.status === 'APPROVED' && c.issuer) out = [c.issuer];
  else if (c.owner) out = [c.owner];
  else out = deptOfficers(c.dept);
  if (level === 'overdue') out = out.concat(heads);
  return [...new Set(out.filter(Boolean))];
}
function noticeText(caseNo, level) {
  return `คำขอ ${caseNo} ${level === 'overdue' ? 'เกินกำหนด' : 'ใกล้ครบกำหนด'}`;
}

// ───────────────────────── BR-04 / BR-05 ค่าธรรมเนียม ─────────────────────────
/**
 * แกนคำนวณ ไร้ dependency (ใช้ซ้ำในเบราว์เซอร์ผ่าน feeClientScript)
 * raw = จำนวนฉบับ (SV-01) / พื้นที่ ตร.ม. (SV-03) · SV-02 ไม่ใช้ · cfg = { fee, feePerSqm, bugB01 }
 * → { ok:true, fee, value } | { ok:false, code }
 */
function feeCore(serviceId, raw, cfg) {
  function toInt(v) {
    if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
    if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
    return NaN;
  }
  if (serviceId === 'SV-02') return { ok: true, fee: cfg.fee, value: null };
  if (serviceId === 'SV-01') {
    var q = raw === undefined || raw === null ? 1 : toInt(raw);
    if (!(q >= 1 && q <= 5)) return { ok: false, code: 'INVALID_QTY' };
    return { ok: true, fee: cfg.fee * q, value: q };
  }
  if (serviceId === 'SV-03') {
    var a = toInt(raw);
    if (!(a >= 1)) return { ok: false, code: 'INVALID_AREA' };
    if (a > 500) return { ok: false, code: 'AREA_TOO_LARGE' };
    var extra = cfg.bugB01 ? a > 101 : a >= 101;            // B01: > 101 แทน ≥ 101
    return { ok: true, fee: extra ? cfg.fee + cfg.feePerSqm * (a - 100) : cfg.fee, value: a };
  }
  return { ok: false, code: 'NOT_FOUND' };
}
function feeCfg(serviceId, service) {
  const seed = SEED_FEES[serviceId] || { fee: 0 };
  const s = service || {};
  const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  return {
    fee: num(s.fee, seed.fee),
    feePerSqm: num(s.fee_per_sqm !== undefined ? s.fee_per_sqm : s.feePerSqm, seed.feePerSqm || 0),
    bugB01: bugs.on('B01'),
  };
}
/** ค่าธรรมเนียมตามบริการ (service = แถว services ที่ admin แก้ได้ · ยอดนี้ถูกล็อกลง cases.fee ตอนเข้า PENDING_PAYMENT) */
function calcFee(serviceId, input, service) {
  const inp = input || {};
  const raw = serviceId === 'SV-01' ? inp.qty : serviceId === 'SV-03' ? (inp.areaSqm !== undefined ? inp.areaSqm : inp.area) : null;
  const r = feeCore(serviceId, raw, feeCfg(serviceId, service));
  if (!r.ok) return { ok: false, status: r.code === 'NOT_FOUND' ? 404 : 400, code: r.code, message: FEE_MESSAGES[r.code] };
  return {
    ok: true, fee: r.fee,
    qty: serviceId === 'SV-01' ? r.value : null,
    areaSqm: serviceId === 'SV-03' ? r.value : null,
  };
}
function feeOrThrow(serviceId, input, service) {
  const r = calcFee(serviceId, input, service);
  if (r.ok) return r.fee;
  const { HttpError } = require('./src/core/errors');
  throw new HttpError(r.status, r.code, r.message);
}
/** JS สำหรับฝังใน <script> หน้าเลือกบริการ: กำหนด window[varName](raw) → {ok, fee, code, message} ด้วยค่าธรรมเนียมปัจจุบัน */
function feeClientScript(service, varName = 'egovFee') {
  const sid = service && (service.id || service.serviceId);
  const cfg = feeCfg(sid, service);
  const js = `(function(){var feeCore=${feeCore.toString()};var M=${JSON.stringify(FEE_MESSAGES)};` +
    `window[${JSON.stringify(varName)}]=function(raw){var r=feeCore(${JSON.stringify(sid)},raw,${JSON.stringify(cfg)});` +
    `if(!r.ok)r.message=M[r.code];return r;};})();`;
  return js.replace(/<\/script/gi, '<\\/script');
}

// ───────────────────────── BR-09 / BR-11 เลขคำขอ ใบเสร็จ ยอด ─────────────────────────
const CASE_NO_RE = /^EG-(\d{4})-(\d{6})$/;
const RECEIPT_NO_RE = /^RC-(\d{4})-(\d{6})$/;
const pad6 = (n) => String(n).padStart(6, '0');
/** ปี พ.ศ. ตามเวลาไทยของเวลาชำระ (2026-12-31T23:59 → 2569 · 2027-01-01T00:00 → 2570) */
function yearBE(iso) { return clock.yearBE(ms(iso)); }
function caseNo(be, seq) { return `EG-${be}-${pad6(seq)}`; }
function receiptNo(be, seq) { return `RC-${be}-${pad6(seq)}`; }
function parseCaseNo(s) { const m = CASE_NO_RE.exec(String(s || '')); return m ? { be: Number(m[1]), seq: Number(m[2]) } : null; }
/** ยอดชำระต้องเท่ายอดที่ล็อกพอดี (ขาด/เกิน ฿1 ✗) */
function amountMatches(amount, fee) { return typeof amount === 'number' && Number.isFinite(amount) && amount === Number(fee); }

// ───────────────────────── BR-10 QR ─────────────────────────
/** QR ใช้ได้ถ้าอายุ < 15:00 → อายุ ≥ 15:00 หมดอายุ (14:59 ✓ · 15:00 ✗) · B05: ≤ 15:00 ยังใช้ได้ */
function isQrExpired(createdISO, nowISO) {
  const age = ms(nowISO) - ms(createdISO);
  return bugs.on('B05') ? age > QR_TTL_MS : age >= QR_TTL_MS;
}
function qrExpiresAt(createdISO) { return clock.toISO(ms(createdISO) + QR_TTL_MS); }
function qrSecondsLeft(createdISO, nowISO) { return Math.max(0, Math.ceil((QR_TTL_MS - (ms(nowISO) - ms(createdISO))) / 1000)); }

// ───────────────────────── BR-20 เวลาแก้ไข 168 ชม. ─────────────────────────
function fixDeadline(returnedISO) { return clock.toISO(ms(returnedISO) + FIX_WINDOW_MS); }
/** เลยเส้นตายแก้ไข (ตอนนี้ ≥ เส้นตาย) → ระบบยกเลิกอัตโนมัติ · 167:59 ส่งได้ · 168:00 ยกเลิก */
function isFixExpired(fixDeadlineISO, nowISO) { return ms(nowISO) >= ms(fixDeadlineISO); }

module.exports = {
  CUTOFF_MIN, DUE_TIME, QR_TTL_MS, FIX_WINDOW_MS, ACTIVE_STATUSES, CLOSED_STATUSES, NOTIFY_LEVELS, FEE_MESSAGES, SEED_FEES,
  CASE_NO_RE, RECEIPT_NO_RE,
  toHolidaySet, dueHolidays, isWorkingDay, nextWorkingDay, addWorkingDays, workingDaysBetween,
  startDay, computeDueAt,
  pausedWorkingDays, extendDueAt, resumeDueAt,
  daysLeft, levelOfDue, slaLevel, slaInfo,
  notifyRecipients, noticeText,
  feeCore, calcFee, feeOrThrow, feeClientScript,
  yearBE, caseNo, receiptNo, parseCaseNo, amountMatches,
  isQrExpired, qrExpiresAt, qrSecondsLeft,
  fixDeadline, isFixExpired,
};

// ───────────────────────── self-test: node rules.js ─────────────────────────
if (require.main === module) {
  const assert = require('assert');
  const H = new Set(['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01']);   // TEST-DATA §3
  const T = (s) => `${s}:00+07:00`;
  let pass = 0;
  const eq = (got, exp, label) => { assert.deepStrictEqual(got, exp, `${label}: ได้ ${JSON.stringify(got)} คาด ${JSON.stringify(exp)}`); pass++; };
  const run = (bugList, fn) => { bugs.set(bugList); try { fn(); } finally { bugs.set(''); } };

  // TC-FEE-01
  const FEE = [[0, 'INVALID_AREA'], [-1, 'INVALID_AREA'], [1, 1000], [100, 1000], [101, 1010], [102, 1020], [250, 2500],
    [300, 3000], [499, 4990], [500, 5000], [501, 'AREA_TOO_LARGE']];
  for (const [a, exp] of FEE) { const r = calcFee('SV-03', { areaSqm: a }); eq(r.ok ? r.fee : r.code, exp, `FEE SV-03 ${a}`); }
  for (const [q, exp] of [[0, 'INVALID_QTY'], [1, 20], [2, 40], [3, 60], [4, 80], [5, 100], [6, 'INVALID_QTY']]) {
    const r = calcFee('SV-01', { qty: q }); eq(r.ok ? r.fee : r.code, exp, `FEE SV-01 ${q}`);
  }
  eq(calcFee('SV-02', {}).fee, 500, 'FEE SV-02');
  eq(calcFee('SV-01', {}).fee, 20, 'FEE SV-01 ค่าตั้งต้น 1 ฉบับ');
  eq(calcFee('SV-01', { qty: '3' }).fee, 60, 'FEE SV-01 สตริง');
  eq(calcFee('SV-01', { qty: 1.5 }).code, 'INVALID_QTY', 'FEE SV-01 ทศนิยม');
  eq(calcFee('SV-03', {}).code, 'INVALID_AREA', 'FEE SV-03 ว่าง');
  eq(calcFee('SV-03', { areaSqm: 101 }, { fee: 2000, fee_per_sqm: 20 }).fee, 2020, 'FEE SV-03 admin แก้');
  eq(calcFee('SV-02', {}, { fee: 600 }).fee, 600, 'FEE SV-02 admin แก้');
  eq(calcFee('SV-03', { areaSqm: 501 }).message, 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน', 'FEE ข้อความ');
  { const ctx = {}; new Function('window', feeClientScript({ id: 'SV-03', fee: 1000, fee_per_sqm: 10 }))(ctx);
    eq([ctx.egovFee('101').fee, ctx.egovFee('0').message], [1010, 'กรุณาระบุพื้นที่ 1–500 ตร.ม.'], 'FEE client script'); }

  // TC-SLA-01 (+ DECISIONS §8 · BR-12 ขอบวินาที)
  const SLA1 = [
    ['a', '2026-12-01T09:00', 3, '2026-12-04'], ['b', '2026-12-01T16:29', 3, '2026-12-04'], ['b2', '2026-12-01T16:29:59', 3, '2026-12-04'],
    ['c', '2026-12-01T16:30', 3, '2026-12-08'], ['d', '2026-12-04T10:00', 3, '2026-12-11'], ['e', '2026-12-05T10:00', 3, '2026-12-14'],
    ['f', '2026-12-01T09:00', 10, '2026-12-17'], ['g', '2026-12-01T09:00', 15, '2026-12-24'], ['h', '2026-12-29T10:00', 3, '2027-01-05'],
    ['i', '2026-12-31T23:59', 3, '2027-01-07'],
  ];
  for (const [row, paid, n, exp] of SLA1) eq(computeDueAt(paid.length > 16 ? paid + '+07:00' : T(paid), n, H), exp + DUE_TIME, `SLA-01 ${row}`);
  eq(computeDueAt('2026-12-01T09:30:00.000Z', 3, [...H]), '2026-12-08T16:30:00+07:00', 'SLA-01 รับ Z (16:30 ไทย) + array');
  eq(computeDueAt('2026-11-23T10:00:00+07:00', 3, H), '2026-11-26T16:30:00+07:00', 'F01 ก่อนหยุดนับ');

  // TC-SLA-02 + TEST-DATA 4.4
  const SLA2 = [
    ['1', '2026-12-04T16:30', '2026-12-02T11:00', '2026-12-03T10:00', '2026-12-08', 1],
    ['2', '2026-11-27T16:30', '2026-11-27T14:00', '2026-12-01T09:00', '2026-12-01', 2],
    ['3', '2026-11-27T16:30', '2026-11-27T14:00', '2026-12-04T10:00', '2026-12-04', 5],
    ['4', '2026-12-04T16:30', '2026-12-02T09:00', '2026-12-02T15:00', '2026-12-04', 0],
    ['5', '2026-12-04T16:30', '2026-12-04T10:00', '2026-12-08T17:00', '2026-12-08', 1],
    ['F01-1', '2026-11-26T16:30', '2026-11-24T11:00', '2026-11-25T10:00', '2026-11-27', 1],
    ['F02-1', '2026-12-01T16:30', '2026-11-27T10:00', '2026-11-30T10:00', '2026-12-02', 1],
    ['F02-2', '2026-12-02T16:30', '2026-11-30T14:00', '2026-12-01T08:30', '2026-12-03', 1],
  ];
  for (const [p, due, ret, sub, exp, days] of SLA2) eq(resumeDueAt(T(due), T(ret), T(sub), H), { dueAt: exp + DUE_TIME, pausedDays: days }, `SLA-02 ส่วน ${p}`);

  // TC-SLA-03
  const c31 = { status: 'IN_REVIEW', dueAt: '2026-12-04T16:30:00+07:00' };
  const SLA3A = [['2026-12-01T09:00:00', 'normal', 3], ['2026-12-02T09:00:00', 'normal', 2], ['2026-12-03T09:00:00', 'near', 1],
    ['2026-12-04T16:30:00', 'near', 0], ['2026-12-04T16:30:01', 'overdue', null], ['2026-12-04T16:31:00', 'overdue', null], ['2026-12-05T10:00:00', 'overdue', null]];
  for (const [now, lv, left] of SLA3A) eq(slaInfo(c31, now + '+07:00', H), { level: lv, daysLeft: left }, `SLA-03 A ${now}`);
  const c16 = { status: 'IN_REVIEW', due_at: '2026-12-08T16:30:00+07:00' };
  for (const [now, lv, left] of [['2026-12-03T09:00:00', 'normal', 2], ['2026-12-04T09:00:00', 'near', 1], ['2026-12-08T16:30:00', 'near', 0], ['2026-12-08T16:31:00', 'overdue', null]]) {
    eq(slaInfo(c16, now + '+07:00', H), { level: lv, daysLeft: left }, `SLA-03 B ${now}`);
  }
  const at9 = '2026-12-01T09:00:00+07:00';
  for (const [due, lv] of [['2026-11-30', 'overdue'], ['2026-12-01', 'near'], ['2026-12-02', 'near'], ['2026-12-03', 'normal']]) {
    eq(slaLevel({ status: 'SUBMITTED', dueAt: due + DUE_TIME }, at9, H), lv, `SLA-03 C ${due}`);
  }
  eq(slaLevel({ status: 'NEED_FIX', dueAt: '2026-11-27T16:30:00+07:00' }, at9, H), 'paused', 'SLA-03 C NEED_FIX');
  for (const s of CLOSED_STATUSES) eq(slaLevel({ status: s, dueAt: '2026-10-19T16:30:00+07:00' }, at9, H), 'closed', `SLA-03 C ${s}`);
  eq(slaLevel({ status: 'DRAFT', dueAt: null }, at9, H), null, 'ร่างไม่มีระดับ');
  eq(slaLevel({ status: 'IN_REVIEW', dueAt: '2026-12-01T16:30:00+07:00' }, '2026-12-01T16:30:00+07:00', H), 'near', 'SLA-03 C 16:30');
  eq(slaLevel({ status: 'IN_REVIEW', dueAt: '2026-12-01T16:30:00+07:00' }, '2026-12-01T16:31:00+07:00', H), 'overdue', 'SLA-03 C 16:31');

  // BR-15 (TEST-DATA §8)
  const staff = [{ username: 'off.reg1', role: 'officer', dept: 'registry' }, { username: 'off.reg2', role: 'officer', dept: 'registry' },
    { username: 'off.works1', role: 'officer', dept: 'works' }, { username: 'head1', role: 'head', dept: '' }, { username: 'exec1', role: 'executive', dept: '' }];
  eq(notifyRecipients({ status: 'SUBMITTED', dept: 'registry', owner: null }, 'near', staff), ['off.reg1', 'off.reg2'], 'NOTI คิวแผนก');
  eq(notifyRecipients({ status: 'IN_REVIEW', dept: 'registry', owner: 'off.reg1' }, 'overdue', staff), ['off.reg1', 'head1'], 'NOTI ผู้ถือ+head');
  eq(notifyRecipients({ status: 'IN_REVIEW', dept: 'works', owner: null }, 'overdue', staff), ['off.works1', 'head1'], 'NOTI โยธา');
  eq(notifyRecipients({ status: 'PENDING_APPROVAL', dept: 'head', owner: null }, 'near', staff), ['head1'], 'NOTI รออนุมัติ near');
  eq(notifyRecipients({ status: 'PENDING_APPROVAL', dept: 'head', owner: null }, 'overdue', staff), ['head1'], 'NOTI รออนุมัติ overdue ไม่ซ้ำ');
  eq(notifyRecipients({ status: 'APPROVED', dept: 'registry', owner: null, issuer: 'off.reg1' }, 'near', staff), ['off.reg1'], 'NOTI APPROVED near');
  eq(notifyRecipients({ status: 'APPROVED', dept: 'registry', owner: null, issuer: 'off.reg1' }, 'overdue', staff), ['off.reg1', 'head1'], 'NOTI APPROVED overdue');
  eq(notifyRecipients({ status: 'NEED_FIX', owner: 'off.reg1' }, 'overdue', staff), [], 'NOTI NEED_FIX');
  eq(noticeText('EG-2569-000024', 'near'), 'คำขอ EG-2569-000024 ใกล้ครบกำหนด', 'NOTI ข้อความ');

  // BR-09 / BR-11
  eq([yearBE('2026-12-31T23:59:00+07:00'), yearBE('2027-01-01T00:00:00+07:00'), yearBE('2026-12-31T17:00:00Z')], [2569, 2570, 2570], 'BR-09 ปี พ.ศ.');
  eq([caseNo(2569, 31), receiptNo(2570, 1), parseCaseNo('EG-2569-000031')], ['EG-2569-000031', 'RC-2570-000001', { be: 2569, seq: 31 }], 'BR-09/11 รูปแบบ');
  eq([amountMatches(499, 500), amountMatches(500, 500), amountMatches(501, 500), amountMatches('500', 500)], [false, true, false, false], 'BR-11 ยอด');

  // BR-10 (seed PP-0001 สร้าง 08:55)
  const qr = '2026-12-01T08:55:00+07:00';
  eq([isQrExpired(qr, '2026-12-01T09:09:59+07:00'), isQrExpired(qr, '2026-12-01T09:10:00+07:00'), isQrExpired(qr, '2026-12-01T09:10:01+07:00')], [false, true, true], 'BR-10 14:59/15:00/15:01');
  eq([qrExpiresAt(qr), qrSecondsLeft(qr, '2026-12-01T09:00:00+07:00')], ['2026-12-01T09:10:00+07:00', 600], 'BR-10 เวลาหมดอายุ');

  // BR-20
  eq(fixDeadline('2026-11-27T14:00:00+07:00'), '2026-12-04T14:00:00+07:00', 'BR-20 เส้นตาย');
  eq([isFixExpired('2026-12-04T14:00:00+07:00', '2026-12-04T13:59:00+07:00'), isFixExpired('2026-12-04T14:00:00+07:00', '2026-12-04T14:00:00+07:00')], [false, true], 'BR-20 167:59/168:00');

  // บั๊ก (BUGS.md) · ต้อง TEST_MODE=1
  const config = require('./src/core/config');
  if (config.TEST_MODE) {
    run('B01', () => { eq([calcFee('SV-03', { areaSqm: 101 }).fee, calcFee('SV-03', { areaSqm: 102 }).fee], [1000, 1020], 'B01'); });
    run('B03', () => {
      eq([['2026-12-01T16:30', 3], ['2026-12-04T10:00', 3], ['2026-12-05T10:00', 3], ['2026-12-29T10:00', 3], ['2026-12-31T23:59', 3]].map(([p, n]) => computeDueAt(T(p), n, H).slice(0, 10)),
        ['2026-12-07', '2026-12-09', '2026-12-10', '2027-01-01', '2027-01-06'], 'B03 กำหนดเสร็จ');
      eq(resumeDueAt(T('2026-12-04T16:30'), T('2026-12-02T11:00'), T('2026-12-03T10:00'), H).dueAt, '2026-12-07T16:30:00+07:00', 'B03 หยุดนับแถว 6');
      eq(slaLevel(c16, '2026-12-04T09:00:00+07:00', H), 'near', 'B03 ไม่กระทบวันคงเหลือ SLA-03 B');
      eq(slaLevel({ status: 'IN_REVIEW', dueAt: '2026-12-08T16:30:00+07:00' }, '2026-12-05T10:00:00+07:00', H), 'near', 'B03 ไม่กระทบระดับเตือน NOTI-02 B (…000016)');
    });
    run('B04', () => { eq(resumeDueAt(T('2026-11-27T16:30'), T('2026-11-27T14:00'), T('2026-12-01T09:00'), H), { dueAt: '2026-11-27T16:30:00+07:00', pausedDays: 0 }, 'B04'); });
    run('B05', () => { eq([isQrExpired(qr, '2026-12-01T09:10:00+07:00'), isQrExpired(qr, '2026-12-01T09:10:01+07:00')], [false, true], 'B05'); });
    run('B03,B05', () => { eq([computeDueAt(T('2026-12-01T16:30'), 3, H).slice(0, 10), isQrExpired(qr, '2026-12-01T09:10:00+07:00'), calcFee('SV-03', { areaSqm: 101 }).fee], ['2026-12-07', false, 1010], 'B03+B05 รวม'); });
    eq(computeDueAt(T('2026-12-01T16:30'), 3, H), '2026-12-08T16:30:00+07:00', 'ปิดบั๊กแล้วกลับเป็นถูก');
  } else {
    console.log('(ข้ามการตรวจบั๊ก · รัน TEST_MODE=1 node rules.js เพื่อตรวจ B01 B03 B04 B05)');
  }
  console.log(`rules.js self-test ผ่าน ${pass} ข้อ`);
}
