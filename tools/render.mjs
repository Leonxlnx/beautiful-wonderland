// Offline frame renderer for the film (resumable, one GPU job at a time).
//   node tools/render.mjs --name v1 [--size 3840x2160] [--tiles 4x4] [--fps 30] [--from 0] [--to 40]
//                         [--frames a-b] [--every 1] [--force] [--parts a,b] [--q film] [--rest 120]
//                         [--timeout 300] [--restart 300]
// --from/--to are film seconds (to is exclusive: 0..40 = frames 0..1199); --frames a-b is an inclusive index
// range and wins over --from/--to. --every N keeps only indices divisible by N (drafts).
// Output: out/frames/<name>/f%05d.png  (+ render.log, status.json, meta.json)
// Existing complete frames of the right size are skipped (resume) unless --force.
// Stop cleanly after the current frame: create the file out/frames/<name>/STOP.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { ROOT, acquireGpu, startSession, parseArgs } from './lib.mjs';

sharp.cache(false);
sharp.concurrency(4);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (msg, code = 2) => { console.error('render: ' + msg); process.exit(code); };
const pad5 = (i) => String(i).padStart(5, '0');
const fmtDur = (s) => {
  if (!Number.isFinite(s)) return '?';
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(x).padStart(2, '0')}s` : `${x}s`;
};

// ---------- arguments ----------
const a = parseArgs(process.argv);
if (!a.name || a.name === true) die('--name <name> is required');
const NAME = String(a.name);
if (!/^[\w.-]+$/.test(NAME)) die(`--name "${NAME}" may only contain letters, digits, _ . -`);
const pairArg = (v, def, what) => {
  const m = /^(\d+)x(\d+)$/i.exec(String(v ?? def));
  if (!m || +m[1] < 1 || +m[2] < 1) die(`bad --${what} "${v}" (expected e.g. ${def})`);
  return [+m[1], +m[2]];
};
const [W, H] = pairArg(a.size, '3840x2160', 'size');
const [TX, TY] = pairArg(a.tiles, '4x4', 'tiles');
const num = (v, def, what, min = -Infinity) => {
  const n = v === undefined || v === true ? def : Number(v);
  if (!Number.isFinite(n) || n < min) die(`bad --${what} "${v}"`);
  return n;
};
const FPS = num(a.fps, 30, 'fps', 1);
const EVERY = Math.floor(num(a.every, 1, 'every', 1));
const REST = num(a.rest, 120, 'rest', 0);
const TIMEOUT = num(a.timeout, 300, 'timeout', 10) * 1000;
const RESTART_EVERY = Math.floor(num(a.restart, 300, 'restart', 1));
const FORCE = !!a.force;
const Q = a.q && a.q !== true ? String(a.q) : 'film';
const PARTS = a.parts && a.parts !== true ? String(a.parts) : null;
const MAX_TRIES = 3, MAX_CONSECUTIVE_FAILS = 5;
if (W % 2 || H % 2) console.warn(`render: warning: ${W}x${H} has an odd dimension; H.264 4:2:0 needs even sizes`);

let first, last;
if (a.frames !== undefined) {
  const m = /^(\d+)(?:-(\d+))?$/.exec(String(a.frames));
  if (!m) die(`bad --frames "${a.frames}" (expected a-b, e.g. 0-299)`);
  first = +m[1]; last = m[2] !== undefined ? +m[2] : first;
} else {
  const from = num(a.from, 0, 'from', 0), to = num(a.to, 40, 'to', 0);
  first = Math.round(from * FPS); last = Math.round(to * FPS) - 1;
}
if (last < first) die(`empty frame range ${first}-${last}`);
const FRAMES = [];
for (let i = first; i <= last; i++) if (i % EVERY === 0) FRAMES.push(i);
if (!FRAMES.length) die(`no frame index in ${first}-${last} is a multiple of --every ${EVERY}`);

// ---------- paths, logging, status ----------
const DIR = path.join(ROOT, 'out', 'frames', NAME);
fs.mkdirSync(DIR, { recursive: true });
const framePath = (i) => path.join(DIR, `f${pad5(i)}.png`);
const tmpPath = (i) => path.join(DIR, `f${pad5(i)}.tmp.png`);
const LOG = path.join(DIR, 'render.log');
const STATUS = path.join(DIR, 'status.json');
const STOPFILE = path.join(DIR, 'STOP');
const log = (line) => { try { fs.appendFileSync(LOG, line + '\n'); } catch {} };

// 'ok' | 'missing' | 'bad' (truncated / not a PNG) | 'size' (other resolution)
function frameState(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < 64) return 'bad';
    const h = Buffer.alloc(24); fs.readSync(fd, h, 0, 24, 0);
    if (h.readUInt32BE(0) !== 0x89504e47 || h.toString('ascii', 12, 16) !== 'IHDR') return 'bad';
    const e = Buffer.alloc(8); fs.readSync(fd, e, 0, 8, size - 8);
    if (e.toString('ascii', 0, 4) !== 'IEND') return 'bad';
    return h.readUInt32BE(16) === W && h.readUInt32BE(20) === H ? 'ok' : 'size';
  } catch (e) { return e.code === 'ENOENT' ? 'missing' : 'bad'; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

const run = {
  t0: Date.now(), rendered: 0, failed: [], lastFrame: null, lastT: null, session: 0,
  renderMs: [], wallMs: [], state: 'starting', done: 0, remaining: 0,
};
const avg = (arr) => (arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : NaN);
const etaSec = () => (run.wallMs.length ? (avg(run.wallMs) / 1000) * run.remaining : null);
function writeStatus(state = run.state) {
  run.state = state;
  const st = {
    name: NAME, state, done: run.done, total: FRAMES.length, rendered: run.rendered, remaining: run.remaining,
    failed: run.failed, lastFrame: run.lastFrame, lastT: run.lastT,
    avgRenderMs: Math.round(avg(run.renderMs)) || null, avgFrameSec: +(avg(run.wallMs) / 1000).toFixed(2) || null,
    etaSec: etaSec() === null ? null : Math.round(etaSec()), elapsedSec: Math.round((Date.now() - run.t0) / 1000),
    size: `${W}x${H}`, tiles: `${TX}x${TY}`, fps: FPS, every: EVERY, range: [first, last], q: Q, parts: PARTS,
    session: run.session, pid: process.pid, updatedAt: new Date().toISOString(),
  };
  const tmp = STATUS + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(st, null, 2)); fs.renameSync(tmp, STATUS); }
  catch { try { fs.writeFileSync(STATUS, JSON.stringify(st, null, 2)); } catch {} }
}

// ---------- signals: clean up, the lock is released by lib's exit hook ----------
let curTmp = null;
function onSignal(sig) {
  if (curTmp) try { fs.unlinkSync(curTmp); } catch {}
  log(`# interrupted by ${sig} after ${run.rendered} frame(s)`);
  writeStatus('stopped');
  console.log(`\nrender: ${sig} - stopped after ${run.rendered} frame(s); run the same command again to resume`);
  process.exit(130);
}
// Registered before acquireGpu() so this runs first; the 'exit' hooks (lock release, Chrome kill) still fire.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => onSignal(sig));

// ---------- headless-Chrome housekeeping (Windows) ----------
const PROFILE = path.join(ROOT, 'out', '.chrome-profile');
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function killTree(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch {}
}
// Kills Chrome trees that use this project's profile and whose parent is gone (a hard-killed render/shot
// leaves them behind and a new launch on the same profile would fail). With own=true also our own children.
// Only called while we hold the GPU lock, so no legitimate job is using the profile.
function reapChromes({ own = false } = {}) {
  if (process.platform !== 'win32') return 0;
  let list = [];
  try {
    const ps = `$p='${PROFILE.replace(/'/g, "''")}'; Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) } | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    list = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\s+/).map(Number)).map(([pid, ppid]) => ({ pid, ppid }));
  } catch (e) { console.warn('render: chrome check failed:', e.message.split('\n')[0]); return 0; }
  const pids = new Set(list.map((p) => p.pid));
  let n = 0;
  for (const r of list.filter((p) => !pids.has(p.ppid))) {
    const mine = r.ppid === process.pid;
    if (mine ? !own : alive(r.ppid)) continue;
    killTree(r.pid); n++;
    log(`# killed ${mine ? 'own' : 'orphaned'} Chrome tree pid ${r.pid}`);
  }
  if (n) console.log(`render: killed ${n} leftover Chrome process tree(s)`);
  return n;
}

// ---------- session ----------
let s = null;
let pending = null; // { idx, buf } posted by the page
async function openSession() {
  run.session++;
  const t0 = Date.now();
  log(`# session ${run.session} starting`);
  const startP = startSession({ quality: Q, parts: PARTS, log: true });
  let sess;
  try { sess = await guarded(startP, 300000, 'session start'); }
  catch (e) { startP.then((x) => x.close(), () => {}); throw e; }
  sess.lost = 0; sess.dead = null;
  try {
    // puppeteer enables the CDP Network domain; Chrome then copies every POST body (33 MB per 4K frame) into
    // DevTools events, which made each frame transfer take ~30 s instead of ~0.4 s. Not needed after load.
    try { await sess.page._client().send('Network.disable'); }
    catch (e) { console.warn('render: could not disable the CDP Network domain - pixel transfer will be slow:', e.message); }
    sess.page.on('console', (m) => { if (/context lost/i.test(m.text())) sess.lost++; });
    sess.page.on('error', (e) => { sess.dead = sess.dead || 'page crashed: ' + String(e).slice(0, 200); });
    sess.page.browser().on('disconnected', () => { sess.dead = sess.dead || 'browser disconnected'; });
    await guarded(sess.page.evaluate(() => {
      window.__wlLost = 0;
      document.getElementById('view')?.addEventListener('webglcontextlost', () => { window.__wlLost++; });
    }), 30000, 'session setup', sess);
  } catch (e) { await Promise.race([sess.close().catch(() => {}), sleep(20000)]); throw e; }
  sess.setSink(async (buf, params) => { pending = { idx: Number(params.get('f')), buf }; });
  const msg = `session ${run.session}: ${sess.gpu} (q=${Q}${PARTS ? ', parts=' + PARTS : ''}) ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`;
  console.log(msg); log('# ' + msg);
  sess.framesDone = 0;
  return sess;
}
async function closeSession({ failed = false } = {}) {
  if (!s) { if (failed) reapChromes({ own: true }); return; } // a failed start may have left a browser behind
  const sess = s; s = null;
  let pid = null;
  try { pid = sess.page.browser().process()?.pid ?? null; } catch {}
  const p = sess.close().catch(() => {});
  const ok = await Promise.race([p.then(() => true), sleep(20000).then(() => false)]);
  if (!ok) { if (pid) killTree(pid); await Promise.race([p, sleep(10000)]); }
  if (failed || !ok) reapChromes({ own: true });
}

// Races a promise against the timeout and against the session dying. The loser's rejection is swallowed.
function guarded(promise, ms, what, sess) {
  promise.catch(() => {});
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (sess?.dead) { clearInterval(iv); reject(new Error(`${what}: ${sess.dead}`)); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)); }
    }, 500);
    promise.then((v) => { clearInterval(iv); resolve(v); }, (e) => { clearInterval(iv); reject(e); });
  });
}

async function captureFrame(idx) {
  pending = null;
  const t = idx / FPS, t0 = Date.now();
  const r = await guarded(
    s.capture({ t, width: W, height: H, tilesX: TX, tilesY: TY, view: null, url: `${s.sinkUrl}?f=${idx}`, frame: idx }),
    TIMEOUT, `capture f${pad5(idx)}`, s);
  const ctx = await guarded(s.page.evaluate(() => {
    const c = document.getElementById('view');
    const gl = c && c.getContext('webgl2');
    return { events: window.__wlLost | 0, lost: !!(gl && gl.isContextLost()) };
  }), 15000, 'context check', s);
  if (ctx.events || ctx.lost || s.lost) throw new Error('WebGL context lost');
  if (!pending || pending.idx !== idx) throw new Error('no pixel data received for this frame');
  const buf = pending.buf; pending = null;
  if (buf.length !== W * H * 4) throw new Error(`pixel data has ${buf.length} bytes, expected ${W * H * 4}`);
  // The composite pass writes alpha = 1 everywhere; all-zero alpha means a failed readback.
  let ok = false;
  for (let o = 3; o < buf.length; o += 4 * 4099) if (buf[o]) { ok = true; break; }
  if (!ok) throw new Error('empty frame (alpha 0) - GPU readback failed');
  return { r, buf, capMs: Date.now() - t0 };
}

async function writeFrame(idx, buf) {
  const tmp = tmpPath(idx), fin = framePath(idx), t0 = Date.now();
  curTmp = tmp;
  await sharp(buf, { raw: { width: W, height: H, channels: 4 } }).removeAlpha().png({ compressionLevel: 2 }).toFile(tmp);
  writeFrame.lastMs = Date.now() - t0;
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, fin); break; }
    catch (e) { if (i >= 20) throw e; await sleep(250); } // Windows: target briefly open elsewhere
  }
  curTmp = null;
}

// ---------- plan ----------
function scan() {
  const counts = { ok: 0, missing: 0, bad: 0, size: 0 };
  const todo = [];
  for (const i of FRAMES) {
    const st = frameState(framePath(i));
    counts[st]++;
    if (FORCE || st !== 'ok') todo.push(i);
  }
  return { todo, counts };
}
let { todo, counts } = scan();
run.done = FRAMES.length - todo.length; run.remaining = todo.length;
if (last / FPS >= 40) console.warn(`render: warning: range goes past the 40 s film (last frame t=${(last / FPS).toFixed(2)} s)`);
console.log(`render ${NAME}: ${W}x${H} tiles ${TX}x${TY} q=${Q} fps ${FPS}  frames ${first}-${last}${EVERY > 1 ? ' every ' + EVERY : ''} = ${FRAMES.length}`);
console.log(`  existing ${counts.ok}${counts.bad ? `, broken ${counts.bad}` : ''}${counts.size ? `, wrong size ${counts.size}` : ''}  ->  to render ${todo.length}${FORCE ? ' (--force)' : ''}`);
if (!todo.length) { writeStatus('done'); console.log('render: nothing to do'); process.exit(0); }

// ---------- GPU lock ----------
writeStatus('waiting-gpu');
try {
  const holder = JSON.parse(fs.readFileSync(path.join(ROOT, 'out', '.gpu.lock'), 'utf8'));
  if (holder.pid !== process.pid && alive(holder.pid)) console.log(`render: waiting for the GPU lock (held by pid ${holder.pid}: ${holder.label}) ...`);
} catch {}
const tLock = Date.now();
const release = await acquireGpu('render ' + NAME);
if (Date.now() - tLock > 2000) console.log(`render: got the GPU lock after ${((Date.now() - tLock) / 1000).toFixed(1)} s`);
log(`# run pid ${process.pid}: ${W}x${H} tiles ${TX}x${TY} q=${Q} fps ${FPS} frames ${first}-${last} every ${EVERY}; to render ${todo.length}`);

for (const f of fs.readdirSync(DIR)) if (/\.tmp(\.png)?$/.test(f)) try { fs.unlinkSync(path.join(DIR, f)); } catch {}
reapChromes();
({ todo, counts } = scan());
run.done = FRAMES.length - todo.length; run.remaining = todo.length;
fs.writeFileSync(path.join(DIR, 'meta.json'), JSON.stringify({ name: NAME, width: W, height: H, tilesX: TX, tilesY: TY, fps: FPS, every: EVERY, q: Q, parts: PARTS, range: [first, last] }, null, 2));
writeStatus('running');

// ---------- main loop ----------
let writeP = null, consecutiveFails = 0, stopped = false, aborted = false;
const pushWin = (arr, v, n = 20) => { arr.push(v); if (arr.length > n) arr.shift(); };
for (let k = 0; k < todo.length; k++) {
  if (fs.existsSync(STOPFILE)) { try { fs.unlinkSync(STOPFILE); } catch {} stopped = true; console.log('render: STOP file found - stopping'); log('# stopped by STOP file'); break; }
  const idx = todo[k], t = idx / FPS, tStart = Date.now();
  let okFrame = false;
  for (let attempt = 1; attempt <= MAX_TRIES && !okFrame; attempt++) {
    try {
      if (!s) s = await openSession();
      const { r, buf, capMs } = await captureFrame(idx);
      if (writeP) await writeP;                 // at most one PNG encode in flight
      const wall = () => Date.now() - tStart;
      writeP = writeFrame(idx, buf).then(() => {
        run.done++;
        // ms = render inside the page, cap = capture call incl. pixel transfer, png = PNG encode,
        // saved = frame start (incl. any session start / retries) until the PNG is on disk
        log(`f${pad5(idx)}\tt=${t.toFixed(3)}\tms=${Math.round(r.ms)}\tcap=${capMs}\tpng=${writeFrame.lastMs}\tsaved=${wall()}\ttry=${attempt}\tsession=${run.session}`);
      }, (e) => {
        curTmp = null;
        run.failed.push(idx);
        log(`# f${pad5(idx)} write failed: ${e.message}`);
        console.error(`render: f${pad5(idx)} write failed: ${e.message}`);
      });
      okFrame = true;
      run.rendered++; run.lastFrame = idx; run.lastT = +t.toFixed(3); run.remaining = todo.length - k - 1;
      pushWin(run.renderMs, r.ms);
      s.framesDone++;
    } catch (e) {
      const msg = String(e?.message || e).split('\n')[0].slice(0, 300);
      log(`# f${pad5(idx)} try ${attempt}/${MAX_TRIES} failed: ${msg}`);
      console.warn(`render: f${pad5(idx)} try ${attempt}/${MAX_TRIES} failed: ${msg}`);
      await closeSession({ failed: true });
      await sleep(5000);
    }
  }
  if (!okFrame) {
    run.failed.push(idx); run.remaining = todo.length - k - 1;
    log(`# f${pad5(idx)} given up after ${MAX_TRIES} tries`);
    if (++consecutiveFails >= MAX_CONSECUTIVE_FAILS) { aborted = true; console.error(`render: ${consecutiveFails} frames in a row failed - aborting`); break; }
    writeStatus('running');
    continue;
  }
  consecutiveFails = 0;

  // gentle pacing
  await sleep(REST);
  if (run.rendered % 100 === 0) await sleep(4000);
  if (s && s.framesDone >= RESTART_EVERY && k < todo.length - 1) { log('# scheduled session restart'); await closeSession(); await sleep(2000); }

  pushWin(run.wallMs, Date.now() - tStart);
  if (run.rendered % 10 === 0 || k === todo.length - 1) {
    const sec = avg(run.wallMs) / 1000;
    console.log(`[${NAME}] ${FRAMES.length - run.remaining}/${FRAMES.length}  f${pad5(idx)} t=${t.toFixed(2)}s  render ${Math.round(avg(run.renderMs))} ms  ${sec.toFixed(2)} s/frame (${(1 / sec).toFixed(2)} fps)  ETA ${fmtDur(etaSec())}`);
  }
  writeStatus('running');
}
if (writeP) await writeP;
await closeSession();

// ---------- result ----------
const missing = FRAMES.filter((i) => frameState(framePath(i)) !== 'ok');
run.done = FRAMES.length - missing.length; run.remaining = missing.length;
const state = missing.length === 0 ? 'done' : stopped ? 'stopped' : aborted ? 'failed' : 'incomplete';
writeStatus(state);
const elapsed = (Date.now() - run.t0) / 1000;
const summary = `${state}: ${run.done}/${FRAMES.length} frames present, rendered ${run.rendered} this run in ${fmtDur(elapsed)}` +
  (run.rendered ? `, avg render ${Math.round(avg(run.renderMs))} ms` : '') +
  (missing.length ? `; missing ${missing.length} (first: ${missing.slice(0, 8).join(', ')})` : '');
console.log('render: ' + summary);
log('# ' + summary);
release();
process.exit(missing.length === 0 ? 0 : stopped ? 3 : 1);
