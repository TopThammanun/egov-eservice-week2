// [B12] สรุปผลจาก results/<file>.json → บรรทัดละ TC: สถานะ + error บรรทัดแรก
const fs = require('fs');
const f = process.argv[2] || 'results/last.json';
const j = JSON.parse(fs.readFileSync(f, 'utf8'));
const out = [];
const walk = (s) => { (s.specs||[]).forEach(sp => sp.tests.forEach(t => { const r = t.results[t.results.length-1]||{}; const tc=(sp.title.match(/TC-[A-Z]+-\d+/)||[sp.title])[0];
  const err = (r.error && r.error.message || '').replace(/\u001b\[[0-9;]*m/g,'').split('\n').filter(Boolean).slice(0, +process.argv[3]||3).join(' | ');
  const loc = r.error && r.error.location ? `${r.error.location.file.split('/').pop()}:${r.error.location.line}` : '';
  out.push(`${r.status==='passed'?'PASS':'FAIL'} ${tc} ${r.status==='passed'?'':loc+' '+err}`); })); (s.suites||[]).forEach(walk); };
j.suites.forEach(walk);
out.sort((a,b)=>a.split(' ')[1].localeCompare(b.split(' ')[1]));
console.log(out.join('\n'));
const p = out.filter(x=>x.startsWith('PASS')).length; console.log(`passed ${p}/${out.length}`);
