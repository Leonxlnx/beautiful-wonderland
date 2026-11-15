// Temporal QC on rendered frames: flags pops (frame-to-frame change far above its neighbours),
// frozen frames, and reports the change at every cut.  node tools/qc.mjs --name p1 [--fps 30]
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ROOT, parseArgs } from './lib.mjs';

const a = parseArgs(process.argv);
const dir = path.join(ROOT, 'out', 'frames', a.name || 'p1');
const fps = Number(a.fps || 30);
const CUTS = [3.7, 7.4, 11.1, 14.8, 22.1333, 29.5333, 36.9667].map((t) => Math.round(t * fps));
const files = fs.readdirSync(dir).filter((f) => /^f\d+\.png$/.test(f)).sort();
const W = 320, H = 180;
const load = async (f) => (await sharp(path.join(dir, f)).resize(W, H, { kernel: 'cubic' }).greyscale().raw().toBuffer());
let prev = null, prevIdx = -1;
const diffs = [];
for (const f of files) {
  const idx = Number(f.slice(1, 6));
  const cur = await load(f);
  if (prev && idx === prevIdx + 1) {
    let s = 0; for (let i = 0; i < cur.length; i++) s += Math.abs(cur[i] - prev[i]);
    diffs.push({ idx, d: s / cur.length });
  }
  prev = cur; prevIdx = idx;
}
const med = (arr) => { const s = [...arr].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
const out = { frames: files.length, pairs: diffs.length, cuts: [], pops: [], frozen: [], perShot: [] };
const bounds = [0, ...CUTS, 1e9];
for (let k = 0; k < bounds.length - 1; k++) {
  const seg = diffs.filter((x) => x.idx > bounds[k] && x.idx < bounds[k + 1]);
  if (!seg.length) continue;
  const m = med(seg.map((x) => x.d));
  out.perShot.push({ from: bounds[k], n: seg.length, median: +m.toFixed(2), max: +Math.max(...seg.map((x) => x.d)).toFixed(2) });
  for (let i = 0; i < seg.length; i++) {
    const loc = med(seg.slice(Math.max(0, i - 6), i + 7).map((x) => x.d));
    if (seg[i].d > Math.max(3.5 * loc, loc + 4)) out.pops.push({ frame: seg[i].idx, t: +(seg[i].idx / fps).toFixed(2), d: +seg[i].d.toFixed(2), local: +loc.toFixed(2) });
    if (seg[i].d < 0.02) out.frozen.push(seg[i].idx);
  }
}
for (const c of CUTS) { const x = diffs.find((q) => q.idx === c); if (x) out.cuts.push({ frame: c, d: +x.d.toFixed(1) }); }
console.log(JSON.stringify(out, null, 1));
