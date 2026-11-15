#!/usr/bin/env node
// audio-analyze.mjs - music analysis for cut planning (no Python, no native deps).
//
//   node tools/audio-analyze.mjs [options] <file> [<file> ...]
//
// Options
//   --out <json>          write results here (default: print summary only)
//   --img <dir>           render waveform / spectrogram / overview PNGs into <dir>
//   --meta <json>         sidecar metadata {"<basename>": {title, author, ...}} merged into output
//   --win <sec>           window length to propose (default 40)
//   --start <base>=<sec>  force the proposed window start for one file (repeatable);
//                         the automatic ranking is still reported as alternatives
//
// Pipeline per file
//   1. ffprobe duration; ffmpeg ebur128 (integrated loudness, LRA, true peak) for the
//      whole track and for the proposed window
//   2. ffmpeg decode -> mono 22.05 kHz f32le PCM on a pipe
//   3. STFT (2048 / hop 512, Hann) -> 64-band mel log-power -> spectral-flux onset
//      envelope (librosa-style); low band (<250 Hz) flux for downbeat phase
//   4. tempo: windowed onset autocorrelation (8 s tempogram) x log-normal prior;
//      confidence from pulse clarity, local tempo stability and beat salience
//   5. beat grid: Ellis dynamic-programming tracker over the whole track
//   6. RMS per 0.5 s, spectral centroid per 0.5 s, onset peaks (accents)
//   7. section changes: Foote checkerboard novelty on a 0.5 s self-similarity matrix
//   8. 40 s window search (phrase start, rising energy, lift at 22-28 s, quiet end)

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SR = 22050;
const NFFT = 2048;
const HOP = 512;
const FPS = SR / HOP; // onset-envelope frame rate (~43.07 Hz)
const NMEL = 64;
const BLOCK = 0.5; // seconds per energy/brightness block

// ---------------------------------------------------------------- CLI
const argv = process.argv.slice(2);
const opts = { out: null, img: null, meta: null, win: 40, starts: {}, files: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') opts.out = argv[++i];
  else if (a === '--img') opts.img = argv[++i];
  else if (a === '--meta') opts.meta = argv[++i];
  else if (a === '--win') opts.win = parseFloat(argv[++i]);
  else if (a === '--start') { const [k, v] = argv[++i].split('='); opts.starts[k] = parseFloat(v); }
  else opts.files.push(a);
}
if (!opts.files.length) {
  console.error('usage: node tools/audio-analyze.mjs [--out f.json] [--img dir] [--meta m.json] [--win 40] [--start base=sec] files...');
  process.exit(1);
}
const meta = opts.meta && fs.existsSync(opts.meta) ? JSON.parse(fs.readFileSync(opts.meta, 'utf8')) : {};

// ---------------------------------------------------------------- helpers
const r3 = (x) => Math.round(x * 1000) / 1000;
const r2 = (x) => Math.round(x * 100) / 100;
const r1 = (x) => Math.round(x * 10) / 10;
const mean = (a, s = 0, e = a.length) => { let t = 0, n = 0; for (let i = Math.max(0, s); i < Math.min(a.length, e); i++) { t += a[i]; n++; } return n ? t / n : NaN; };
const std = (a) => { const m = mean(a); let t = 0; for (const x of a) t += (x - m) ** 2; return Math.sqrt(t / Math.max(1, a.length - 1)); };
const median = (a) => { const b = Float64Array.from(a).sort(); return b.length ? b[b.length >> 1] : NaN; };
const pct = (a, p) => { const b = Float64Array.from(a).sort(); return b[Math.min(b.length - 1, Math.max(0, Math.round(p * (b.length - 1))))]; };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const dbOf = (x) => 20 * Math.log10(Math.max(x, 1e-9));

function ffprobeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return parseFloat(r.stdout.trim());
}

function ebur128(file, ss = null, t = null) {
  const args = ['-hide_banner', '-nostats'];
  if (ss != null) args.push('-ss', String(ss));
  if (t != null) args.push('-t', String(t));
  args.push('-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-');
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  const s = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const g = (re) => { const m = s.match(re); return m ? parseFloat(m[1]) : null; };
  return {
    integratedLUFS: g(/I:\s+(-?[\d.]+|-inf) LUFS/),
    loudnessRangeLU: g(/LRA:\s+(-?[\d.]+) LU/),
    truePeakDBTP: g(/Peak:\s+(-?[\d.]+|-inf) dBFS/),
  };
}

function decode(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1']);
    const chunks = [];
    p.stdout.on('data', (c) => chunks.push(c));
    let err = '';
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg decode failed: ' + err));
      const buf = Buffer.concat(chunks);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % 4));
      resolve(new Float32Array(ab));
    });
  });
}

// iterative radix-2 FFT (in place) on re/im arrays of length n (power of 2)
function makeFFT(n) {
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let x = i, y = 0; for (let b = 0; b < levels; b++) { y = (y << 1) | (x & 1); x >>= 1; } rev[i] = y; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  return (re, im) => {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const tre = re[j + half] * cos[k] + im[j + half] * sin[k];
          const tim = -re[j + half] * sin[k] + im[j + half] * cos[k];
          re[j + half] = re[j] - tre; im[j + half] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  };
}

const hz2mel = (f) => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m) => 700 * (10 ** (m / 2595) - 1);
function melBank(nMel, nfft, sr, fmin = 30, fmax = sr / 2) {
  const nb = nfft / 2 + 1;
  const mmin = hz2mel(fmin), mmax = hz2mel(fmax);
  const pts = Array.from({ length: nMel + 2 }, (_, i) => mel2hz(mmin + ((mmax - mmin) * i) / (nMel + 1)));
  const bank = [];
  for (let m = 0; m < nMel; m++) {
    const lo = pts[m], c = pts[m + 1], hi = pts[m + 2];
    const w = new Float64Array(nb);
    for (let k = 0; k < nb; k++) {
      const f = (k * sr) / nfft;
      if (f > lo && f < hi) w[k] = f <= c ? (f - lo) / (c - lo) : (hi - f) / (hi - c);
    }
    bank.push({ w, center: c });
  }
  return bank;
}

// ---------------------------------------------------------------- core analysis
function stftFeatures(x) {
  const nFrames = Math.floor(x.length / HOP) + 1;
  const pad = NFFT / 2;
  const win = new Float64Array(NFFT);
  for (let i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT);
  const fft = makeFFT(NFFT);
  const bank = melBank(NMEL, NFFT, SR);
  const nb = NFFT / 2 + 1;
  const lowBands = bank.map((b, i) => (b.center < 250 ? i : -1)).filter((i) => i >= 0);
  const melDb = new Float32Array(nFrames * NMEL);
  const centroid = new Float32Array(nFrames);
  const frameRms = new Float32Array(nFrames);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT), pw = new Float64Array(nb);
  for (let f = 0; f < nFrames; f++) {
    const start = f * HOP - pad;
    let e = 0;
    for (let i = 0; i < NFFT; i++) {
      const idx = start + i;
      const v = idx >= 0 && idx < x.length ? x[idx] : 0;
      e += v * v;
      re[i] = v * win[i]; im[i] = 0;
    }
    frameRms[f] = Math.sqrt(e / NFFT);
    fft(re, im);
    let num = 0, den = 0;
    for (let k = 0; k < nb; k++) { pw[k] = re[k] * re[k] + im[k] * im[k]; const mag = Math.sqrt(pw[k]); num += mag * (k * SR / NFFT); den += mag; }
    centroid[f] = den > 1e-9 ? num / den : 0;
    for (let m = 0; m < NMEL; m++) {
      const w = bank[m].w; let s = 0;
      for (let k = 0; k < nb; k++) if (w[k]) s += w[k] * pw[k];
      melDb[f * NMEL + m] = 10 * Math.log10(Math.max(s, 1e-10));
    }
  }
  // clamp to 80 dB below the track max (librosa power_to_db top_db)
  let mx = -Infinity; for (const v of melDb) if (v > mx) mx = v;
  for (let i = 0; i < melDb.length; i++) if (melDb[i] < mx - 80) melDb[i] = mx - 80;
  // spectral flux onset envelope (mean of positive mel-dB differences), plus low-band flux
  const onset = new Float32Array(nFrames), onsetLow = new Float32Array(nFrames);
  for (let f = 1; f < nFrames; f++) {
    let s = 0, sl = 0;
    for (let m = 0; m < NMEL; m++) { const d = melDb[f * NMEL + m] - melDb[(f - 1) * NMEL + m]; if (d > 0) s += d; }
    for (const m of lowBands) { const d = melDb[f * NMEL + m] - melDb[(f - 1) * NMEL + m]; if (d > 0) sl += d; }
    onset[f] = s / NMEL; onsetLow[f] = sl / Math.max(1, lowBands.length);
  }
  return { nFrames, melDb, centroid, frameRms, onset, onsetLow };
}

// tempogram: autocorrelation of onset envelope in 8 s Hann windows, hop 1 s
function tempoEstimate(onset, startBpm = 110, stdOct = 1.0) {
  const acSize = Math.round(8 * FPS);
  const minLag = Math.max(1, Math.floor((60 * FPS) / 240)), maxLag = Math.ceil((60 * FPS) / 40);
  const hann = new Float64Array(acSize); for (let i = 0; i < acSize; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / acSize);
  const hop = Math.round(FPS);
  const frames = [];
  for (let s = 0; s + acSize <= onset.length; s += hop) {
    const seg = new Float64Array(acSize);
    let m = 0; for (let i = 0; i < acSize; i++) m += onset[s + i]; m /= acSize;
    for (let i = 0; i < acSize; i++) seg[i] = (onset[s + i] - m) * hann[i];
    const ac = new Float64Array(maxLag + 1);
    for (let lag = 0; lag <= maxLag; lag++) { let t = 0; for (let i = 0; i + lag < acSize; i++) t += seg[i] * seg[i + lag]; ac[lag] = t; }
    const a0 = ac[0];
    if (a0 > 1e-9) for (let lag = 0; lag <= maxLag; lag++) ac[lag] /= a0;
    frames.push({ t: s / FPS, ac });
  }
  const prior = (lag) => { const bpm = (60 * FPS) / lag; return Math.exp(-0.5 * ((Math.log2(bpm) - Math.log2(startBpm)) / stdOct) ** 2); };
  const meanAc = new Float64Array(maxLag + 1);
  for (const fr of frames) for (let l = 0; l <= maxLag; l++) meanAc[l] += fr.ac[l] / frames.length;
  const pickLag = (ac) => { let best = minLag, bv = -Infinity; for (let l = minLag; l <= maxLag; l++) { const v = ac[l] * prior(l); if (v > bv && ac[l] >= ac[l - 1] && ac[l] >= (ac[l + 1] ?? -Infinity)) { bv = v; best = l; } } return best; };
  // parabolic refinement of the lag
  const refine = (ac, l) => { const a = ac[l - 1], b = ac[l], c = ac[l + 1]; if (a == null || c == null) return l; const d = a - 2 * b + c; return d < 0 ? l + (0.5 * (a - c)) / d : l; };
  const lag = pickLag(meanAc);
  const lagR = refine(meanAc, lag);
  const bpm = (60 * FPS) / lagR;
  const pulseClarity = meanAc[lag];
  // local stability: fraction of windows whose own tempo matches (same, or octave related)
  let same = 0, octave = 0;
  const local = [];
  for (const fr of frames) {
    const ll = refine(fr.ac, pickLag(fr.ac));
    const b = (60 * FPS) / ll; local.push(b);
    const ratio = b / bpm;
    if (Math.abs(ratio - 1) < 0.04) same++;
    else if (Math.abs(ratio - 2) < 0.08 || Math.abs(ratio - 0.5) < 0.02 || Math.abs(ratio - 1.5) < 0.06 || Math.abs(ratio - 2 / 3) < 0.03) octave++;
  }
  const alt = [0.5, 2].map((k) => { const l = Math.round(lagR / k); return l >= minLag && l <= maxLag ? { bpm: r1(bpm * k), acStrength: r3(meanAc[l]) } : null; }).filter(Boolean);
  return { bpm, lagFrames: lagR, pulseClarity, stability: frames.length ? same / frames.length : 0, octaveRelated: frames.length ? octave / frames.length : 0, alternates: alt, localBpm: local, localT: frames.map((f) => f.t + 4) };
}

// Ellis (2007) DP beat tracker, librosa flavour
function beatTrack(onset, periodFrames, tightness = 100) {
  const sd = std(Array.from(onset)) || 1;
  const p = periodFrames;
  const half = Math.round(p);
  const kern = []; for (let i = -half; i <= half; i++) kern.push(Math.exp(-0.5 * ((i * 32) / p) ** 2));
  const n = onset.length;
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = -half; k <= half; k++) { const j = i + k; if (j >= 0 && j < n) s += (onset[j] / sd) * kern[k + half]; } local[i] = s; }
  const cum = new Float64Array(n), back = new Int32Array(n);
  const lo = Math.round(2 * p), hi = Math.round(p / 2);
  let lmax = 0; for (const v of local) if (v > lmax) lmax = v;
  let first = true;
  for (let i = 0; i < n; i++) {
    let best = -Infinity, bestJ = -1;
    for (let d = lo; d >= hi; d--) {
      const j = i - d;
      const tx = -tightness * Math.log(d / p) ** 2;
      const v = j >= 0 ? tx + cum[j] : tx;
      if (v > best) { best = v; bestJ = j; }
    }
    cum[i] = local[i] + best;
    if (first && local[i] < 0.01 * lmax) back[i] = -1; else { back[i] = bestJ; first = false; }
  }
  // last beat: last local max of cum above half the median of local maxima
  const maxima = []; for (let i = 1; i < n - 1; i++) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) maxima.push(i);
  const thr = 0.5 * median(maxima.map((i) => cum[i]));
  let tail = maxima.filter((i) => cum[i] >= thr).pop() ?? n - 1;
  const beats = [tail];
  while (back[beats[beats.length - 1]] >= 0) beats.push(back[beats[beats.length - 1]]);
  beats.reverse();
  // trim weak leading / trailing beats
  const sm = beats.map((b, i) => { let s = 0, w = 0; for (let k = -2; k <= 2; k++) { const bb = beats[i + k]; if (bb == null) continue; const hw = 0.5 - 0.5 * Math.cos((2 * Math.PI * (k + 3)) / 6); s += local[bb] * hw; w += hw; } return s / w; });
  const thrT = 0.5 * Math.sqrt(mean(sm.map((v) => v * v)));
  let a = 0, b = beats.length - 1;
  while (a < b && sm[a] <= thrT) a++;
  while (b > a && sm[b] <= thrT) b--;
  return beats.slice(a, b + 1);
}

function peakPick(env, { preMax = 0.05, postMax = 0.05, preAvg = 0.1, postAvg = 0.1, delta = 0.07, wait = 0.05 } = {}) {
  const pmx = Math.round(preMax * FPS), qmx = Math.round(postMax * FPS), pav = Math.round(preAvg * FPS), qav = Math.round(postAvg * FPS), w = Math.round(wait * FPS);
  const peaks = []; let last = -Infinity;
  for (let i = 1; i < env.length - 1; i++) {
    let isMax = true;
    for (let k = i - pmx; k <= i + qmx; k++) if (k >= 0 && k < env.length && env[k] > env[i]) { isMax = false; break; }
    if (!isMax) continue;
    const avg = mean(env, i - pav, i + qav + 1);
    if (env[i] >= avg + delta && i - last > w) { peaks.push(i); last = i; }
  }
  return peaks;
}

function blockSeries(frameVals, nBlocks, fn) {
  const per = BLOCK * FPS; const out = new Float64Array(nBlocks);
  for (let b = 0; b < nBlocks; b++) out[b] = fn(Math.round(b * per), Math.round((b + 1) * per));
  return out;
}

// Foote novelty on a cosine self-similarity matrix of 0.5 s feature vectors
function footeNovelty(vecs, K) {
  const n = vecs.length, d = vecs[0].length;
  const mu = new Float64Array(d), sd = new Float64Array(d);
  for (const v of vecs) for (let j = 0; j < d; j++) mu[j] += v[j] / n;
  for (const v of vecs) for (let j = 0; j < d; j++) sd[j] += (v[j] - mu[j]) ** 2 / n;
  const z = vecs.map((v) => { const o = new Float64Array(d); let nn = 0; for (let j = 0; j < d; j++) { o[j] = (v[j] - mu[j]) / (Math.sqrt(sd[j]) + 1e-9); nn += o[j] * o[j]; } nn = Math.sqrt(nn) + 1e-9; for (let j = 0; j < d; j++) o[j] /= nn; return o; });
  const sim = (a, b) => { let s = 0; for (let j = 0; j < d; j++) s += z[a][j] * z[b][j]; return s; };
  const nov = new Float64Array(n);
  for (let i = K; i < n - K; i++) {
    let s = 0;
    for (let a = -K; a < K; a++) for (let b = -K; b < K; b++) {
      const sign = (a < 0) === (b < 0) ? 1 : -1;
      const g = Math.exp(-0.5 * (((a + 0.5) / (K * 0.5)) ** 2 + ((b + 0.5) / (K * 0.5)) ** 2));
      s += sign * g * sim(i + a, i + b);
    }
    nov[i] = Math.max(0, s);
  }
  return nov;
}

// ---------------------------------------------------------------- per track
async function analyze(file) {
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  const dur = ffprobeDuration(file);
  const loud = ebur128(file);
  const x = await decode(file);
  const F = stftFeatures(x);
  const { onset, onsetLow, centroid, frameRms, nFrames } = F;

  // normalised onset envelope (0..1 at the 99th percentile)
  const o99 = pct(onset, 0.99) || 1;
  const onsetN = Float64Array.from(onset, (v) => Math.min(1.5, v / o99));

  // energy & brightness per 0.5 s block
  const nBlocks = Math.ceil(x.length / (SR * BLOCK));
  const rmsDb = new Float64Array(nBlocks), cent = new Float64Array(nBlocks);
  for (let b = 0; b < nBlocks; b++) {
    const s = Math.round(b * SR * BLOCK), e = Math.min(x.length, Math.round((b + 1) * SR * BLOCK));
    let t = 0; for (let i = s; i < e; i++) t += x[i] * x[i];
    rmsDb[b] = dbOf(Math.sqrt(t / Math.max(1, e - s)));
    const fs0 = Math.floor(s / HOP), fe = Math.min(nFrames, Math.ceil(e / HOP));
    let num = 0, den = 0; for (let f = fs0; f < fe; f++) { num += centroid[f] * frameRms[f]; den += frameRms[f]; }
    cent[b] = den > 0 ? num / den : 0;
  }
  const frameDb = Float64Array.from(frameRms, dbOf);
  const loudRef = pct(rmsDb.filter((v) => v > -80), 0.95);

  // tempo, beats, confidence
  const T = tempoEstimate(onset);
  // The strongest periodicity is often the 8th-note pulse in slow cinematic music. For cut
  // planning we track the beat at the octave-equivalent tempo inside [60, 120) BPM and keep
  // the raw pulse as `pulseBpm`.
  let fold = 1;
  while (T.bpm / fold >= 120) fold *= 2;
  while (T.bpm / fold < 60) fold /= 2;
  const beatBpm = T.bpm / fold;
  const beatFrames = beatTrack(onset, T.lagFrames * fold);
  const beats = beatFrames.map((f) => (f * HOP) / SR);
  const meanOn = mean(onsetN);
  const salAt = (f) => { let m = 0; for (let k = -2; k <= 2; k++) m = Math.max(m, onsetN[f + k] ?? 0); return m; };
  const beatSalience = mean(beatFrames.map(salAt)) / (mean(Array.from({ length: 400 }, (_, i) => salAt(Math.floor(((i + 0.5) / 400) * (nFrames - 4)) + 2))) || meanOn);
  const ibis = beats.slice(1).map((b, i) => b - beats[i]);
  const ibiCv = std(ibis) / mean(ibis);
  const confidence = clamp(0.4 * T.stability + 0.3 * clamp(T.pulseClarity / 0.35, 0, 1) + 0.3 * clamp((beatSalience - 1) / 0.8, 0, 1), 0, 1);
  const label = confidence >= 0.65 ? 'steady pulse' : confidence >= 0.4 ? 'moderate pulse (usable grid, verify by ear)' : 'weak / rubato pulse - beat grid is indicative only';

  // meter guess and estimated downbeats: which beat phase carries the most low-band + full onset energy
  const beatAccent = beatFrames.map((f) => { let m = 0, ml = 0; for (let k = -2; k <= 2; k++) { m = Math.max(m, onsetN[f + k] ?? 0); ml = Math.max(ml, onsetLow[f + k] ?? 0); } return m + ml / (pct(onsetLow, 0.99) || 1); });
  const meterScore = (M) => { let best = { phase: 0, contrast: -Infinity }; for (let ph = 0; ph < M; ph++) { const on = [], off = []; beatAccent.forEach((v, i) => ((i - ph) % M === 0 ? on : off).push(v)); const c = mean(on) / (mean(off) || 1); if (c > best.contrast) best = { phase: ph, contrast: c }; } return best; };
  const m4 = meterScore(4), m3 = meterScore(3);
  const meter = m3.contrast > m4.contrast * 1.08 ? 3 : 4;
  const mm = meter === 3 ? m3 : m4;
  const downbeats = beats.filter((_, i) => i >= mm.phase && (i - mm.phase) % meter === 0);

  // onset peaks / accents
  const peaks = peakPick(onsetN);
  const accentsAll = peaks.map((f) => ({ t: (f * HOP) / SR, s: onsetN[f] })).filter((a) => a.s >= 0.12);
  const topAccents = [...accentsAll].sort((a, b) => b.s - a.s).slice(0, 40).sort((a, b) => a.t - b.t);

  // sections: Foote novelty on [16 mel bands, rms dB, log centroid] per 0.5 s
  const vecs = [];
  for (let b = 0; b < nBlocks; b++) {
    const fs0 = Math.round(b * BLOCK * FPS), fe = Math.min(nFrames, Math.round((b + 1) * BLOCK * FPS));
    const v = new Float64Array(18);
    for (let g = 0; g < 16; g++) { let s = 0, n = 0; for (let f = fs0; f < fe; f++) for (let m = g * 4; m < g * 4 + 4; m++) { s += F.melDb[f * NMEL + m]; n++; } v[g] = n ? s / n : -80; }
    v[16] = rmsDb[b] * 2; v[17] = Math.log2(Math.max(cent[b], 50)) * 6;
    vecs.push(v);
  }
  const K = 12; // 6 s each side -> sustained changes only
  const nov = footeNovelty(vecs, K);
  const novMax = Math.max(...nov) || 1;
  const novN = Array.from(nov, (v) => v / novMax);
  const nMean = mean(novN), nStd = std(novN);
  const sections = [];
  for (let i = 1; i < novN.length - 1; i++) {
    if (novN[i] < nMean + 0.5 * nStd || novN[i] < novN[i - 1] || novN[i] < novN[i + 1]) continue;
    const t = i * BLOCK;
    if (sections.length && t - sections[sections.length - 1].t < 6) { if (novN[i] > sections[sections.length - 1].novelty) sections.pop(); else continue; }
    const before = mean(rmsDb, i - 8, i), after = mean(rmsDb, i, i + 8);
    const cb = mean(cent, i - 8, i), ca = mean(cent, i, i + 8);
    // snap to strongest onset within +-0.75 s
    let snap = t, best = 0; for (const a of accentsAll) if (Math.abs(a.t - t) <= 0.75 && a.s > best) { best = a.s; snap = a.t; }
    sections.push({ t: snap, tBlock: t, novelty: novN[i], dBBefore: before, dBAfter: after, dBChange: after - before, centroidBefore: cb, centroidAfter: ca });
  }

  // ---------------------------------------------------------------- 40 s window search
  const W = opts.win;
  const dbAt = (t0, t1) => { const a = Math.max(0, Math.floor(t0 * FPS)), b = Math.min(nFrames, Math.ceil(t1 * FPS)); let s = 0, n = 0; for (let i = a; i < b; i++) { s += frameRms[i] ** 2; n++; } return n ? dbOf(Math.sqrt(s / n)) : -120; };
  const centAt = (t0, t1) => { const a = Math.max(0, Math.floor(t0 * FPS)), b = Math.min(nFrames, Math.ceil(t1 * FPS)); let num = 0, den = 0; for (let i = a; i < b; i++) { num += centroid[i] * frameRms[i]; den += frameRms[i]; } return den ? num / den : 0; };
  // lift curve at 0.1 s: louder & brighter in the next 3 s than in the previous 6 s (the long
  // look-back keeps ordinary piano re-attacks after a decaying phrase from counting as lifts)
  const liftStep = 0.1;
  const liftT = [], liftV = [], liftDb = [], liftBr = [];
  for (let t = 3; t < dur - 2.5; t += liftStep) {
    const ddb = dbAt(t, t + 3) - dbAt(t - 6, t);
    const dbr = Math.log2((centAt(t, t + 3) + 1) / (centAt(t - 6, t) + 1));
    liftT.push(t); liftDb.push(ddb); liftBr.push(dbr); liftV.push(ddb + 2 * dbr);
  }
  const liftIdx = (t) => Math.round((t - 3) / liftStep);
  const maxLift = (t0, t1) => { let bv = -Infinity, bt = null, bi = -1; for (let i = Math.max(0, liftIdx(t0)); i <= Math.min(liftV.length - 1, liftIdx(t1)); i++) if (liftV[i] > bv) { bv = liftV[i]; bt = liftT[i]; bi = i; } return { v: bv, t: bt, ddb: liftDb[bi], dbr: liftBr[bi] }; };
  const snapOnset = (t, rad = 0.4) => { let best = null; for (const a of accentsAll) if (Math.abs(a.t - t) <= rad && (!best || a.s > best.s)) best = a; return best; };
  const firstSound = (() => { for (let f = 0; f < nFrames; f++) if (frameDb[f] > loudRef - 30) return f / FPS; return 0; })();

  const cand = new Set([r2(firstSound)]);
  for (const a of accentsAll) if (a.s >= 0.15) cand.add(r2(a.t));
  for (const b of downbeats) cand.add(r2(b));
  for (const s of sections) cand.add(r2(s.t));
  const evalWindow = (s) => {
    const e = s + W;
    if (e > dur + 0.01) return null;
    const startDb = dbAt(s, s + 1), preDb = dbAt(s - 2, s);
    const lift = maxLift(s + 22, s + 28);
    const liftOther = Math.max(maxLift(s + 3, s + 21.5).v, maxLift(s + 28.5, s + 37).v);
    const early = dbAt(s, s + 12), late = dbAt(s + 22, s + 35);
    const peakZone = dbAt(s + 24, s + 34), endDb = dbAt(e - 2.5, e);
    const on = snapOnset(s, 0.06);
    const nearSection = sections.some((x) => Math.abs(x.t - s) < 0.75);
    const isDown = downbeats.some((b) => Math.abs(b - s) < 0.06);
    const endBoundary = sections.find((x) => x.t > e - 1.5 && x.t < e + 2.5);
    const startOk = startDb > loudRef - 18;
    // phrase start: the second before s is clearly quieter than the 1.5 s after it (a breath / new phrase)
    const breathBefore = dbAt(s, s + 1.5) - dbAt(s - 1, s);
    // phrase end: the music itself dips (breath, final-chord decay or track end) right at / after the window end
    let minEnd = Infinity; for (let t = e - 1; t <= Math.min(dur, e + 1.5); t += 0.25) minEnd = Math.min(minEnd, dbAt(t, t + 0.5));
    if (e > dur - 1.5) minEnd = Math.min(minEnd, -90);
    const breathAtEnd = peakZone - minEnd;
    const sc = {
      lift: clamp(lift.v, -2, 8),
      liftDominance: clamp(lift.v - liftOther, -4, 4),
      start: (startOk ? 1.5 : -4) + (on ? 1.5 * Math.min(1, on.s) : 0) + (nearSection || s <= firstSound + 0.05 ? 1.0 : 0) + (isDown ? 0.5 : 0) + clamp(breathBefore / 8, -0.5, 1.5),
      rise: clamp((late - early) / 2, -3, 3),
      end: clamp((peakZone - endDb) / 2, -2, 3) + clamp(breathAtEnd / 8, 0, 1.5) + (endBoundary ? 0.5 : 0),
    };
    const total = sc.lift + sc.liftDominance + sc.start + sc.rise + sc.end;
    return { start: s, total, sc, lift, liftOther, startDb, preDb, early, late, peakZone, endDb, breathBefore, breathAtEnd, minEnd, onsetAtStart: on?.s ?? 0, nearSection, isDown, endBoundary: endBoundary?.t ?? null };
  };
  const ranked = [...cand].map(Number).filter((s) => s >= 0).map(evalWindow).filter(Boolean).sort((a, b) => b.total - a.total);
  // keep distinct alternatives (>= 4 s apart)
  const alts = []; for (const w of ranked) { if (alts.every((a) => Math.abs(a.start - w.start) >= 4)) alts.push(w); if (alts.length >= 5) break; }
  const forced = opts.starts[base];
  const chosen = forced != null ? evalWindow(forced) : alts[0];

  let window = null;
  if (chosen) {
    const s = chosen.start, e = s + W;
    // exact lift time (entry): steepest rise of the (3-frame smoothed) frame energy within -2.0..+0.5 s
    // of the lift-curve maximum, snapped to an onset peak within 0.15 s; swell peak = loudest 0.5 s
    // block in the 5 s after the entry
    const sm = (i) => (frameDb[i - 1] + frameDb[i] + frameDb[i + 1]) / 3;
    let bestI = Math.round(chosen.lift.t * FPS), bestD = -Infinity;
    for (let i = Math.round((chosen.lift.t - 2.0) * FPS); i <= Math.round((chosen.lift.t + 0.5) * FPS); i++) {
      if (i < 4 || i > nFrames - 5) continue;
      const d = sm(i + 2) - sm(i - 2);
      if (d > bestD) { bestD = d; bestI = i; }
    }
    const stepT = bestI / FPS;
    let liftOn = null; for (const a of accentsAll) if (Math.abs(a.t - stepT) <= 0.15 && a.s >= 0.3 && (!liftOn || Math.abs(a.t - stepT) < Math.abs(liftOn.t - stepT))) liftOn = a;
    const liftTime = liftOn ? liftOn.t : stepT;
    let peakB = Math.floor(liftTime / BLOCK);
    for (let b = Math.floor(liftTime / BLOCK); b < Math.min(nBlocks, Math.floor((liftTime + 5) / BLOCK)); b++) if (rmsDb[b] > rmsDb[peakB]) peakB = b;
    const swellPeak = peakB * BLOCK + BLOCK / 2;
    const winLoud = ebur128(file, s, W);
    const inWin = (t) => t >= s - 0.01 && t <= e + 0.01; // 10 ms tolerance: s itself is usually an onset/beat
    // tempo confidence inside the window
    const lw = T.localT.map((t, i) => [t, T.localBpm[i]]).filter(([t]) => t >= s && t <= e);
    const foldTo = (b) => { while (b >= 120) b /= 2; while (b < 60) b *= 2; return b; };
    const winStab = lw.length ? lw.filter(([, b]) => Math.abs(foldTo(b) / beatBpm - 1) < 0.04).length / lw.length : null;
    const issues = [];
    if (chosen.startDb < loudRef - 18) issues.push('window starts quiet - short fade-in or pre-roll needed');
    if (chosen.onsetAtStart < 0.15) issues.push('no strong onset exactly at the start - start may sit mid-phrase; consider a 0.3-0.5 s fade-in');
    if (liftTime - s < 22 || liftTime - s > 28) issues.push('lift entry at ' + r2(liftTime - s) + ' s is outside the 22-28 s zone');
    if (chosen.lift.v < 1.5) issues.push('no clear step-lift between 22 and 28 s (max lift ' + r1(chosen.lift.v) + ')');
    if (chosen.lift.v < chosen.liftOther) issues.push('a stronger lift exists elsewhere in the window (' + r1(chosen.liftOther) + ' vs ' + r1(chosen.lift.v) + ')');
    if (chosen.late - chosen.early < 0) issues.push('energy does not rise over the window');
    if (chosen.peakZone - chosen.endDb < 1) issues.push('window end is not quieter than the climax - fade-out will cut through sustained sound');
    if (chosen.breathAtEnd < 6) issues.push('the music does not breathe / decay at the window end (dip only ' + r1(chosen.breathAtEnd) + ' dB below the climax within -1..+1.5 s)');
    window = {
      startSec: r3(s), endSec: r3(e), lengthSec: W,
      chosenBy: forced != null ? 'manual override after visual review (see notes)' : 'automatic score',
      liftTimeInWindowSec: r3(liftTime - s), liftTimeInTrackSec: r3(liftTime),
      liftSwellPeakInWindowSec: r2(swellPeak - s), liftSwellPeakDb: r1(rmsDb[peakB]),
      liftStrength: { score: r2(chosen.lift.v), dBStep: r2(chosen.lift.ddb), brightnessOctaves: r2(chosen.lift.dbr), strongestOtherLiftInWindow: r2(chosen.liftOther) },
      energyDb: { first12s: r1(chosen.early), from22to35s: r1(chosen.late), from24to34s: r1(chosen.peakZone), last2_5s: r1(chosen.endDb), startFirstSecond: r1(chosen.startDb), twoSecBeforeStart: r1(chosen.preDb), breathBeforeStart: r1(chosen.breathBefore), dipAtEndBelowClimax: r1(chosen.breathAtEnd), quietestHalfSecondNearEnd: r1(chosen.minEnd) },
      startsOnOnset: chosen.onsetAtStart >= 0.15, startOnsetStrength: r2(chosen.onsetAtStart), startNearSectionBoundary: chosen.nearSection, startOnEstimatedDownbeat: chosen.isDown,
      endNearSectionBoundarySec: chosen.endBoundary != null ? r3(chosen.endBoundary - s) : null,
      loudness: winLoud,
      tempoStabilityInWindow: winStab != null ? r2(winStab) : null,
      beatsRel: beats.filter(inWin).map((t) => r3(t - s)),
      downbeatsRelEstimated: downbeats.filter(inWin).map((t) => r3(t - s)),
      accentsRel: accentsAll.filter((a) => inWin(a.t)).sort((a, b) => b.s - a.s).slice(0, 25).sort((a, b) => a.t - b.t).map((a) => ({ t: r3(a.t - s), s: r2(a.s) })),
      sectionChangesRel: sections.filter((x) => inWin(x.t)).map((x) => ({ t: r3(x.t - s), dBChange: r1(x.dBChange), novelty: r2(x.novelty) })),
      energyRmsDb05Rel: Array.from(rmsDb.slice(Math.floor(s / BLOCK), Math.floor(e / BLOCK))).map(r1),
      score: { total: r2(chosen.total), ...Object.fromEntries(Object.entries(chosen.sc).map(([k, v]) => [k, r2(v)])) },
      issues,
    };
  }

  const out = {
    file: file.replace(/\\/g, '/'), base, ...(meta[base] || {}),
    durationSec: r3(dur), firstSoundSec: r3(firstSound),
    loudness: loud,
    tempo: {
      bpm: r1(beatBpm), pulseBpm: r1(T.bpm), beatIsPulseDividedBy: fold, pulseAlternates: T.alternates, confidence: r2(confidence), label,      pulseClarity: r3(T.pulseClarity), localTempoStability: r2(T.stability), octaveRelatedWindows: r2(T.octaveRelated), beatSalience: r2(beatSalience), interBeatCv: r3(ibiCv),
      meterGuess: meter, meterContrast: { '3': r2(m3.contrast), '4': r2(m4.contrast) },
      localBpmEvery1s: T.localBpm.map(r1),
    },
    beats: beats.map(r3),
    downbeatsEstimated: downbeats.map(r3),
    energyRmsDb05: Array.from(rmsDb).map(r1),
    brightnessCentroidHz05: Array.from(cent).map((v) => Math.round(v)),
    accentsTop40: topAccents.map((a) => ({ t: r3(a.t), s: r2(a.s) })),
    onsetsAll: accentsAll.filter((a) => a.s >= 0.2).map((a) => [r3(a.t), r2(a.s)]),
    sections: sections.map((x) => ({ t: r3(x.t), novelty: r2(x.novelty), dBBefore: r1(x.dBBefore), dBAfter: r1(x.dBAfter), dBChange: r1(x.dBChange), centroidBeforeHz: Math.round(x.centroidBefore), centroidAfterHz: Math.round(x.centroidAfter), kind: x.dBChange > 2 ? 'rise' : x.dBChange < -2 ? 'drop' : 'texture change' })),
    window,
    alternativeWindows: alts.map((w) => ({ startSec: r3(w.start), total: r2(w.total), liftInWindowSec: r2(w.lift.t - w.start), lift: r2(w.lift.v), riseDb: r1(w.late - w.early), endDropDb: r1(w.peakZone - w.endDb), breathBeforeStartDb: r1(w.breathBefore), dipAtEndDb: r1(w.breathAtEnd) })),
  };
  if (opts.img) out.images = await renderImages(file, base, out, { rmsDb, cent, novN, liftT, liftV, accentsAll });
  return out;
}

// ---------------------------------------------------------------- images
async function renderImages(file, base, a, series) {
  fs.mkdirSync(opts.img, { recursive: true });
  const rel = (p) => path.relative(process.cwd(), p).replace(/\\/g, '/');
  const wav = path.join(opts.img, `${base}_waveform.png`);
  const spec = path.join(opts.img, `${base}_spectrogram.png`);
  spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=1800x300:colors=0x2f6db5:scale=sqrt', '-frames:v', '1', wav]);
  spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-lavfi', 'showspectrumpic=s=1600x540:legend=1:mode=combined:scale=log:fscale=log:color=intensity:gain=1.5', '-frames:v', '1', spec]);
  const res = { waveform: rel(wav), spectrogram: rel(spec) };
  if (a.window) {
    const ww = path.join(opts.img, `${base}_window_waveform.png`);
    spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(a.window.startSec), '-t', String(a.window.lengthSec), '-i', file, '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=1600x240:colors=0x2f6db5:scale=sqrt', '-frames:v', '1', ww]);
    res.windowWaveform = rel(ww);
  }
  // annotated charts (SVG -> PNG via sharp from the project's node_modules, when available)
  try {
    const { default: sharp } = await import('sharp');
    const ov = path.join(opts.img, `${base}_overview.png`);
    await sharp(Buffer.from(chartSvg(a, series, 0, a.durationSec, 0, 10))).png().toFile(ov);
    res.overview = rel(ov);
    if (a.window) {
      const wz = path.join(opts.img, `${base}_window_chart.png`);
      await sharp(Buffer.from(chartSvg(a, series, a.window.startSec - 2, a.window.endSec + 2, a.window.startSec, 1, series.accentsAll))).png().toFile(wz);
      res.windowChart = rel(wz);
    }
  } catch (e) { res.chartError = String(e.message || e); }
  return res;
}

// t0..t1 = visible range (track seconds); origin = time shown as 0 on the axis; grid = label step (s)
function chartSvg(a, series, t0, t1, origin, grid, accents = null) {
  const Wd = 1800, H = 540, L = 50, R = 20;
  const X = (t) => L + ((t - t0) / (t1 - t0)) * (Wd - L - R);
  const vis = (t) => t >= t0 && t <= t1;
  const dbY = (d) => 40 + (1 - clamp((d + 60) / 60, 0, 1)) * 200; // -60..0 dBFS -> 240..40
  const cY = (c) => 260 + (1 - clamp(Math.log2(Math.max(c, 100) / 100) / 5, 0, 1)) * 120; // 100 Hz..3.2 kHz
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Wd}" height="${H}"><rect width="100%" height="100%" fill="#ffffff"/>`;
  const w = a.window;
  if (w) {
    svg += `<rect x="${X(Math.max(t0, w.startSec))}" y="30" width="${X(Math.min(t1, w.endSec)) - X(Math.max(t0, w.startSec))}" height="${H - 70}" fill="#ffe9b0" opacity="0.6"/>`;
    svg += `<rect x="${X(w.startSec + 22)}" y="30" width="${X(w.startSec + 28) - X(w.startSec + 22)}" height="${H - 70}" fill="#ffc870" opacity="0.5"/>`;
    svg += `<rect x="${X(w.endSec - 3)}" y="30" width="${X(w.endSec) - X(w.endSec - 3)}" height="${H - 70}" fill="#b0d8ff" opacity="0.45"/>`;
    if (vis(w.liftTimeInTrackSec)) svg += `<line x1="${X(w.liftTimeInTrackSec)}" x2="${X(w.liftTimeInTrackSec)}" y1="30" y2="${H - 40}" stroke="#d40000" stroke-width="2"/>`;
  }
  const first = Math.ceil((t0 - origin) / grid) * grid;
  for (let k = first; origin + k <= t1; k += grid) {
    const t = origin + k, major = Math.abs(k % (grid * 5)) < 1e-6;
    svg += `<line x1="${X(t)}" x2="${X(t)}" y1="30" y2="${H - 40}" stroke="${major ? '#ccc' : '#eee'}"/>`;
    if (major || grid >= 5) svg += `<text x="${X(t) + 2}" y="${H - 22}" font-size="12" font-family="sans-serif" fill="#555">${Math.round(k * 10) / 10}s</text>`;
  }
  for (const d of [-60, -40, -20, 0]) svg += `<text x="4" y="${dbY(d) + 4}" font-size="11" font-family="sans-serif" fill="#2f6db5">${d}dB</text>`;
  const pts = (arr, fy, off) => Array.from(arr).map((v, i) => [i * BLOCK + off, v]).filter(([t]) => t >= t0 - 1 && t <= t1 + 1).map(([t, v]) => `${X(t).toFixed(1)},${fy(v).toFixed(1)}`).join(' ');
  svg += `<polyline fill="none" stroke="#2f6db5" stroke-width="2" points="${pts(series.rmsDb, dbY, BLOCK / 2)}"/>`;
  svg += `<polyline fill="none" stroke="#e08a00" stroke-width="1.5" points="${pts(series.cent, cY, BLOCK / 2)}"/>`;
  svg += `<polyline fill="none" stroke="#7a3bb5" stroke-width="1" points="${pts(series.novN, (v) => 480 - v * 60, 0)}"/>`;
  for (const s of a.sections) if (vis(s.t)) svg += `<line x1="${X(s.t)}" x2="${X(s.t)}" y1="30" y2="410" stroke="#7a3bb5" stroke-dasharray="4 3"/>`;
  for (const b of a.beats) if (vis(b)) svg += `<line x1="${X(b)}" x2="${X(b)}" y1="${H - 46}" y2="${H - 38}" stroke="#888"/>`;
  for (const b of a.downbeatsEstimated) if (vis(b)) svg += `<line x1="${X(b)}" x2="${X(b)}" y1="${H - 54}" y2="${H - 38}" stroke="#222" stroke-width="2"/>`;
  for (const c of accents || a.accentsTop40) if (vis(c.t)) svg += `<line x1="${X(c.t)}" x2="${X(c.t)}" y1="410" y2="${410 - Math.min(1.2, c.s) * 30}" stroke="#c00" stroke-width="2"/>`;
  svg += `<text x="${L}" y="20" font-size="14" font-family="sans-serif" fill="#222">${esc(a.title || a.base)} - blue: RMS dB per 0.5 s, orange: spectral centroid, purple: novelty (dashed = section change), red: accents, ticks: beats ${a.tempo.bpm} BPM (conf ${a.tempo.confidence}; thick = est. downbeat); yellow: 40 s window, orange: 22-28 s zone, red line: lift, blue: last 3 s (fade)</text></svg>`;
  return svg;
}

// ---------------------------------------------------------------- main
const results = [];
for (const f of opts.files) {
  const t0 = Date.now();
  const r = await analyze(f);
  results.push(r);
  const w = r.window;
  console.log(`${r.base}: ${r.durationSec}s  I=${r.loudness.integratedLUFS} LUFS  TP=${r.loudness.truePeakDBTP} dBTP  BPM=${r.tempo.bpm} (conf ${r.tempo.confidence}, ${r.tempo.label}; stab ${r.tempo.localTempoStability}, clarity ${r.tempo.pulseClarity}, sal ${r.tempo.beatSalience}) meter~${r.tempo.meterGuess}`);
  console.log(`   sections: ${r.sections.map((s) => `${s.t.toFixed(1)}(${s.dBChange > 0 ? '+' : ''}${s.dBChange})`).join(' ')}`);
  if (w) console.log(`   window ${w.startSec}-${w.endSec}  lift@${w.liftTimeInWindowSec} (score ${w.liftStrength.score}, other ${w.liftStrength.strongestOtherLiftInWindow})  E ${w.energyDb.first12s}->${w.energyDb.from22to35s} end ${w.energyDb.last2_5s}  total ${w.score.total}  ${w.issues.join('; ')}`);
  console.log(`   alts: ${r.alternativeWindows.map((a) => `${a.startSec}[${a.total}|lift@${a.liftInWindowSec}=${a.lift}|rise ${a.riseDb}|endDrop ${a.endDropDb}|breath ${a.breathBeforeStartDb}/${a.dipAtEndDb}]`).join('  ')}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
if (opts.out) {
  const doc = {
    generatedAt: new Date().toISOString(),
    tool: 'tools/audio-analyze.mjs',
    method: {
      decode: `ffmpeg -> mono ${SR} Hz f32le pipe`,
      stft: `${NFFT}-point Hann, hop ${HOP} (${r2((HOP / SR) * 1000)} ms)`,
      onsetEnvelope: `${NMEL}-band mel log-power spectral flux (positive differences, mean over bands)`,
      tempo: '8 s windowed autocorrelation of onset envelope (tempogram, 1 s hop) x log-normal prior (110 BPM, 1 octave); confidence = 0.4*local-tempo stability + 0.3*pulse clarity + 0.3*beat salience',
      beats: 'Ellis 2007 dynamic-programming tracker (tightness 100) over the full track; downbeats = beat phase with the strongest full+low-band onset accent for a 3 or 4 beat bar (estimate)',
      energy: 'RMS dBFS of the mono 22.05 kHz signal per 0.5 s block (index i covers i*0.5 .. i*0.5+0.5 s)',
      brightness: 'RMS-weighted spectral centroid per 0.5 s block',
      accents: 'onset-envelope peaks (normalised to the 99th percentile = 1.0)',
      sections: 'Foote checkerboard novelty (6 s half-kernel) on a cosine self-similarity matrix of 0.5 s vectors [16 mel bands, RMS dB, log centroid]; times snapped to the strongest onset within 0.75 s',
      lift: 'lift(t) = dB(t..t+3) - dB(t-6..t) + 2*log2(centroid ratio of the same spans); the reported lift time is the steepest rise of the smoothed frame energy within -1.0..+0.5 s of the lift maximum, snapped to an onset peak within 0.15 s',
      windowScore: 'lift strength in 22-28 s + its dominance over other lifts in the window + start quality (sound present, onset at start, section boundary / estimated downbeat) + energy rise (22-35 s vs 0-12 s) + end drop (24-34 s vs last 2.5 s, section boundary or track end near the window end)',
    },
    windowLengthSec: opts.win,
    tracks: results,
  };
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify(doc, null, 1));
  console.log('wrote', opts.out);
}
