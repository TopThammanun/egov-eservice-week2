// [B12] สร้างตาราง BUGS.md §4 จาก results/<prefix>-<tag>.json  ·  node bug-table.js <prefix>
const fs = require('fs'), path = require('path');
const prefix = process.argv[2] || 'bug';
const dir = path.join(__dirname, 'results');
const must = { B01: ['TC-FEE-01'], B02: ['TC-UPLOAD-01'], B03: ['TC-SLA-01', 'TC-SLA-02'], B04: ['TC-SLA-02'], B05: ['TC-PAY-01'], B06: ['TC-RBAC-01'], B07: ['TC-RBAC-02'], B08: ['TC-QUEUE-02'], B09: ['TC-PDPA-02'], B10: ['TC-DASH-02'], B11: ['TC-PDPA-03', 'TC-AUDIT-01'], B12: ['TC-WORKFLOW-04'] };
const may = { B03: ['TC-SLA-03', 'TC-RBAC-04'], B07: ['TC-WORKFLOW-01'], B10: ['TC-DASH-01', 'TC-DASH-03'] };
function load(tag) {
  const f = path.join(dir, `${prefix}-${tag}.json`); if (!fs.existsSync(f)) return null;
  let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } const res = {};
  const walk = s => { (s.specs || []).forEach(sp => sp.tests.forEach(t => { const r = t.results[t.results.length - 1] || {}; const tc = (sp.title.match(/TC-[A-Z]+-\d+/) || [sp.title])[0];
    res[tc] = { ok: r.status === 'passed', msg: (r.error && r.error.message || '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').filter(Boolean).slice(0, 4).join(' ').replace(/\|/g, '\\|').slice(0, 220) }; })); (s.suites || []).forEach(walk); };
  j.suites.forEach(walk); return res;
}
const rows = [];
const modes = [['none', []], ...Object.keys(must).map(b => [b, b.split(',')]), ['B03_B07', ['B03', 'B07']], ['B01_B05_B09', ['B01', 'B05', 'B09']]];
for (const [tag, bugs] of modes) {
  const r = load(tag); if (!r) continue;
  const all = Object.keys(r); const failed = all.filter(k => !r[k].ok).sort();
  const exp = [...new Set(bugs.flatMap(b => must[b] || []))]; const opt = [...new Set(bugs.flatMap(b => may[b] || []))];
  const missed = exp.filter(t => !failed.includes(t)); const extra = failed.filter(t => !exp.includes(t) && !opt.includes(t));
  const okay = missed.length === 0 && extra.length === 0;
  rows.push({ tag, exp, opt, failed, extra, missed, passed: all.length - failed.length, total: all.length, okay, msgs: failed.map(t => `${t}: ${r[t].msg}`) });
}
console.log('| BUG_MODE | TC ที่ต้องล้ม (อาจล้มด้วย) | TC ที่ล้มจริง | ล้มเกินที่คาด | ควรล้มแต่ผ่าน | ผล |');
console.log('|---|---|---|---|---|---|');
for (const x of rows) console.log(`| ${x.tag === 'none' ? '(ปกติ)' : x.tag.replace(/_/g, ',')} | ${x.exp.join(' · ') || '–'}${x.opt.length ? ` (${x.opt.join(' · ')})` : ''} | ${x.failed.join(' · ') || '–'} | ${x.extra.join(' · ') || '–'} | ${x.missed.join(' · ') || '–'} | ${x.passed}/${x.total} passed ${x.okay ? '✅' : (x.missed.length ? '❌' : '⚠️')} |`);
console.log('\n<details><summary>ข้อความ assert ที่ล้ม</summary>\n');
for (const x of rows) for (const m of x.msgs) console.log(`- **${x.tag}** ${m}`);
console.log('\n</details>');
// รหัสออก: 0 เมื่อครบทุกโหมด ทุกโหมดตรงตาราง BUGS.md และรอบ "ไม่เปิดบั๊ก" ที่รันซ้ำ (none-2, none-3, …) ผ่านครบ
const pdir = path.dirname(path.join(dir, prefix)), pbase = path.basename(prefix); // prefix เป็นโฟลเดอร์ย่อยได้ เช่น node-final/bug
const rerunName = new RegExp('^' + pbase + '-none-[0-9]+[.]json$'); // bug-none-2.json, bug-none-3.json, … (ไม่รวมไฟล์ที่ตั้งชื่อเก็บไว้ เช่น *.flaky-upload.json)
const reruns = fs.readdirSync(pdir).filter(f => rerunName.test(f)).map(f => load(f.slice(pbase.length + 1, -5)));
const baseOk = rows.length > 0 && rows[0].tag === 'none' && rows[0].okay && reruns.every(r => r && Object.values(r).every(v => v.ok));
const caught = rows.filter(x => /^B\d+$/.test(x.tag) && x.okay).length;
const allOk = rows.length === modes.length && rows.every(x => x.okay) && baseOk;
console.log(`\nสรุป: จับบั๊กได้ตรงตาราง ${caught}/12 · รอบไม่เปิดบั๊ก ${1 + reruns.length} รอบ ${baseOk ? 'ผ่านครบ 51/51' : 'ไม่ผ่านครบ'} · ${allOk ? 'ผ่านเกณฑ์ BUGS.md §3' : 'ยังไม่ผ่านเกณฑ์ BUGS.md §3'}`);
process.exitCode = allOk ? 0 : 1;
