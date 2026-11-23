'use strict';
// [B01] นาฬิกากลาง Asia/Bangkok (+07:00 ไม่มี DST)
// ห้ามใช้ Date.now()/new Date() ตรง ๆ ในกฎธุรกิจ → ใช้ clock.now() / clock.nowISO()
// รูปแบบเวลาที่เก็บใน DB และส่งใน API: 'YYYY-MM-DDTHH:mm:ss+07:00' (เทียบแบบสตริงได้เพราะ offset เดียวกัน)
// วันที่ล้วน: 'YYYY-MM-DD' (ตามเวลาไทย)
const config = require('./config');

const OFFSET_MS = 7 * 3600 * 1000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

let frozenMs = config.TEST_MODE ? Date.parse(config.DEFAULT_NOW) : null;

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** ms (epoch) → '2026-12-01T09:00:00+07:00' */
function toISO(ms) {
  if (ms instanceof Date) ms = ms.getTime();
  const d = new Date(ms + OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+07:00`;
}

/** ISO ที่มี offset (หรือ Z) → ms · ไม่ถูกต้อง → NaN · 'YYYY-MM-DD' = 00:00 เวลาไทย */
function parse(iso) {
  if (typeof iso !== 'string') return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return Date.parse(iso + 'T00:00:00+07:00');
  const m = ISO_RE.exec(iso);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s] = m.map((v, i) => (i >= 1 && i <= 6 ? Number(v || 0) : v));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return NaN;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return NaN;
  // ตรวจว่าวันที่มีจริง (กัน 2026-02-30)
  const back = new Date(Date.UTC(y, mo - 1, d));
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return NaN;
  return ms;
}

/** ISO ใด ๆ → รูปแบบมาตรฐาน +07:00 (null ถ้าไม่ถูก) */
function normalize(iso) { const ms = parse(iso); return Number.isNaN(ms) ? null : toISO(ms); }

/** ส่วนประกอบตามเวลาไทย · dow: 0=อา. … 6=ส. */
function parts(msOrIso) {
  const ms = typeof msOrIso === 'string' ? parse(msOrIso) : msOrIso;
  const d = new Date(ms + OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds(), dow: d.getUTCDay() };
}

/** สร้างเวลาไทย → ms (เดือน 1–12 · ค่าเกินช่วงล้นได้แบบ Date.UTC) */
function make(y, m, d, hh = 0, mm = 0, ss = 0) { return Date.UTC(y, m - 1, d, hh, mm, ss) - OFFSET_MS; }

/** 'YYYY-MM-DD' ตามเวลาไทย */
function dateStr(msOrIso) { const p = parts(msOrIso); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; }

/** บวกวันปฏิทินให้ 'YYYY-MM-DD' */
function addDays(dateYmd, n) {
  const [y, m, d] = dateYmd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** วันในสัปดาห์ของ 'YYYY-MM-DD' (0=อา.) */
function dowOf(dateYmd) { const [y, m, d] = dateYmd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }

/** ปี พ.ศ. ของเวลา (ตามเวลาไทย) */
function yearBE(msOrIso) { return parts(msOrIso).y + 543; }

module.exports = {
  /** ms ปัจจุบัน (TEST_MODE: นาฬิกาแช่แข็ง · ปกติ: เวลาเครื่อง) */
  now() { return frozenMs != null ? frozenMs : Date.now(); },
  nowISO() { return toISO(this.now()); },
  today() { return dateStr(this.now()); },
  /** ตั้งนาฬิกา (แช่แข็ง) · คืน ISO มาตรฐาน หรือ null ถ้า ISO ไม่ถูก/ไม่มี offset */
  set(iso) { const ms = parse(iso); if (Number.isNaN(ms) || /^\d{4}-\d{2}-\d{2}$/.test(iso)) return null; frozenMs = ms; return toISO(ms); },
  reset() { frozenMs = config.TEST_MODE ? Date.parse(config.DEFAULT_NOW) : null; return this.nowISO(); },
  isFrozen() { return frozenMs != null; },
  toISO, parse, normalize, parts, make, dateStr, addDays, dowOf, yearBE, pad,
  OFFSET_MS,
};
