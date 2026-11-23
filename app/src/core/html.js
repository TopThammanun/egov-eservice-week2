'use strict';
// [B01] โครงหน้า HTML ร่วม (CONTRACT 2.1) · โมดูลสร้างแค่ body แล้วเรียก html.send(req, res, { title, body })
// header มี app-header user-name user-role logout-btn + เมนูตามบทบาท + nav-bell/bell-count (officer/head)
// CSS: /app.css (B01 พื้นฐาน) + /ui.css (B11 · ถ้ามี) · JS: /app.js (ตัวช่วย api() showError() ฯลฯ)
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const hooks = require('./hooks');
const { esc, ROLE_TH } = require('./format');

const NAV = {
  citizen: [['nav-my-cases', '/citizen', 'คำขอของฉัน']],
  officer: [['nav-queue', '/officer/queue', 'คิวงาน']],
  head: [['nav-queue', '/officer/queue', 'คิวงาน'], ['nav-approvals', '/head/approvals', 'รออนุมัติ']],
  executive: [['nav-dashboard', '/dashboard', 'Dashboard']],
  auditor: [['nav-audit', '/audit', 'Audit Trail']],
  admin: [['nav-admin-services', '/admin/services', 'บริการ'], ['nav-admin-holidays', '/admin/holidays', 'วันหยุด'], ['nav-admin-users', '/admin/users', 'ผู้ใช้']],
};

const hasUiCss = () => fs.existsSync(path.join(config.ROOT, 'public', 'ui.css'));

function bellCount(user) {
  const fn = hooks.use('bellCount'); // B07 provide('bellCount', (user) => n) ได้ · ไม่งั้นนับจากตาราง
  return fn ? fn(user) : db.get('SELECT COUNT(*) AS n FROM notifications WHERE username = ?', user.username).n;
}

function header(user) {
  if (!user || user.kind === 'register') {
    return `<header class="app-header" data-testid="app-header"><a class="brand" href="/">e-Service เทศบาลนครตัวอย่าง</a></header>`;
  }
  const nav = (NAV[user.role] || []).map(([t, href, label]) => `<a data-testid="${t}" href="${href}">${label}</a>`);
  if (user.role === 'officer' || user.role === 'head') {
    nav.push(`<a data-testid="nav-bell" href="/notifications"><span class="sr-only">แจ้งเตือน </span><span aria-hidden="true">🔔</span> <span data-testid="bell-count">${bellCount(user)}</span></a>`);
  }
  const dept = user.role === 'officer' ? ` data-dept="${esc(user.dept)}"` : '';
  return `<header class="app-header" data-testid="app-header">
  <a class="brand" href="/">e-Service เทศบาลนครตัวอย่าง</a>
  <nav aria-label="เมนูหลัก">${nav.join('')}</nav>
  <div class="who"><span data-testid="user-name">${esc(user.name)}</span>
  <span data-testid="user-role" data-role="${esc(user.role)}"${dept}>${esc(ROLE_TH[user.role] || user.role)}</span>
  <button type="button" data-testid="logout-btn" onclick="logout()">ออกจากระบบ</button></div>
</header>`;
}

/** หน้าเต็ม (string) */
function page(req, { title = 'e-Service', body = '', head = '', scripts = '' } = {}) {
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · e-Service เทศบาลนครตัวอย่าง</title>
<link rel="stylesheet" href="/app.css">${hasUiCss() ? '<link rel="stylesheet" href="/ui.css">' : ''}${head}
</head><body>
${header(req.user)}
<main id="main">
${body}
</main>
<div id="toast" data-testid="action-success" role="status" aria-live="polite" hidden></div>
<script src="/app.js"></script>${scripts}
</body></html>`;
}

function send(req, res, opts, status = 200) { res.status(status).type('html').send(page(req, opts)); }

function forbidden(req, res) {
  return send(req, res, { title: 'ไม่มีสิทธิ์', body: '<h1 data-testid="forbidden-msg" role="alert">ไม่มีสิทธิ์เข้าถึงหน้านี้</h1>' }, 403);
}
function notFound(req, res, text = 'ไม่พบคำขอ', testid = 'not-found-msg') {
  return send(req, res, { title: text, body: `<h1 data-testid="${testid}" role="alert">${esc(text)}</h1>` }, 404);
}

module.exports = { NAV, page, send, forbidden, notFound, header };
