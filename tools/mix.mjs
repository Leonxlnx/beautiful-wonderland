// Soundtrack builder from real, downloaded audio files only. No generated sound of any kind: the graph is
// checked against ffmpeg's list of source filters (sine, anoisesrc, aevalsrc, anullsrc, ...) and refused if
// it contains one; every input is an existing file.
//   node tools/mix.mjs [--spec assets/audio/mix.json] [--out out/audio/mix.wav] [--dur 40] [--dry] [--keep]
// Spec (gains dB, times seconds; file paths relative to the project root or to the spec file):
// { "duration": 40,
//   "music": { "file": "...", "at": 0, "start": 12.3, "dur": null, "gain": 0, "fadeIn": 0.02, "fadeOut": 2.5 },
//   "sfx": [ { "file": "...", "at": 0, "start": 0, "dur": 12, "end": null, "gain": -18, "fadeIn": 1, "fadeOut": 2,
//              "loop": false, "pan": 0, "lowpass": null, "highpass": null } ],
//   "target": { "lufs": -14, "tp": -1.5 },
//   "duck": { "enabled": false, "threshold": -30, "ratio": 4, "attack": 20, "release": 400 } }
// at = position in the film, start = offset inside the file, dur = length in the film (default: to the film
// end). loop repeats the file region start..end (end defaults to the file end) until dur is filled.
// Optional per source: fadeInCurve / fadeOutCurve (afade curve names, default "tri"), declick (loops, default true).
// duck: sidechain-compresses the music under the sum of the SFX. pan: -1 left .. 0 centre .. 1 right.
// Output: 48 kHz stereo 24-bit WAV, exactly duration seconds, loudness-normalised (two-pass loudnorm,
// linear) to target.lufs with true peak <= target.tp; report in <out>_report.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { ROOT, parseArgs } from './lib.mjs';

const SR = 48000;
const a = parseArgs(process.argv);
const opt = (k, def) => (a[k] === undefined || a[k] === true ? def : a[k]);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const die = (msg, code = 2) => { console.error('mix: ' + msg); process.exit(code); };
const fx = (n) => Number(n.toFixed(6)).toString();

const SPEC = path.resolve(ROOT, String(opt('spec', 'assets/audio/mix.json')));
const OUT = path.resolve(ROOT, String(opt('out', 'out/audio/mix.wav')));
const REPORT = OUT.replace(/\.wav$/i, '') + '_report.json';
if (!fs.existsSync(SPEC)) die(`spec not found: ${SPEC}`);
let spec;
try { spec = JSON.parse(fs.readFileSync(SPEC, 'utf8')); } catch (e) { die(`spec ${rel(SPEC)} is not valid JSON: ${e.message}`); }

// ---------- validation ----------
const errors = [], warnings = [];
const DUR = Number(opt('dur', spec.duration ?? 40));
if (!(DUR > 0 && DUR <= 3600)) die(`duration must be a positive number of seconds (got ${opt('dur', spec.duration)})`);
const TOTAL = Math.round(DUR * SR);
const target = { lufs: -14, tp: -1.5, ...(spec.target || {}) };
if (!Number.isFinite(target.lufs) || target.lufs > -5 || target.lufs < -40) errors.push(`target.lufs must be between -40 and -5 (got ${target.lufs})`);
if (!Number.isFinite(target.tp) || target.tp > 0 || target.tp < -9) errors.push(`target.tp must be between -9 and 0 dBTP (got ${target.tp})`);
const CURVES = ['tri', 'qsin', 'hsin', 'esin', 'log', 'ipar', 'qua', 'cub', 'squ', 'cbr', 'par', 'exp', 'iqsin', 'ihsin', 'dese', 'desi', 'losi', 'sinc', 'isinc', 'nofade'];

function probe(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels,sample_rate,codec_name:format=duration', '-of', 'json', file], { encoding: 'utf8' }));
  if (!j.streams?.length) throw new Error('no audio stream');
  return { dur: Number(j.format.duration), channels: j.streams[0].channels, rate: Number(j.streams[0].sample_rate), codec: j.streams[0].codec_name };
}

function source(raw, kind, i) {
  const label = kind === 'music' ? 'music' : `sfx[${i}]`;
  const E = (m) => errors.push(`${label}${raw?.file ? ` (${path.basename(String(raw.file))})` : ''}: ${m}`);
  if (!raw || typeof raw !== 'object') { E('must be an object'); return null; }
  if (!raw.file || typeof raw.file !== 'string') { E('"file" is missing'); return null; }
  const cands = [path.resolve(ROOT, raw.file), path.resolve(path.dirname(SPEC), raw.file)];
  const file = cands.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!file) { E(`file not found (looked in ${cands.map(rel).join(' and ')})`); return null; }
  let info;
  try { info = probe(file); } catch (e) { E(`cannot read audio: ${String(e.message).split('\n')[0]}`); return null; }
  const n = (k, def, { min = -Infinity, max = Infinity } = {}) => {   // missing or null -> default
    const v = raw[k];
    if (v === undefined || v === null) return def;
    if (typeof v !== 'number' || !Number.isFinite(v)) { E(`"${k}" must be a number (got ${JSON.stringify(v)})`); return def; }
    if (v < min || v > max) { E(`"${k}" = ${v} is outside ${min}..${max}`); return def; }
    return v;
  };
  const s = {
    kind, file, fileDur: info.dur, channels: info.channels, rate: info.rate,
    at: n('at', 0, { min: 0 }), start: n('start', 0, { min: 0 }), gain: n('gain', 0, { min: -80, max: 24 }),
    fadeIn: n('fadeIn', 0, { min: 0 }), fadeOut: n('fadeOut', 0, { min: 0 }), pan: n('pan', 0, { min: -1, max: 1 }),
    lowpass: n('lowpass', null, { min: 10, max: 23999 }), highpass: n('highpass', null, { min: 10, max: 23999 }),
    loop: raw.loop === true, declick: raw.declick !== false,
    fadeInCurve: raw.fadeInCurve ?? 'tri', fadeOutCurve: raw.fadeOutCurve ?? 'tri',
  };
  for (const k of ['fadeInCurve', 'fadeOutCurve']) if (!CURVES.includes(s[k])) E(`"${k}" must be one of ${CURVES.join(', ')}`);
  if (raw.loop !== undefined && typeof raw.loop !== 'boolean') E('"loop" must be true or false');
  if (s.at >= DUR) E(`"at" = ${s.at} s is not inside the ${DUR} s film`);
  const dur = n('dur', DUR - s.at, { min: 0.001 });
  if (s.at + dur > DUR + 1e-6) E(`ends at ${fx(s.at + dur)} s (at ${s.at} + dur ${dur}), after the film end (${DUR} s)`);
  if (s.start >= info.dur) E(`"start" = ${s.start} s is past the end of the file (${info.dur.toFixed(3)} s)`);
  s.end = n('end', info.dur, { min: 0 });
  if (s.loop) {
    if (s.end > info.dur + 1e-3) E(`"end" = ${s.end} s is past the end of the file (${info.dur.toFixed(3)} s)`);
    if (s.end - s.start < 0.05) E(`loop region ${s.start}..${s.end} s is too short`);
    s.len = dur;
  } else {
    if (raw.end !== undefined && raw.end !== null) warnings.push(`${label}: "end" only applies to loops - ignored`);
    const avail = info.dur - s.start;
    s.len = Math.min(dur, avail);
    if (avail < dur - 1e-3 && raw.dur !== undefined) warnings.push(`${label} (${path.basename(file)}): file has only ${avail.toFixed(2)} s after start ${s.start}; it stops at film ${fx(s.at + s.len)} s instead of ${fx(s.at + dur)} s`);
  }
  if (s.len > 0 && s.fadeIn + s.fadeOut > s.len + 1e-6) E(`fadeIn + fadeOut (${s.fadeIn + s.fadeOut} s) is longer than the sound (${s.len.toFixed(3)} s)`);
  if (s.lowpass && s.highpass && s.highpass >= s.lowpass) E(`highpass ${s.highpass} Hz must be below lowpass ${s.lowpass} Hz`);
  s.dur = dur;
  return s;
}

const sources = [];
if (spec.music) { const m = source(spec.music, 'music', 0); if (m) sources.push(m); }
if (spec.sfx !== undefined && !Array.isArray(spec.sfx)) errors.push('"sfx" must be an array');
(Array.isArray(spec.sfx) ? spec.sfx : []).forEach((x, i) => { const s = source(x, 'sfx', i); if (s) sources.push(s); });
if (!spec.music && !(spec.sfx || []).length) errors.push('the spec has no music and no sfx');
const duck = { enabled: false, threshold: -30, ratio: 4, attack: 20, release: 400, ...(spec.duck || {}) };
if (duck.enabled) {
  if (!(duck.ratio >= 1 && duck.ratio <= 20)) errors.push('duck.ratio must be 1..20');
  if (!(duck.attack >= 0.01 && duck.attack <= 2000)) errors.push('duck.attack must be 0.01..2000 ms');
  if (!(duck.release >= 0.01 && duck.release <= 9000)) errors.push('duck.release must be 0.01..9000 ms');
  if (!(duck.threshold <= 0 && duck.threshold >= -60)) errors.push('duck.threshold must be -60..0 dBFS');
}
for (const w of warnings) console.warn('mix: warning: ' + w);
if (errors.length) { console.error(`mix: ${rel(SPEC)} has ${errors.length} problem(s):`); for (const e of errors) console.error('  - ' + e); process.exit(2); }

// ---------- filter graph ----------
function chain(s, k) {
  const f = [];
  if (s.channels === 1) f.push('pan=stereo|c0=c0|c1=c0');                 // mono: same signal both sides, unity
  f.push(`aresample=${SR}`, `aformat=sample_fmts=fltp:sample_rates=${SR}:channel_layouts=stereo`);
  const regionEnd = s.loop ? s.end : s.start + s.len;
  f.push(`atrim=start=${fx(s.start)}:end=${fx(regionEnd)}`, 'asetpts=N/SR/TB');
  if (s.loop) {
    const region = s.end - s.start, dc = Math.min(0.01, region / 4);
    if (s.declick) f.push(`afade=t=in:st=0:d=${fx(dc)}`, `afade=t=out:st=${fx(region - dc)}:d=${fx(dc)}`);
    f.push(`aloop=loop=-1:size=${Math.round(region * SR)}`, `atrim=end_sample=${Math.round(s.len * SR)}`, 'asetpts=N/SR/TB');
  }
  if (s.highpass) f.push(`highpass=f=${s.highpass}`);
  if (s.lowpass) f.push(`lowpass=f=${s.lowpass}`);
  if (s.pan) {
    const th = ((s.pan + 1) * Math.PI) / 4;
    f.push(`pan=stereo|c0=${Math.min(1, Math.SQRT2 * Math.cos(th)).toFixed(5)}*c0|c1=${Math.min(1, Math.SQRT2 * Math.sin(th)).toFixed(5)}*c1`);
  }
  if (s.gain) f.push(`volume=${s.gain}dB`);
  if (s.fadeIn > 0) f.push(`afade=t=in:st=0:d=${fx(s.fadeIn)}:curve=${s.fadeInCurve}`);
  if (s.fadeOut > 0) f.push(`afade=t=out:st=${fx(s.len - s.fadeOut)}:d=${fx(s.fadeOut)}:curve=${s.fadeOutCurve}`);
  if (s.at > 0) f.push(`adelay=delays=${Math.round(s.at * SR)}S:all=1`);
  f.push(`apad=whole_len=${TOTAL}`);                                     // every stream covers the whole film
  return `[${k}:a]${f.join(',')}[s${k}]`;
}
const amix = (labels, out) => (labels.length === 1 ? `${labels[0]}anull[${out}]` : `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest:dropout_transition=0[${out}]`);
const parts = sources.map(chain);
const musicK = sources.findIndex((s) => s.kind === 'music');
const sfxL = sources.map((s, k) => (s.kind === 'sfx' ? `[s${k}]` : null)).filter(Boolean);
let duckUsed = false;
if (duck.enabled && musicK >= 0 && sfxL.length) {
  duckUsed = true;
  const thr = Math.min(1, Math.max(0.000976563, 10 ** (duck.threshold / 20)));
  parts.push(amix(sfxL, 'sfxsum'), '[sfxsum]asplit=2[sfxmix][sc]',
    `[s${musicK}][sc]sidechaincompress=threshold=${thr.toFixed(6)}:ratio=${duck.ratio}:attack=${duck.attack}:release=${duck.release}:makeup=1[mduck]`,
    amix(['[mduck]', '[sfxmix]'], 'mix'));
} else {
  if (duck.enabled) warnings.push('duck.enabled needs music and at least one sfx - not applied');
  parts.push(amix(sources.map((_, k) => `[s${k}]`), 'mix'));
}
parts.push(`[mix]atrim=end_sample=${TOTAL},asetpts=N/SR/TB[out]`);
const GRAPH = parts.join(';');

// No generators: compare every filter name in the graph with ffmpeg's own list of source filters.
const SOURCE_FILTERS = new Set(execFileSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' })
  .split(/\r?\n/).map((l) => /^\s*\S+\s+(\S+)\s+\|->[AVN]\s/.exec(l)).filter(Boolean).map((m) => m[1]));
for (const name of GRAPH.split(/[;,]/).map((x) => x.replace(/^(\[[^\]]*\])+/, '').split(/[=[]/)[0].trim()).filter(Boolean)) {
  if (SOURCE_FILTERS.has(name) || /src$/.test(name)) die(`internal error: generator filter "${name}" in the graph - refusing (real recordings only)`);
}

console.log(`mix ${rel(SPEC)}: ${sources.length} source(s), ${DUR} s, target ${target.lufs} LUFS / ${target.tp} dBTP${duckUsed ? ', ducking on' : ''}`);
for (const s of sources) console.log(`  ${s.kind.padEnd(5)} ${path.basename(s.file).padEnd(44)} film ${fx(s.at).padStart(6)}-${fx(s.at + s.len).padEnd(7)} file ${fx(s.start)}${s.loop ? `-${fx(s.end)} loop` : ''}  ${s.gain >= 0 ? '+' : ''}${s.gain} dB${s.pan ? ` pan ${s.pan}` : ''}${s.highpass ? ` hp ${s.highpass}` : ''}${s.lowpass ? ` lp ${s.lowpass}` : ''}`);
if (a.dry) { console.log('\nfilter_complex:\n' + GRAPH.split(';').join(';\n')); process.exit(0); }

// ---------- ffmpeg helpers ----------
function ff(args, { quiet = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-nostats', '-threads', '2', '-filter_threads', '2', ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg exit ${code}:\n${err.split('\n').slice(-15).join('\n')}`))));
  });
}
const LRA_DEFAULT = Number(target.lra ?? 11);
async function loudnorm(file, lra = LRA_DEFAULT) {
  const err = await ff(['-i', file, '-af', `loudnorm=I=${target.lufs}:TP=${target.tp}:LRA=${lra}:print_format=json`, '-f', 'null', '-']);
  const j = JSON.parse(err.slice(err.lastIndexOf('{'), err.lastIndexOf('}') + 1));
  const v = (x) => (x === '-inf' ? -Infinity : Number(x));
  return { I: v(j.input_i), TP: v(j.input_tp), LRA: v(j.input_lra), thresh: v(j.input_thresh), offset: v(j.target_offset) };
}
async function ebur128(file) {
  const err = await ff(['-i', file, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-']);
  const s = err.slice(err.lastIndexOf('Summary:'));
  const g = (re) => { const m = re.exec(s); return m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : NaN; };
  return { I: g(/I:\s+(-?[\d.]+|-inf) LUFS/), LRA: g(/LRA:\s+(-?[\d.]+) LU/), TP: g(/True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/) };
}
function samplesOf(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration_ts,sample_rate,channels,bits_per_sample,codec_name', '-of', 'json', file], { encoding: 'utf8' }));
  return j.streams[0];
}
const tail = `apad=whole_len=${TOTAL},atrim=end_sample=${TOTAL},asetpts=N/SR/TB`;

// ---------- render ----------
const WORK = path.join(path.dirname(OUT), `.mixwork-${process.pid}`);
fs.mkdirSync(WORK, { recursive: true });
const cleanup = () => { if (!a.keep) fs.rmSync(WORK, { recursive: true, force: true }); };
process.on('exit', cleanup);
const t0 = Date.now();
const premaster = path.join(WORK, 'premaster.wav');      // 32-bit float: no clipping before the gain stage
await ff([...sources.flatMap((s) => ['-i', s.file]), '-filter_complex', GRAPH, '-map', '[out]', '-c:a', 'pcm_f32le', '-ar', String(SR), '-ac', '2', '-f', 'wav', premaster]);
const pre = await loudnorm(premaster);
console.log(`premaster: I ${pre.I.toFixed(2)} LUFS  LRA ${pre.LRA.toFixed(2)} LU  TP ${pre.TP.toFixed(2)} dBTP  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
if (!Number.isFinite(pre.I) || pre.I < -70) die('the mix is silent - check gains and times', 1);

// Linear gain is only possible when the peaks allow it; otherwise apply the gain into a true-peak-ish
// limiter (4x oversampled) first, re-measure, and repeat with more headroom if needed.
let src = premaster, m = pre, mode = 'linear';
const limiterPasses = [];
for (let iter = 0; iter < 3 && m.TP + (target.lufs - m.I) > target.tp - 0.1; iter++) {
  const gain = target.lufs - m.I, limitDb = target.tp - 1.0 - 0.5 * iter;
  const outF = path.join(WORK, `limited${iter}.wav`);
  await ff(['-i', src, '-af', `volume=${gain.toFixed(3)}dB,aresample=${SR * 4},alimiter=limit=${(10 ** (limitDb / 20)).toFixed(5)}:attack=5:release=80:level=0:latency=1,aresample=${SR},${tail}`,
    '-c:a', 'pcm_f32le', '-ar', String(SR), '-f', 'wav', outF]);
  src = outF; m = await loudnorm(src); mode = 'limited+linear';
  limiterPasses.push({ gainDb: +gain.toFixed(3), limitDb, after: { I: m.I, TP: m.TP, LRA: m.LRA } });
  console.log(`limiter pass ${iter + 1}: +${gain.toFixed(2)} dB into ${limitDb.toFixed(1)} dBFS limit -> I ${m.I.toFixed(2)}  TP ${m.TP.toFixed(2)}`);
}

// Pass 2: loudnorm with the measured values, linear mode. Then verify and, if the true peak still overshoots,
// redo from the float source with a small extra attenuation.
const lraT = Math.min(50, Math.max(LRA_DEFAULT, Math.ceil((m.LRA + 1) * 10) / 10));
const OUTTMP = path.join(WORK, 'final.wav');
let extra = 0, fin, lnType = '?', lnTP = NaN, lnFin = null;
for (let k = 0; k < 4; k++) {
  const err = await ff(['-i', src, '-af',
    `loudnorm=I=${target.lufs}:TP=${target.tp}:LRA=${lraT}:measured_I=${m.I}:measured_TP=${m.TP}:measured_LRA=${m.LRA}:measured_thresh=${m.thresh}:linear=true:print_format=json,` +
    `aresample=${SR},${extra ? `volume=${(-extra).toFixed(3)}dB,` : ''}${tail}`,
    '-c:a', 'pcm_s24le', '-ar', String(SR), '-ac', '2', '-map_metadata', '-1', '-fflags', '+bitexact', '-f', 'wav', OUTTMP]);
  lnType = JSON.parse(err.slice(err.lastIndexOf('{'), err.lastIndexOf('}') + 1)).normalization_type;
  fin = await ebur128(OUTTMP);
  lnFin = await loudnorm(OUTTMP); lnTP = lnFin.TP;
  const worst = Math.max(fin.TP, lnTP);
  if (worst <= target.tp) break;
  extra += worst - target.tp + 0.05;
  console.log(`true peak ${worst.toFixed(2)} > ${target.tp}: re-applying with ${(-extra).toFixed(2)} dB`);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.copyFileSync(OUTTMP, OUT);
const st = samplesOf(OUT);
const samples = Number(st.duration_ts);

const checks = {
  truePeakOk: Math.max(fin.TP, lnTP) <= target.tp,
  loudnessOk: Math.min(Math.abs(fin.I - target.lufs), Math.abs(lnFin.I - target.lufs)) <= 0.5, // the two meters differ by ~0.2 LU
  lengthOk: samples === TOTAL,
  format: `${st.codec_name} ${st.sample_rate} Hz ${st.channels} ch ${st.bits_per_sample}-bit`,
  linear: lnType === 'linear',
};
console.log(`\n${rel(OUT)}: ${checks.format}, ${samples} samples = ${(samples / SR).toFixed(6)} s (want ${TOTAL})`);
console.log(`result (loudnorm): integrated ${lnFin.I.toFixed(2)} LUFS  LRA ${lnFin.LRA.toFixed(2)} LU  true peak ${lnTP.toFixed(2)} dBTP`);
console.log(`result (ebur128):  integrated ${fin.I.toFixed(1)} LUFS  LRA ${fin.LRA.toFixed(1)} LU  true peak ${fin.TP.toFixed(1)} dBTP`);
console.log(`processing: ${mode}, loudnorm pass 2 = ${lnType}${extra ? `, extra ${(-extra).toFixed(2)} dB` : ''}`);

fs.writeFileSync(REPORT, JSON.stringify({
  spec: rel(SPEC), out: rel(OUT), duration: DUR, sampleRate: SR, channels: 2, bitDepth: 24, samples,
  target, duck: { ...duck, applied: duckUsed },
  sources: sources.map((s) => ({
    kind: s.kind, file: rel(s.file), fileDuration: +s.fileDur.toFixed(3), fileChannels: s.channels, fileRate: s.rate,
    at: s.at, start: s.start, length: +s.len.toFixed(6), filmEnd: +(s.at + s.len).toFixed(6), loop: s.loop, ...(s.loop ? { loopEnd: s.end } : {}),
    gain: s.gain, fadeIn: s.fadeIn, fadeOut: s.fadeOut, pan: s.pan, lowpass: s.lowpass, highpass: s.highpass,
  })),
  premaster: pre, processing: { mode, limiterPasses, loudnormType: lnType, loudnormLRATarget: lraT, extraAttenuationDb: +(-extra).toFixed(3) },
  result: { loudnorm: { integratedLUFS: lnFin.I, LRA: lnFin.LRA, truePeak: lnFin.TP }, ebur128: { integratedLUFS: fin.I, LRA: fin.LRA, truePeak: fin.TP } },
  checks, warnings, filtergraph: GRAPH, seconds: +((Date.now() - t0) / 1000).toFixed(1),
}, null, 2));
console.log(`report: ${rel(REPORT)}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
const ok = checks.truePeakOk && checks.loudnessOk && checks.lengthOk;
if (!ok) console.error('mix: CHECK FAILED ' + JSON.stringify(checks));
process.exit(ok ? 0 : 1);
