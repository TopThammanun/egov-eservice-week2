'use strict';
// [B01] ลายเซ็นดิจิทัลจำลองของเอกสาร: HMAC-SHA256(DOC_SIGN_KEY, canonical(doc))
// B06 (docs.js) ต้องใช้ signDoc ตอนออกเอกสาร และ verifyDoc ตอนตรวจ (/verify) เพื่อให้ seed + tamper hook ใช้ได้ตรงกัน
// tamper hook แก้ applicant_name ในตาราง documents โดยไม่คำนวณ signature ใหม่ → verifyDoc = false → TAMPERED
const crypto = require('crypto');
const config = require('./config');

const FIELDS = ['doc_no', 'case_no', 'verify_code', 'service_id', 'applicant_name', 'issued_at', 'valid_until', 'signer'];

function canonical(doc) { return JSON.stringify(FIELDS.map((f) => (doc[f] == null ? '' : String(doc[f])))); }
function signDoc(doc) { return crypto.createHmac('sha256', config.DOC_SIGN_KEY).update(canonical(doc)).digest('hex'); }
function verifyDoc(doc) {
  if (!doc || typeof doc.signature !== 'string' || doc.signature.length !== 64) return false;
  return crypto.timingSafeEqual(Buffer.from(signDoc(doc), 'hex'), Buffer.from(doc.signature, 'hex'));
}

module.exports = { FIELDS, canonical, signDoc, verifyDoc };
