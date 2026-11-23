'use strict';
// [B01] session cookie (HttpOnly) เก็บในตาราง sessions → reset ล้างทุก session ให้เอง (CONTRACT 0.9)
// req.user (ตั้งโดย middleware ทุก request) =
//   staff:    { kind:'staff', username, name, role, dept, sid }
//   citizen:  { kind:'citizen', role:'citizen', citizenId, name, username:'citizen:<id>', registered:true, sid }
//   register: { kind:'register', role:'citizen', citizenId, name, registered:false, sid }  ← ThaiD ผ่านแต่ยังไม่ลงทะเบียน (ใช้ได้เฉพาะ /register)
// guard: api(...roles) → 401 UNAUTHENTICATED / 403 FORBIDDEN · page(...roles) → redirect /login / หน้า 403 forbidden-msg
const db = require('./db');
const clock = require('./clock');
const config = require('./config');
const { randomId } = require('./crypto');
const { HttpError } = require('./errors');

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}

function setCookie(res, sid) {
  res.append('Set-Cookie', `${config.SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax`);
}
function clearCookie(res) {
  res.append('Set-Cookie', `${config.SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** สร้าง session ใหม่ + ตั้ง cookie · who = { kind, username?, role, dept?, citizenId? } */
function create(res, who) {
  const sid = randomId();
  db.run('INSERT INTO sessions(sid, kind, username, role, dept, citizen_id, created_at) VALUES (?,?,?,?,?,?,?)',
    sid, who.kind, who.username || null, who.role, who.dept || '', who.citizenId || null, clock.nowISO());
  setCookie(res, sid);
  return sid;
}
/** ลบ session ปัจจุบัน + ลบ cookie */
function destroy(req, res) {
  if (req.user && req.user.sid) db.run('DELETE FROM sessions WHERE sid = ?', req.user.sid);
  clearCookie(res);
  req.user = null;
}
/** เปลี่ยน session register → citizen หลังลงทะเบียนสำเร็จ */
function upgrade(req, kind, role = req.user.role) {
  db.run('UPDATE sessions SET kind = ?, role = ? WHERE sid = ?', kind, role, req.user.sid);
  req.user = load(req.user.sid);
}

function load(sid) {
  if (!sid) return null;
  const s = db.get('SELECT * FROM sessions WHERE sid = ?', sid);
  if (!s) return null;
  if (s.kind === 'staff') {
    const u = db.get('SELECT name FROM users WHERE username = ?', s.username);
    if (!u) return null;
    return { kind: 'staff', sid, username: s.username, name: u.name, role: s.role, dept: s.dept || '' };
  }
  const c = db.get('SELECT id, name, registered FROM citizens WHERE id = ?', s.citizen_id);
  if (!c) return null;
  return { kind: s.kind, sid, role: 'citizen', dept: '', citizenId: c.id, name: c.name, username: `citizen:${c.id}`, registered: s.kind === 'citizen' };
}

/** middleware: ตั้ง req.user (หรือ null) */
function middleware(req, _res, next) {
  try { req.user = load(parseCookies(req.headers.cookie)[config.SESSION_COOKIE]); } catch (_) { req.user = null; }
  next();
}

const fullUser = (u) => u && u.kind !== 'register';

const guard = {
  /** API: ไม่ล็อกอิน (หรือ session register) → 401 · บทบาทไม่ตรง → 403 FORBIDDEN · roles ว่าง = ล็อกอินอย่างเดียว */
  api(...roles) {
    return (req, _res, next) => {
      if (!fullUser(req.user)) return next(new HttpError(401, 'UNAUTHENTICATED'));
      if (roles.length && !roles.includes(req.user.role)) return next(new HttpError(403, 'FORBIDDEN'));
      next();
    };
  },
  /** หน้า: ไม่ล็อกอิน → /login · session register → /register · บทบาทไม่ตรง → 403 forbidden-msg */
  page(...roles) {
    return (req, res, next) => {
      if (!req.user) return res.redirect('/login');
      if (req.user.kind === 'register') return res.redirect('/register');
      if (roles.length && !roles.includes(req.user.role)) return require('./html').forbidden(req, res);
      next();
    };
  },
};

module.exports = { parseCookies, create, destroy, upgrade, load, middleware, guard };
