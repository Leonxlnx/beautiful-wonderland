import * as THREE from 'three';
import { U, setEnv } from './core/env.js';
import { Pipeline } from './core/pipeline.js';
import { Sky, skyUniforms } from './world/sky.js';
import { buildWorld } from './world/world.js';
import { Film } from './film/timeline.js';

THREE.ColorManagement.enabled = false;

const params = new URLSearchParams(location.search);
const CAPTURE = params.has('capture');
const QUALITY = {
  film: { name: 'film', msaa: 4, shadowSize: 4096, kuwahara: 5.0, skyLayers: 4, pad: 32, reflScale: 0.5, density: 1 },
  high: { name: 'high', msaa: 4, shadowSize: 4096, kuwahara: 4.0, skyLayers: 4, pad: 0, reflScale: 0.5, density: 0.6 },
  live: { name: 'live', msaa: 2, shadowSize: 2048, kuwahara: 0, skyLayers: 3, pad: 0, reflScale: 0.35, density: 0.3 },
};
const quality = QUALITY[params.get('q') || (CAPTURE ? 'film' : 'live')] || QUALITY.live;

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(1);
renderer.info.autoReset = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.3, 4000);
const pipeline = new Pipeline(renderer, quality);
const sky = new Sky(renderer);
const only = params.get('parts') ? params.get('parts').split(',') : null;
const world = await buildWorld({ scene, pipeline, quality, renderer, only });
const film = new Film(world);

const gl = renderer.getContext();
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const gpuName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';

// Sets the whole world to film time t (pure function of t), optionally with a free "view" override.
function setTime(t, view) {
  const s = film.apply(t, camera, view);
  setEnv(s.tod, t);
  skyUniforms.uSkyDebug.value = view?.skyDebug ? 1 : 0;
  if (view?.seed !== undefined) skyUniforms.uCloudSeed.value = view.seed;
  world.update(t, camera, s);
  sky.update(t);
  pipeline.fade = s.fade ?? 1;
  return s;
}

async function renderFrame(t, { width, height, tilesX = 1, tilesY = 1, toScreen = false, view, frame = 0 } = {}) {
  const s = setTime(t, view);
  return pipeline.render({
    scene, camera, width, height, tilesX, tilesY, toScreen, frameSeed: frame * 7.13,
    focus: s.focus, shadowSize: s.shadowSize, reflect: s.reflect,
    onTile: () => new Promise((r) => setTimeout(r, 0)),
  });
}

window.FILM = {
  duration: film.duration, fps: 30, gpu: gpuName, quality: quality.name,
  ready: Promise.resolve(true),
  info: () => ({ gpu: gpuName, calls: renderer.info.render.calls, tris: renderer.info.render.triangles, programs: renderer.info.programs?.length }),
  // Render one frame off-screen and POST the raw RGBA (top-down) to the capture server.
  async capture({ t = 0, width = 1920, height = 1080, tilesX = 1, tilesY = 1, view = null, url = null, frame = 0 }) {
    const t0 = performance.now();
    renderer.info.reset();
    const px = await renderFrame(t, { width, height, tilesX, tilesY, view, frame });
    const ms = performance.now() - t0;
    if (url) {
      const res = await fetch(url, { method: 'POST', body: px, headers: { 'Content-Type': 'application/octet-stream' } });
      if (!res.ok) throw new Error('post failed ' + res.status);
    }
    return { ms, calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
  },
};

if (!CAPTURE) {
  // Live demo: plays the film in real time, loops; drag to look around when paused.
  const hud = document.getElementById('hud');
  let playing = true, tFilm = Number(params.get('t') || 0), last = performance.now(), fpsS = 0;
  // Soundtrack (licensed music + real recordings, see assets/audio/CREDITS.md). Browsers only allow audio after a gesture.
  const audio = new Audio('./audio/mix.mp3');
  audio.preload = 'auto';
  let soundOn = false;
  const enableSound = () => { if (soundOn) return; soundOn = true; audio.currentTime = tFilm; audio.play().catch(() => { soundOn = false; }); };
  window.addEventListener('pointerdown', enableSound);
  window.addEventListener('keydown', enableSound);
  const resize = () => { renderer.setSize(window.innerWidth, window.innerHeight, false); };
  window.addEventListener('resize', resize); resize();
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { playing = !playing; if (soundOn) { if (playing) audio.play().catch(() => {}); else audio.pause(); } }
    if (e.code === 'ArrowRight') tFilm = Math.min(film.duration, tFilm + 1);
    if (e.code === 'ArrowLeft') tFilm = Math.max(0, tFilm - 1);
  });
  const loop = async (now) => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (playing) tFilm = (tFilm + dt) % film.duration;
    if (soundOn && playing && Math.abs(audio.currentTime - tFilm) > 0.3) audio.currentTime = tFilm;
    await renderFrame(tFilm, { width: canvas.width, height: canvas.height, toScreen: true });
    fpsS = fpsS * 0.9 + (1 / Math.max(dt, 1e-3)) * 0.1;
    if (hud) hud.textContent = `${tFilm.toFixed(1)}s · ${fpsS.toFixed(0)} fps · ${quality.name} · space = pause, ←/→ = scrub${soundOn ? '' : ' · click for sound'}`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
