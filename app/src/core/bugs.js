'use strict';
// [B01] BUG_MODE parser · ดู /workspace/egov-brief/BUGS.md
// ใช้: const bugs = require('../core/bugs'); if (bugs.on('B03')) { ...พฤติกรรมผิด... }
// กติกา: บั๊กทำงานเฉพาะเมื่อ TEST_MODE=1 (BUGS.md อนุญาต) · ไม่ตั้ง/ว่าง = ถูกต้อง 100%
const config = require('./config');

const KNOWN = {
  B01: 'SV-03 พื้นที่ 101 คิด ฿1,000 (> 101 แทน ≥ 101)',
  B02: 'ไฟล์ 5,242,880 ไบต์พอดีถูกปฏิเสธ (< แทน ≤)',
  B03: 'SLA ไม่ข้ามวันหยุดในตาราง (ข้ามแค่เสาร์-อาทิตย์)',
  B04: 'SLA ไม่หยุดนับระหว่างรอแก้ไขเอกสาร',
  B05: 'QR อายุ 15:00 พอดียังจ่ายได้ (≤ แทน <)',
  B06: 'ประชาชนเปิดคำขอของคนอื่นผ่าน URL ได้ (IDOR)',
  B07: 'เจ้าหน้าที่อนุมัติ SV-02 ได้เอง (API ไม่เช็กสิทธิ์)',
  B08: 'API รับเรื่องข้ามการตรวจว่ามีผู้ถือแล้ว',
  B09: 'API คิวเจ้าหน้าที่ส่งเลขบัตรเต็ม',
  B10: 'ทันกำหนด % หารด้วย "รับเรื่อง" แทน "ปิดงาน"',
  B11: '"แสดงเลขเต็ม" ไม่บันทึก Audit UNMASK',
  B12: 'ตีกลับครั้งที่ 3 ได้',
};

function parse(raw) {
  const active = new Set();
  const unknown = [];
  String(raw || '').split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean).forEach((tok) => {
    const m = /^B?(\d{1,2})$/.exec(tok);
    const id = m ? 'B' + String(Number(m[1])).padStart(2, '0') : tok;
    if (KNOWN[id]) active.add(id); else unknown.push(tok);
  });
  return { active, unknown };
}

let state = parse(config.BUG_MODE_RAW);
if (state.unknown.length) console.warn('[bugs] ไม่รู้จักรหัส BUG_MODE:', state.unknown.join(','));

module.exports = {
  KNOWN,
  parse,
  /** true ถ้าบั๊ก id เปิดอยู่ (และ TEST_MODE=1) */
  on(id) { return config.TEST_MODE && state.active.has(id); },
  /** รายการบั๊กที่เปิดอยู่จริง */
  list() { return config.TEST_MODE ? [...state.active].sort() : []; },
  /** ตั้งใหม่ระหว่างรัน (ใช้โดย PUT /api/test/bugs เท่านั้น) */
  set(raw) { state = parse(raw); return { active: this.list(), unknown: state.unknown }; },
};
