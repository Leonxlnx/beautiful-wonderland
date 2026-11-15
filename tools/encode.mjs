// Frames (+ audio) -> H.264 MP4, BT.709 conversion and tags.
//   node tools/encode.mjs --name v1 [--fps 30] [--audio out/audio/mix.wav] [--out out/video/v1.mp4]
//                         [--crf 15] [--preset slow] [--scale 1920:-2] [--frames-step N] [--x]
//                         [--allow-gaps] [--threads 10]
// Frames are streamed to ffmpeg through a pipe in index order, so drafts rendered with --every N (only
// every Nth index exists) work: input rate = fps/N, then the fps filter repeats frames up to --fps so the
// video plays in real time and stays in sync with the audio. --frames-step N uses only indices divisible
// by N (default: detected from the files). Missing indices are an error unless --allow-gaps (holds the
// previous frame). Audio is padded/trimmed to exactly the video length (audio starts at the film time of
// the first frame). --x also writes <name>_x.mp4 next to --out: native frame size, CRF 18, maxrate 60M.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { ROOT, parseArgs } from './lib.mjs';

const die = (msg, code = 2) => { console.error('encode: ' + msg); process.exit(code); };
const a = parseArgs(process.argv);
if (!a.name || a.name === true) die('--name <name> is required');
const NAME = String(a.name);
const DIR = path.join(ROOT, 'out', 'frames', NAME);
if (!fs.existsSync(DIR)) die(`no frame folder ${DIR}`);
let meta = {};
try { meta = JSON.parse(fs.readFileSync(path.join(DIR, 'meta.json'), 'utf8')); } catch {}
const opt = (k, def) => (a[k] === undefined || a[k] === true ? def : a[k]);
const FPS = Number(opt('fps', meta.fps || 30));
const CRF = Number(opt('crf', 15));
const PRESET = String(opt('preset', 'slow'));
const THREADS = Number(opt('threads', 10));
const SCALE = a.scale && a.scale !== true ? String(a.scale) : null;
const OUT = path.resolve(ROOT, String(opt('out', path.join('out', 'video', `${NAME}.mp4`))));
const AUDIO = a.audio && a.audio !== true ? path.resolve(ROOT, String(a.audio)) : null;
if (!(FPS > 0) || !(CRF >= 0 && CRF <= 51)) die('bad --fps or --crf');
if (SCALE && !/^-?\d+:-?\d+$/.test(SCALE)) die(`bad --scale "${SCALE}" (expected e.g. 1920:-2)`);
if (AUDIO && !fs.existsSync(AUDIO)) die(`audio file not found: ${AUDIO}`);

// ---------- frame list ----------
const all = fs.readdirSync(DIR).map((f) => /^f(\d{5})\.png$/.exec(f)).filter(Boolean).map((m) => +m[1]).sort((x, y) => x - y);
if (!all.length) die(`no frames (f#####.png) in ${DIR}`);
const gcd = (x, y) => (y ? gcd(y, x % y) : x);
let step;
let idx = all;
if (a['frames-step'] !== undefined && a['frames-step'] !== true) {
  step = Math.floor(Number(a['frames-step']));
  if (!(step >= 1)) die('bad --frames-step');
  idx = all.filter((i) => i % step === 0);
  if (!idx.length) die(`no frame index divisible by ${step}`);
} else {
  step = all.length > 1 ? all.slice(1).reduce((g, v, k) => gcd(g, v - all[k]), 0) : meta.every || 1;
}
const firstIdx = idx[0], lastIdx = idx[idx.length - 1];
const slots = (lastIdx - firstIdx) / step + 1;
const have = new Set(idx);
const missing = [];
for (let i = firstIdx; i <= lastIdx; i += step) if (!have.has(i)) missing.push(i);
if (missing.length && !a['allow-gaps']) die(`${missing.length} frame(s) missing between f${firstIdx} and f${lastIdx} at step ${step} (first: ${missing.slice(0, 10).join(', ')}). Render them, or pass --allow-gaps / --frames-step N.`);

// PNG headers: every frame must be complete and the same size.
function pngInfo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, h = Buffer.alloc(24), e = Buffer.alloc(8);
    fs.readSync(fd, h, 0, 24, 0); fs.readSync(fd, e, 0, 8, Math.max(0, size - 8));
    if (h.readUInt32BE(0) !== 0x89504e47 || e.toString('ascii', 0, 4) !== 'IEND') return null;
    return { w: h.readUInt32BE(16), h: h.readUInt32BE(20) };
  } finally { fs.closeSync(fd); }
}
const framePath = (i) => path.join(DIR, `f${String(i).padStart(5, '0')}.png`);
let W = 0, H = 0;
for (const i of idx) {
  const inf = pngInfo(framePath(i));
  if (!inf) die(`f${i} is not a complete PNG (interrupted write?) - re-render it`);
  if (!W) { W = inf.w; H = inf.h; } else if (inf.w !== W || inf.h !== H) die(`f${i} is ${inf.w}x${inf.h}, expected ${W}x${H} (mixed sizes in ${DIR})`);
}
const outFrames = slots * step;            // frames at FPS
const DUR = outFrames / FPS;               // exact video duration, seconds
const T0 = firstIdx / FPS;                 // film time of the first frame
const GOP = Math.max(1, Math.round(2 * FPS));
console.log(`encode ${NAME}: ${idx.length} frames f${firstIdx}-f${lastIdx} step ${step} (${W}x${H}) -> ${outFrames} frames @ ${FPS} fps = ${DUR.toFixed(3)} s` +
  (missing.length ? `, ${missing.length} gap(s) held` : '') + (AUDIO ? `, audio ${path.relative(ROOT, AUDIO)} from ${T0.toFixed(3)} s` : ', no audio'));

// ---------- ffmpeg ----------
function videoFilter(scale) {
  const sc = scale ? (() => { const [w, h] = scale.split(':'); return `w=${w}:h=${h}`; })() : 'w=iw:h=ih';
  return [
    step > 1 ? `fps=${FPS}` : null,
    `scale=${sc}:flags=lanczos+accurate_rnd+full_chroma_int:in_range=pc:out_color_matrix=bt709:out_range=tv:out_chroma_loc=left`,
    'format=yuv420p',
    // ffmpeg 8 takes the stream colour tags from the frames: tag them (no pixel change) so the
    // -color_* options below and the frames agree.
    'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:chroma_location=left',
  ].filter(Boolean).join(',');
}

async function feedFrames(stdin) {
  let ok = true;
  stdin.on('error', () => { ok = false; });
  let prev = null;
  for (let i = firstIdx; i <= lastIdx && ok; i += step) {
    const file = have.has(i) ? framePath(i) : prev;     // gap: hold the previous frame
    prev = file;
    const buf = await fsp.readFile(file);
    if (!stdin.write(buf)) await Promise.race([once(stdin, 'drain'), once(stdin, 'close')]);
  }
  stdin.end();
}

async function encode({ out, crf, scale, extra = [], abitrate }) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const part = out + '.part';
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'warning', '-stats', '-y',
    '-f', 'image2pipe', '-framerate', `${FPS}/${step}`, '-c:v', 'png', '-i', 'pipe:0',
  ];
  if (AUDIO) args.push(...(T0 > 0 ? ['-ss', T0.toFixed(6)] : []), '-i', AUDIO);
  args.push(
    '-map', '0:v:0', '-vf', videoFilter(scale), '-frames:v', String(outFrames),
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', PRESET, '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-g', String(GOP), '-keyint_min', String(GOP), '-sc_threshold', '0', '-flags', '+cgop', '-threads', String(THREADS),
    ...extra,
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
  );
  if (AUDIO) {
    args.push('-map', '1:a:0',
      // video length wins: pad with silence / trim to exactly DUR (sample-exact, no -shortest rounding)
      '-af', `aresample=48000,apad=whole_dur=${DUR.toFixed(6)},atrim=end=${DUR.toFixed(6)},asetpts=PTS-STARTPTS`,
      '-c:a', 'aac', '-b:a', abitrate, '-ar', '48000', '-ac', '2');
  }
  args.push('-movflags', '+faststart+write_colr', '-video_track_timescale', String(FPS * 1000), '-f', 'mp4', part);
  console.log(`ffmpeg -> ${path.relative(ROOT, out)} (crf ${crf}${scale ? ', scale ' + scale : ''}${extra.length ? ', ' + extra.join(' ') : ''})`);
  const t0 = Date.now();
  const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
  try { os.setPriority(ff.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  const done = once(ff, 'close');
  await feedFrames(ff.stdin);
  const [code] = await done;
  if (code !== 0) { try { fs.unlinkSync(part); } catch {} die(`ffmpeg failed (exit ${code})`, 1); }
  fs.renameSync(part, out);
  console.log(`encoded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  report(out);
}

// ---------- ffprobe report ----------
function report(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { encoding: 'utf8' }));
  const v = j.streams.find((x) => x.codec_type === 'video');
  const au = j.streams.find((x) => x.codec_type === 'audio');
  const mb = (b) => (b ? (Number(b) / 1e6).toFixed(2) + ' Mb/s' : '?');
  const rate = (r) => { const [n, d] = String(r).split('/').map(Number); return d ? +(n / d).toFixed(3) : n; };
  const kf = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file], { encoding: 'utf8' })
    .split(/\r?\n/).filter((l) => /K/.test(l)).map((l) => Number(l.split(',')[0]));
  const gaps = kf.slice(1).map((t, k) => t - kf[k]);
  console.log(`\n${path.relative(ROOT, file)}  ${(Number(j.format.size) / 1e6).toFixed(2)} MB  duration ${Number(j.format.duration).toFixed(3)} s  total ${mb(j.format.bit_rate)}`);
  console.log(`  video: ${v.codec_name} (${v.profile}) level ${v.level / 10}  ${v.width}x${v.height}  ${rate(v.r_frame_rate)} fps (avg ${rate(v.avg_frame_rate)})  ${v.nb_frames} frames  ${Number(v.duration).toFixed(3)} s  ${v.pix_fmt}  ${mb(v.bit_rate)}`);
  console.log(`  colour: range=${v.color_range} matrix=${v.color_space} primaries=${v.color_primaries} trc=${v.color_transfer}`);
  console.log(`  keyframes: ${kf.length} at ${kf.slice(0, 6).map((t) => t.toFixed(2)).join(', ')}${kf.length > 6 ? ' ...' : ''}${gaps.length ? `  (GOP ${Math.min(...gaps).toFixed(2)}-${Math.max(...gaps).toFixed(2)} s)` : ''}`);
  if (au) console.log(`  audio: ${au.codec_name} (${au.profile}) ${au.sample_rate} Hz ${au.channel_layout || au.channels + ' ch'}  ${(Number(au.bit_rate) / 1000).toFixed(0)} kb/s  ${Number(au.duration).toFixed(3)} s`);
  else console.log('  audio: none');
}

await encode({ out: OUT, crf: CRF, scale: SCALE, abitrate: '320k' });
if (a.x) {
  const xOut = path.join(path.dirname(OUT), `${NAME}_x.mp4`);
  await encode({ out: xOut, crf: 18, scale: null, extra: ['-maxrate', '60M', '-bufsize', '120M'], abitrate: '256k' });
}
