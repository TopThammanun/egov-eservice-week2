'use strict';
// [B01] ประกอบ Express app: core middleware → /api/health → /api/test/* → hooks ต่อ request → static → โมดูล src/modules/*.js → 404/error
// โมดูลของแต่ละบล็อก: ไฟล์ src/modules/<ชื่อ>.js ที่ export { register(app, ctx), order? } (ไม่มี register = ไลบรารีล้วน เช่น rules.js)
const fs = require('fs');
const path = require('path');
const express = require('express');
const ctx = require('./core');

const { config, session, hooks, errors, html, format } = ctx;

function loadModules(app) {
  const dir = path.join(__dirname, 'modules');
  if (!fs.existsSync(dir)) return [];
  const mods = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().map((f) => {
    const m = require(path.join(dir, f));
    return { file: f, mod: m, order: typeof m.order === 'number' ? m.order : 100 };
  });
  mods.sort((a, b) => a.order - b.order || a.file.localeCompare(b.file));
  const loaded = [];
  for (const { file, mod } of mods) {
    if (typeof mod.register === 'function') { mod.register(app, ctx); loaded.push(file); }
  }
  return loaded;
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('trust proxy', true);

  // body ≥ 6 MB (CONTRACT 0.10) · multipart ให้โมดูลใช้ multer เอง (limits.fileSize > 5 MB แล้วตรวจเองเพื่อตอบ 400 FILE_TOO_LARGE)
  app.use(express.json({ limit: '8mb' }));
  app.use(express.urlencoded({ extended: false, limit: '8mb' }));
  app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(session.middleware);

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/api/test', ctx.testHooks.router());

  // CONTRACT 0.7: ทุก request (ยกเว้น /api/test/*) ประเมินแจ้งเตือน SLA + ยกเลิกอัตโนมัติ (B07 ลงทะเบียนผ่าน hooks.beforeRequest)
  app.use(errors.wrap((req, res, next) => { hooks._runBefore(req); next(); }));

  app.use(express.static(path.join(config.ROOT, 'public'), { index: false }));

  app.get('/', (req, res) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.kind === 'register') return res.redirect('/register');
    res.redirect(format.LANDING[req.user.role] || '/login');
  });

  app.locals.modules = loadModules(app);

  // 404
  app.use('/api', (req, res) => errors.send(res, 404, 'NOT_FOUND', 'Not Found'));
  app.use((req, res) => html.notFound(req, res, 'ไม่พบหน้านี้', 'page-not-found'));

  // error → JSON {"code","message"} (API) หรือหน้า HTML
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let e = err;
    if (!(e instanceof errors.HttpError)) {
      if (e && e.type === 'entity.parse.failed') e = new errors.HttpError(400, 'BAD_REQUEST', 'JSON ไม่ถูกต้อง');
      else if (e && e.type === 'entity.too.large') e = new errors.HttpError(400, 'FILE_TOO_LARGE');
      else { console.error('[error]', req.method, req.originalUrl, err); e = new errors.HttpError(500, 'INTERNAL'); }
    }
    if (res.headersSent) return;
    if (req.originalUrl.startsWith('/api/') || req.accepts(['json', 'html']) === 'json') return errors.send(res, e.status, e.code, e.message, e.extra);
    if (e.status === 403) return html.forbidden(req, res);
    if (e.status === 404) return html.notFound(req, res);
    if (e.status === 401) return res.redirect('/login');
    return html.send(req, res, { title: 'ผิดพลาด', body: `<p data-testid="action-error" role="alert">${format.esc(e.message)}</p>` }, e.status);
  });
  return app;
}

module.exports = { createApp };
