// Review contact sheets (JPEG) from rendered frames or from a video.
//   node tools/sheet.mjs --name v1 [--from 0] [--to 40] [--step 2.0] [--cols 4] [--cell 640] [--out out/sheets/v1_a.jpg]
//   node tools/sheet.mjs --video out/video/v1.mp4 [--from 0] [--to 40] [--step 2.0] [--cols 4] [--cell 640] [--out ...]
// Times are film seconds, from inclusive, to exclusive. With --name the nearest existing frame in
// out/frames/<name>/ is used for each time (duplicates dropped). Sheets are capped at --maxw 2600 px wide.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { ROOT, contactSheet, parseArgs } from './lib.mjs';

sharp.concurrency(4);
const die = (msg) => { console.error('sheet: ' + msg); process.exit(2); };
const a = parseArgs(process.argv);
const opt = (k, def) => (a[k] === undefined || a[k] === true ? def : a[k]);
const VIDEO = a.video && a.video !== true ? path.resolve(ROOT, String(a.video)) : null;
const NAME = a.name && a.name !== true ? String(a.name) : null;
if (!VIDEO && !NAME) die('give --name <frames name> or --video <file.mp4>');
const FROM = Number(opt('from', 0)), STEP = Number(opt('step', 2));
let TO = Number(opt('to', 40));
const COLS = Math.max(1, Math.floor(Number(opt('cols', 4))));
const MAXW = Number(opt('maxw', 2600)), GAP = 6;                 // GAP matches contactSheet()
const CELL = Math.max(64, Math.min(Math.floor(Number(opt('cell', 640))), Math.floor((MAXW - (COLS + 1) * GAP) / COLS)));
if (![FROM, TO, STEP].every(Number.isFinite) || STEP <= 0) die('bad --from/--to/--step');
const OUT = path.resolve(ROOT, String(opt('out', path.join('out', 'sheets', `${NAME || path.parse(VIDEO).name}.jpg`))));
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const times = [];
for (let k = 0; ; k++) { const t = FROM + k * STEP; if (t >= TO - 1e-9 && k > 0) break; times.push(+t.toFixed(6)); if (t >= TO) break; }

const files = [], labels = [];
let tmpDir = null;
if (!VIDEO) {
  const dir = path.join(ROOT, 'out', 'frames', NAME);
  let fps = 30;
  try { fps = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).fps || 30; } catch {}
  if (a.fps && a.fps !== true) fps = Number(a.fps);
  const idx = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => /^f(\d{5})\.png$/.exec(f)).filter(Boolean).map((m) => +m[1]).sort((x, y) => x - y) : [];
  if (!idx.length) die(`no frames in ${dir}`);
  const used = new Set();
  for (const t of times) {
    let best = idx[0];
    for (const i of idx) if (Math.abs(i / fps - t) < Math.abs(best / fps - t)) best = i;
    if (used.has(best)) continue;
    used.add(best);
    files.push(path.join(dir, `f${String(best).padStart(5, '0')}.png`));
    labels.push(`t=${(best / fps).toFixed(2)}s  f${best}`);
  }
} else {
  if (!fs.existsSync(VIDEO)) die(`video not found: ${VIDEO}`);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate:format=duration', '-of', 'json', VIDEO], { encoding: 'utf8' }));
  const [n, d] = probe.streams[0].r_frame_rate.split('/').map(Number);
  const fps = n / (d || 1), dur = Number(probe.format.duration);
  tmpDir = fs.mkdtempSync(path.join(path.dirname(OUT), '.sheet-'));
  const used = new Set();
  for (const t0 of times) {
    const fi = Math.min(Math.round(t0 * fps), Math.floor(dur * fps) - 1);    // stay inside the video
    if (fi < 0 || used.has(fi)) continue;
    used.add(fi);
    const t = fi / fps, f = path.join(tmpDir, `c${String(files.length).padStart(3, '0')}.png`);
    // -ss before -i is frame-accurate when transcoding; the decoder's colour tags drive YUV->RGB.
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', t.toFixed(6), '-i', VIDEO, '-frames:v', '1', '-threads', '4',
      '-vf', `scale=${CELL}:-2:flags=lanczos+accurate_rnd+full_chroma_int,format=rgb24`, '-update', '1', f]);
    if (!fs.existsSync(f)) continue;
    files.push(f);
    labels.push(`t=${t.toFixed(2)}s  #${fi}`);
  }
}
if (!files.length) die('no frames selected');
await contactSheet(files, OUT, { cols: Math.min(COLS, files.length), cellW: CELL, labels });
if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
const m = await sharp(OUT).metadata();
console.log(`sheet: ${path.relative(ROOT, OUT)}  ${files.length} cells, ${m.width}x${m.height}`);
