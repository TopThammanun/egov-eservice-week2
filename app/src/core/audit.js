'use strict';
// [B01] เขียน Audit Trail (append-only · ตาราง audit มี trigger กันแก้/ลบ)
// ใช้: ctx.audit.log(req.user, 'CLAIM', { caseNo, from: 'SUBMITTED', to: 'IN_REVIEW', detail: '' })
// เวลาใช้นาฬิกากลางเสมอ · event ตาม DECISIONS ข้อ 13 · detail ตาม CONTRACT 6.8
const db = require('./db');
const clock = require('./clock');

const EVENTS = ['STAFF_LOGIN', 'CLAIM', 'RETURN', 'FORWARD', 'APPROVE', 'REJECT', 'ISSUE', 'UNMASK', 'EXPORT', 'ADMIN_CHANGE'];

function log(user, event, { caseNo = null, from = null, to = null, detail = '' } = {}) {
  if (!EVENTS.includes(event)) throw new Error(`unknown audit event ${event}`);
  const r = db.run(
    'INSERT INTO audit(time, username, role, event, case_no, from_status, to_status, detail) VALUES (?,?,?,?,?,?,?,?)',
    clock.nowISO(), (user && user.username) || '', (user && user.role) || '', event, caseNo, from, to, detail || '');
  return r.lastInsertRowid;
}

module.exports = { EVENTS, log };
