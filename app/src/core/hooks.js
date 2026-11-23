'use strict';
// [B01] จุดต่อระหว่างโมดูล (โมดูลลงทะเบียนตอน register() · core เรียกตามจังหวะ)
//  beforeRequest(fn(req))  ทุก HTTP request ยกเว้น /api/test/* (CONTRACT 0.7) → B07 ประเมินแจ้งเตือน SLA + ยกเลิกอัตโนมัติ
//  afterReset(fn())        หลัง reset+seed เสร็จ (ล้าง cache ในหน่วยความจำของโมดูล)
//  extendSchema(sql)       เพิ่ม CREATE TABLE/INDEX ของโมดูล (รันทุกครั้งที่สร้าง DB ใหม่) · ต้องเรียกตอนโหลดโมดูล (ก่อน reset แรก)
//  provide(name, fn) / use(name)  แชร์ฟังก์ชันข้ามโมดูลโดยไม่ require กันตรง ๆ (เช่น 'bellCount')
const db = require('./db');

const before = [];
const reset = [];
const services = new Map();

module.exports = {
  beforeRequest(fn) { before.push(fn); },
  afterReset(fn) { reset.push(fn); },
  extendSchema(sql) { db._extraSchema.push(sql); },
  provide(name, fn) { services.set(name, fn); },
  use(name) { return services.get(name); },
  has(name) { return services.has(name); },
  _runBefore(req) { for (const fn of before) fn(req); },
  _runAfterReset() { for (const fn of reset) fn(); },
};
