'use strict';
// [B01] SQLite ผ่าน node:sqlite (ในตัว Node ≥ 22.13 ไม่ต้องคอมไพล์) · ไฟล์ = DB_PATH
// ใช้:  const { db } = ctx;  db.get(sql, ...p) · db.all(sql, ...p) · db.run(sql, ...p) · db.tx(() => {...})
// node:sqlite เป็นแบบ synchronous → ทุก handler ทำงานจบในรอบเดียว ไม่มี race (เลขคำขอไม่ซ้ำแม้จ่ายพร้อมกัน)
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { TABLES } = require('./schema');

fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });
const raw = new DatabaseSync(config.DB_PATH);
raw.exec('PRAGMA journal_mode = WAL');
raw.exec('PRAGMA foreign_keys = ON');
raw.exec('PRAGMA busy_timeout = 5000');

const stmtCache = new Map();
function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = raw.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
// node:sqlite ไม่รับ undefined → แปลงเป็น null · boolean → 0/1
const norm = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
const plain = (row) => (row ? { ...row } : row); // ตัด prototype null ของ node:sqlite

const extraSchema = []; // SQL ที่โมดูลอื่นเพิ่มผ่าน hooks.extendSchema (รันหลัง TABLES ทุกครั้งที่สร้างใหม่)
let depth = 0;

const db = {
  raw,
  /** แถวแรก หรือ undefined */
  get(sql, ...p) { return plain(prep(sql).get(...norm(p))); },
  /** ทุกแถว */
  all(sql, ...p) { return prep(sql).all(...norm(p)).map(plain); },
  /** INSERT/UPDATE/DELETE → { changes, lastInsertRowid } */
  run(sql, ...p) { const r = prep(sql).run(...norm(p)); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
  exec(sql) { raw.exec(sql); },
  /** ทำใน transaction (ซ้อนได้ · ชั้นในใช้ savepoint) · throw = rollback */
  tx(fn) {
    const sp = `sp${depth}`;
    raw.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    depth++;
    try {
      const out = fn();
      depth--;
      raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (e) {
      depth--;
      raw.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}`);
      if (depth > 0) raw.exec(`RELEASE ${sp}`);
      throw e;
    }
  },
  /** เลขรันถัดไปของตัวนับ (สร้างอัตโนมัติถ้ายังไม่มี เริ่ม 1) */
  nextSeq(name) {
    this.run('INSERT INTO counters(name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING', name);
    this.run('UPDATE counters SET value = value + 1 WHERE name = ?', name);
    return this.get('SELECT value FROM counters WHERE name = ?', name).value;
  },
  /** ลบทุกตารางแล้วสร้างใหม่ตาม schema (ใช้โดย reset เท่านั้น) */
  recreate() {
    stmtCache.clear();
    raw.exec('PRAGMA foreign_keys = OFF');
    const objs = raw.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table','trigger','index') AND name NOT LIKE 'sqlite_%'").all();
    for (const o of objs.filter((x) => x.type === 'trigger')) raw.exec(`DROP TRIGGER IF EXISTS "${o.name}"`);
    for (const o of objs.filter((x) => x.type === 'table')) raw.exec(`DROP TABLE IF EXISTS "${o.name}"`);
    for (const sql of TABLES) raw.exec(sql);
    for (const sql of extraSchema) raw.exec(sql);
    raw.exec('PRAGMA foreign_keys = ON');
  },
  isEmpty() {
    return !raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cases'").get();
  },
  _extraSchema: extraSchema,
};

module.exports = db;
