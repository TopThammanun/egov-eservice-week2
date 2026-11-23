'use strict';
// [B01] Test hook /api/test/* (CONTRACT ข้อ 8 · DECISIONS ข้อ 15) · TEST_MODE≠1 → 404 ทุก path
// ไม่ผ่าน beforeRequest hooks (CONTRACT 0.7) · ไม่ต้องล็อกอิน
const express = require('express');
const config = require('./config');
const db = require('./db');
const clock = require('./clock');
const bugs = require('./bugs');
const hooks = require('./hooks');
const payments = require('./payments');
const { seed } = require('./seed');
const { HttpError, send, wrap } = require('./errors');

/** ล้างทุกอย่าง (รวม session/OTP/แจ้งเตือน/audit/ไฟล์อัปโหลด) → seed ใหม่ → นาฬิกากลับค่าเริ่ม */
function reset() {
  db.recreate();
  seed();
  clock.reset();
  hooks._runAfterReset();
  return clock.nowISO();
}

function router() {
  const r = express.Router();
  r.use((req, res, next) => (config.TEST_MODE ? next() : send(res, 404, 'NOT_FOUND', 'Not Found')));

  r.post('/reset', wrap((req, res) => res.json({ ok: true, now: reset() })));

  r.get('/clock', (req, res) => res.json({ now: clock.nowISO() }));
  r.put('/clock', wrap((req, res) => {
    const iso = req.body && req.body.now;
    const out = typeof iso === 'string' ? clock.set(iso) : null;
    if (!out) throw new HttpError(400, 'INVALID_TIME');
    res.json({ now: out });
  }));

  r.post('/payments/:ref/pay', wrap((req, res) => {
    let amount = req.body ? req.body.amount : undefined;
    if (typeof amount === 'string' && amount.trim() !== '') amount = Number(amount);
    res.json(payments.pay(req.params.ref, amount));
  }));

  r.post('/documents/:docNo/tamper', wrap((req, res) => {
    // แก้ข้อมูลที่ลงนามไว้ (ชื่อผู้ยื่น) โดยไม่คำนวณ signature ใหม่ → sign.verifyDoc() = false → TAMPERED
    const ch = db.run("UPDATE documents SET applicant_name = applicant_name || ' (แก้ไข)' WHERE doc_no = ?", req.params.docNo).changes;
    if (!ch) throw new HttpError(404, 'NOT_FOUND', 'ไม่พบเอกสาร');
    res.json({ ok: true });
  }));

  // เสริม (ไม่อยู่ใน CONTRACT): ดู/สลับ BUG_MODE ระหว่างรันโดยไม่ต้องรีสตาร์ต · body {"bugs":"B03,B07"} หรือ "" = ปิดหมด
  r.get('/bugs', (req, res) => res.json({ active: bugs.list() }));
  r.put('/bugs', wrap((req, res) => res.json(bugs.set((req.body && req.body.bugs) || ''))));

  r.use((req, res) => send(res, 404, 'NOT_FOUND', 'Not Found'));
  return r;
}

module.exports = { router, reset };
