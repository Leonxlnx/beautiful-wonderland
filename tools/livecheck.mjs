// Smoke test of the real-time demo path (no capture): loads the page, lets it play, takes a screenshot.
import path from 'node:path';
import { acquireGpu, startSession, ROOT } from './lib.mjs';
const rel = await acquireGpu('live');
const s = await startSession({ quality: 'live', capture: false, query: '&t=23' });
await s.page.setViewport({ width: 1280, height: 720 });
await new Promise((r) => setTimeout(r, 30000));
const hud = await s.page.evaluate(() => document.getElementById('hud')?.textContent);
await s.page.screenshot({ path: path.join(ROOT, 'out', 'shots', 'live.png') });
console.log('hud:', hud, '| page errors:', s.errors.length, s.errors.slice(0, 3).join(' | ').slice(0, 500));
await s.close(); rel(); process.exit(0);
