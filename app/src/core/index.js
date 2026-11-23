'use strict';
// [B01] ctx ที่ส่งให้ทุกโมดูล register(app, ctx) · require('../core') ได้ของชุดเดียวกัน
module.exports = {
  config: require('./config'),
  clock: require('./clock'),
  bugs: require('./bugs'),
  db: require('./db'),
  crypto: require('./crypto'),
  sign: require('./sign'),
  errors: require('./errors'),
  hooks: require('./hooks'),
  audit: require('./audit'),
  format: require('./format'),
  session: require('./session'),
  html: require('./html'),
  payments: require('./payments'),
  get seed() { return require('./seed'); },
  get testHooks() { return require('./testHooks'); },
  /** rules.js ของ B03 (หรือ {} ถ้ายังไม่มี) */
  get rules() { try { return require('../modules/rules'); } catch (e) { if (e.code === 'MODULE_NOT_FOUND') return {}; throw e; } },
};
