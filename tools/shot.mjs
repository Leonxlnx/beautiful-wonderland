// Render look-dev stills.
//   node tools/shot.mjs --name sky --size 1920x1080 --t 0,10,20            (film time)
//   node tools/shot.mjs --name a --view "70,6,40/-20,12,0/42/0" [--view2 ...] (free views: pos/look/fov/tod[/g])
//   node tools/shot.mjs --name a --views views.json                         ([{pos,look,fov,tod,ground,reflect,label}])
// Options: --tiles 2x2, --q film|high|live, --scale 0.5 (downscale saved PNG), --sheet (contact sheet)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, acquireGpu, startSession, savePng, contactSheet, parseArgs } from './lib.mjs';

const a = parseArgs(process.argv);
const name = a.name || 'shot';
const [W, H] = (a.size || '1920x1080').split('x').map(Number);
const [TX, TY] = (a.tiles || '1x1').split('x').map(Number);
const outDir = path.join(ROOT, 'out', 'shots');
fs.mkdirSync(outDir, { recursive: true });

const jobs = [];
const parseView = (s) => {
  const [p, l, fov, tod, g] = s.split('/');
  return { t: Number(a.time || 0), pos: p.split(',').map(Number), look: l.split(',').map(Number), fov: fov ? Number(fov) : 42, tod: tod ? Number(tod) : 0, ground: g === 'g', reflect: true };
};
if (a.views) for (const v of JSON.parse(fs.readFileSync(path.resolve(a.views), 'utf8'))) jobs.push({ t: v.t ?? 0, view: v, label: v.label });
for (const k of Object.keys(a)) if (/^view\d*$/.test(k)) jobs.push({ t: Number(a.time || 0), view: parseView(a[k]), label: a[k] });
if (a.t !== undefined) for (const t of String(a.t).split(',')) jobs.push({ t: Number(t), view: null, label: `t=${t}s` });
if (!jobs.length) jobs.push({ t: 0, view: null, label: 't=0s' });

const release = await acquireGpu('shot ' + name);
const s = await startSession({ quality: a.q || 'film', parts: a.parts || null });
console.log('GPU:', s.gpu);
const files = [];
let current = null;
s.setSink(async (buf) => { await savePng(buf, W, H, current, { scale: Number(a.scale || 1) }); });
for (let i = 0; i < jobs.length; i++) {
  const j = jobs[i];
  current = path.join(outDir, `${name}_${String(i).padStart(2, '0')}.png`);
  const r = await s.capture({ t: j.t, width: W, height: H, tilesX: TX, tilesY: TY, view: j.view, url: s.sinkUrl, frame: i });
  files.push(current);
  console.log(`${path.basename(current)}  ${j.label}  ${r.ms.toFixed(0)} ms  calls=${r.calls} tris=${r.tris}`);
}
if (a.sheet && files.length > 1) {
  const sheet = path.join(outDir, `${name}_sheet.jpg`);
  await contactSheet(files, sheet, { cols: Number(a.cols || 2), cellW: Number(a.cell || 960), labels: jobs.map((j) => j.label || '') });
  console.log('sheet:', sheet);
}
if (s.errors.length) console.log(`page reported ${s.errors.length} error/warn message(s)`);
await s.close();
release();
process.exit(0);
