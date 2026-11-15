// Shared capture plumbing: Vite dev server + headless Chrome (GPU) + a tiny HTTP sink for raw frames.
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = path.join(ROOT, 'out', '.gpu.lock');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Only one GPU job at a time on this machine.
export async function acquireGpu(label = 'job') {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  for (;;) {
    try {
      fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, label, at: Date.now() }), { flag: 'wx' });
      break;
    } catch {
      let stale = false;
      try {
        const info = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
        try { process.kill(info.pid, 0); } catch { stale = true; }
      } catch { stale = true; }
      if (stale) { try { fs.unlinkSync(LOCK); } catch {} } else await sleep(1500);
    }
  }
  const release = () => { try { fs.unlinkSync(LOCK); } catch {} };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  return release;
}

export async function startSession({ quality = 'film', log = true, parts = null, capture = true, query = '' } = {}) {
  const vite = await createServer({ root: ROOT, logLevel: 'error', server: { port: 5200 + Math.floor(Math.random() * 700), strictPort: false, host: '127.0.0.1', hmr: false } });
  await vite.listen();
  const base = vite.resolvedUrls.local[0];

  let onFrame = null;
  const sink = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try { await onFrame?.(Buffer.concat(chunks), new URL(req.url, 'http://x').searchParams); res.writeHead(200); res.end('ok'); }
      catch (e) { console.error('sink error', e); res.writeHead(500); res.end(String(e)); }
    });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const sinkUrl = `http://127.0.0.1:${sink.address().port}/frame`;

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, protocolTimeout: 0,
    userDataDir: path.join(ROOT, 'out', '.chrome-profile'),      // keeps the compiled-shader cache between runs
    args: [
      `--use-angle=${process.env.WL_ANGLE || 'd3d11'}`, '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-vsync',
      '--disable-gpu-watchdog', '--disable-gpu-process-crash-limit',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--window-size=960,540', '--force-device-scale-factor=1', '--hide-scrollbars', '--mute-audio',
    ],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => {
    const t = m.type(), txt = m.text();
    if (t === 'error' || t === 'warn' || t === 'warning') { errors.push(txt); if (log) console.log(`[page ${t}] ${txt.slice(0, 3000)}`); }
  });
  page.on('pageerror', (e) => { errors.push(String(e)); console.log('[pageerror]', String(e).slice(0, 3000)); });
  await page.goto(`${base}?${capture ? 'capture=1&' : ''}q=${quality}${parts ? '&parts=' + parts : ''}${query}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.FILM && window.FILM.ready', { timeout: 120000 });
  await page.evaluate('window.FILM.ready');
  // puppeteer keeps the CDP Network domain on, which makes Chrome copy every posted frame into DevTools events
  try { await page._client().send('Network.disable'); } catch {}
  const gpu = await page.evaluate('window.FILM.gpu');

  return {
    page, gpu, sinkUrl, errors,
    setSink(fn) { onFrame = fn; },
    async capture(opts) { return page.evaluate((o) => window.FILM.capture(o), opts); },
    async close() { await browser.close().catch(() => {}); await vite.close().catch(() => {}); sink.close(); },
  };
}

export async function savePng(buf, width, height, file, { scale = 1 } = {}) {
  let img = sharp(buf, { raw: { width, height, channels: 4 } }).removeAlpha();
  if (scale !== 1) img = img.resize(Math.round(width * scale), Math.round(height * scale), { kernel: 'lanczos3' });
  await img.png({ compressionLevel: 3 }).toFile(file);
}

export async function contactSheet(files, outFile, { cols = 2, cellW = 960, labels = [] } = {}) {
  const metas = await Promise.all(files.map((f) => sharp(f).metadata()));
  const cellH = Math.round((cellW * metas[0].height) / metas[0].width);
  const rows = Math.ceil(files.length / cols), gap = 6;
  const W = cols * cellW + (cols + 1) * gap, H = rows * cellH + (rows + 1) * gap;
  const comps = [];
  for (let i = 0; i < files.length; i++) {
    const x = gap + (i % cols) * (cellW + gap), y = gap + Math.floor(i / cols) * (cellH + gap);
    comps.push({ input: await sharp(files[i]).resize(cellW, cellH).toBuffer(), left: x, top: y });
    if (labels[i]) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="30"><rect width="${labels[i].length * 9 + 16}" height="24" fill="rgba(0,0,0,.6)"/><text x="8" y="17" font-family="Consolas, monospace" font-size="15" fill="#fff">${labels[i]}</text></svg>`;
      comps.push({ input: Buffer.from(svg), left: x, top: y });
    }
  }
  await sharp({ create: { width: W, height: H, channels: 3, background: '#101014' } }).composite(comps).jpeg({ quality: 90 }).toFile(outFile);
}

export function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; a[k] = v; }
  }
  return a;
}
