'use strict';
// [B01] เข้ารหัสข้อมูลส่วนบุคคล at rest (NFR-04) + hash รหัสผ่าน + เลขสุ่ม
// encrypt/decrypt: AES-256-GCM 'v1:<iv b64>:<tag b64>:<ct b64>' · lookupHash: HMAC-SHA256 hex (ค้นหาเลขบัตรโดยไม่ถอดรหัส)
const crypto = require('crypto');
const config = require('./config');

const KEY = crypto.createHash('sha256').update(config.DATA_KEY).digest(); // 32 ไบต์

function encrypt(text) {
  if (text == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

function decrypt(blob) {
  if (blob == null) return null;
  const [v, iv, tag, ct] = String(blob).split(':');
  if (v !== 'v1') throw new Error('bad ciphertext');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

function lookupHash(text) {
  return crypto.createHmac('sha256', config.LOOKUP_KEY).update(String(text)).digest('hex');
}

// รหัสผ่าน: scrypt (cache ผล hash ต่อรหัส+salt เพื่อให้ reset เร็ว)
const pwCache = new Map();
function hashPassword(pw, salt = crypto.randomBytes(8).toString('hex')) {
  const k = salt + '\0' + pw;
  if (!pwCache.has(k)) pwCache.set(k, crypto.scryptSync(pw, salt, 32).toString('hex'));
  return `${salt}:${pwCache.get(k)}`;
}
function verifyPassword(pw, stored) {
  if (typeof pw !== 'string' || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  const calc = hashPassword(pw, salt).split(':')[1];
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(calc, 'hex'));
}

/** สตริงสุ่มจากชุดอักษร (ค่าเริ่ม: A-Z 2-9 ไม่มี 0 O 1 I) */
function randomCode(len = 8, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') {
  const b = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[b[i] % alphabet.length];
  return s;
}

module.exports = { encrypt, decrypt, lookupHash, hashPassword, verifyPassword, randomCode, randomId: () => crypto.randomBytes(24).toString('base64url') };
