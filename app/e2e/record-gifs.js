// อัดวิดีโอ TC ระดับ P1 ทีละ TC แล้วย่อเป็น GIF → ../../test-report/report/gifs/<TC>.gif (PROMPTS ขั้น 4)
//   เปิดเว็บด้วย TEST_MODE=1 ก่อน แล้วรัน:
//     cd app/e2e && BASE_URL=http://127.0.0.1:3912 DB_PATH=<ไฟล์ฐานข้อมูลของเว็บ> node record-gifs.js [TC-AUTH-01 ...]
//   TC ที่ใช้หลาย context: เลือกวิดีโอไฟล์ใหญ่ที่สุด (context ที่มีการใช้งานหน้าจอมากที่สุด)
//   ต้องมี ffmpeg ของ Playwright (npx playwright install chromium) · ตั้ง FFMPEG=<path> เองได้
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const { PNG } = require('pngjs');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const P2 = new Set(['TC-AUTH-04', 'TC-SUBMIT-03', 'TC-PAY-04', 'TC-DASH-03', 'TC-RBAC-04', 'TC-RBAC-06', 'TC-NFR-03', 'TC-NFR-04']); // TEST-PLAN §1
const OUT = path.resolve(__dirname, '..', '..', 'test-report', 'report', 'gifs');
const REC = path.join(__dirname, 'results', 'rec');
const MAX_FRAMES = 30;

function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'), path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'), '/opt/ms-playwright'].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root).filter((x) => x.startsWith('ffmpeg-')).sort().reverse()) {
      const exe = fs.readdirSync(path.join(root, d)).find((f) => /^ffmpeg-(win64\.exe|linux|mac)/.test(f));
      if (exe) return path.join(root, d, exe);
    }
  }
  throw new Error('ไม่พบ ffmpeg ของ Playwright (รัน npx playwright install chromium หรือกำหนด FFMPEG)');
}
function allTcs() {
  const ids = [];
  for (const f of fs.readdirSync(__dirname).filter((x) => /^tests-.*\.spec\.ts$/.test(x))) {
    for (const m of fs.readFileSync(path.join(__dirname, f), 'utf8').matchAll(/test\('(TC-[A-Z]+-\d+)/g)) ids.push(m[1]);
  }
  return ids;
}
function webms(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? webms(path.join(dir, e.name)) : e.name.endsWith('.webm') ? [path.join(dir, e.name)] : []));
}
function toGif(ffmpeg, video, gif) {
  const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'egov-gif-'));
  cp.spawnSync(ffmpeg, ['-loglevel', 'error', '-y', '-i', video, '-r', '5', path.join(frames, 'f%04d.png')]);
  let files = fs.readdirSync(frames).sort();
  if (!files.length) { fs.rmSync(frames, { recursive: true, force: true }); return 0; }
  if (files.length > MAX_FRAMES) { const k = files.length / MAX_FRAMES; files = Array.from({ length: MAX_FRAMES }, (_, i) => files[Math.floor(i * k)]); }
  const enc = GIFEncoder();
  for (const f of files) {
    const im = PNG.sync.read(fs.readFileSync(path.join(frames, f)));
    const w = im.width, h = im.height, d = new Uint8Array(im.data.buffer, im.data.byteOffset, w * h * 4); // 800×450 เต็ม ให้อ่านข้อความบนจอได้
    const palette = quantize(d, 128);
    enc.writeFrame(applyPalette(d, palette), w, h, { palette, delay: 400 });
  }
  enc.finish();
  fs.writeFileSync(gif, enc.bytes());
  fs.rmSync(frames, { recursive: true, force: true });
  return files.length;
}

const ffmpeg = findFfmpeg();
const want = process.argv.slice(2).length ? process.argv.slice(2) : allTcs().filter((t) => !P2.has(t));
fs.mkdirSync(OUT, { recursive: true });
const rows = [];
for (const tc of want) {
  const dir = path.join(REC, tc);
  if (!process.env.BASE_URL) throw new Error('ต้องกำหนด BASE_URL (และ DB_PATH) ก่อนรัน');
  fs.rmSync(dir, { recursive: true, force: true });
  // รหัส TC ยาวเท่ากันทุกตัว (เลข 2 หลัก) จึงใช้เป็นตัวกรอง -g ได้โดยไม่ชนกัน
  const run = cp.spawnSync('npx', ['playwright', 'test', '-c', 'playwright.rec.config.ts', '-g', tc], { cwd: __dirname, env: { ...process.env, REC_DIR: dir }, shell: true, encoding: 'utf8' });
  const passed = run.status === 0;
  const vids = webms(dir).map((f) => ({ f, size: fs.statSync(f).size })).sort((a, b) => b.size - a.size);
  const frames = vids.length ? toGif(ffmpeg, vids[0].f, path.join(OUT, `${tc}.gif`)) : 0;
  rows.push(`${tc}\t${passed ? 'passed' : 'FAILED'}\t${vids.length} video\t${frames} frames`);
  console.log(rows[rows.length - 1]);
}
fs.writeFileSync(path.join(OUT, '..', 'map.tsv'), rows.join('\n') + '\n');
const bad = rows.filter((r) => /FAILED|\t0 frames/.test(r));
console.log(`gifs ${rows.length - bad.length}/${rows.length}${bad.length ? ' · มีปัญหา: ' + bad.map((r) => r.split('\t')[0]).join(' ') : ''}`);
process.exit(bad.length ? 1 : 0);
