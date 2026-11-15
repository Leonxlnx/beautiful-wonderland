import * as THREE from 'three';
import { heightAt, WHEEL, JETTY } from '../world/layout.js';
import { U } from '../core/env.js';
import { clamp, lerp, smoothstep, valueNoise2 } from '../core/rng.js';

// The film: one source of truth for camera, time of day and every event. Pure function of t.
//
//   "the wind still remembers" — a child with a red kite crosses a world that nature took back;
//   at dusk the wind wakes the old lamps and the Ferris wheel.
//
// Music: "Classical 3" (Jonny S., Mixkit), window from 22.570 s, 64.7 BPM; downbeats every 3.70 s,
// full-ensemble lift at 22.13 s, back to solo piano at 36.97 s. Cuts are those downbeats snapped to frames.
export const CUTS = { meadow: 0, jetty: 3.7, forest: 7.4, hill: 11.1, ascent: 14.8, sunset: 22.1333, wake: 29.5333, finale: 36.9666, end: 40.0 };
export const CUES = { birds: 0.93, wheelOn: 32.32, wheelLit: 35.1, wheelTurn: 33.25, fadeOut: 38.7 };
// One switch-on time per lamp, far end of the promenade first, the booth last (beats and accents of the music).
const LAMP_T = [25.9, 26.15, 26.4, 26.65, 26.9, 27.15, 27.4, 27.6, 27.72, 28.37, 28.63, 29.07, 29.53, 30.49, 31.39];

const g = (x, z, h = 0) => new THREE.Vector3(x, heightAt(x, z) + h, z);
const v = (x, y, z) => new THREE.Vector3(x, y, z);
const path = (pts) => new THREE.CatmullRomCurve3(pts, false, 'centripetal');
const io = (t) => t * t * (3 - 2 * t);
const WIND_DAY = [0.92, 0.39], WIND_DUSK = [-0.75, 0.66];
const HUB = v(WHEEL.x, 16.4, WHEEL.z);

// hill run: straight line up the slope towards the lone tree
const HILL_A = g(-91.5, -56.5), HILL_B = g(-105.5, -69.5);
const HILL_D = v(HILL_B.x - HILL_A.x, 0, HILL_B.z - HILL_A.z).normalize();
const HILL_R = v(-HILL_D.z, 0, HILL_D.x);
const hillCam = (u) => {
  const p = HILL_A.clone().lerp(HILL_B, u);
  const c = p.clone().addScaledVector(HILL_D, -5.2 - 1.2 * u).addScaledVector(HILL_R, 1.8);
  c.y = heightAt(c.x, c.z) + 1.0 + 1.5 * u;
  return { pos: c, look: p.clone().addScaledVector(HILL_D, 7).add(v(0, 2.0 + 1.5 * u, 0)) };
};
// ascent: where the kite hangs above the hilltop
const kiteAloft = (u, t) => v(HILL_B.x + 7.4 + 0.3 * Math.sin(t * 1.9), HILL_B.y + 18 + 6 * u + 0.25 * Math.sin(t * 2.7 + 1), HILL_B.z + 3.1 + 0.3 * Math.sin(t * 1.3));
const ASCENT = path([hillCam(1).pos, v(-95.5, HILL_B.y + 10.5, -64.5), v(-94.4, HILL_B.y + 19.4, -64.4), v(-76, 37, -62.5), v(-45, 22.5, -62)]);

const SHOTS = [
  {
    // HOOK — already flying: low and fast over the poppy meadow, the kite right at the lens, the wheel ahead.
    name: 'meadow', t0: CUTS.meadow, t1: CUTS.jetty, fov: [52, 47], tod: [0, 0.08], wind: WIND_DAY, gust: [1.25, 1.1],
    cam: path([g(101, 76, 1.0), g(90, 62, 1.15), g(79, 47, 1.6), g(70, 35, 2.5)]),
    look: path([v(30, 9, 24), v(8, 11, 16), v(-12, 13, 10), HUB.clone().add(v(0, -3, 0))]),
    ease: (u) => u * (0.82 + 0.18 * u), shadow: 150, reflect: true, shake: 0.035,
    actors(a, u, t, cam) {
      const A = g(79, 52), B = g(63, 27);
      const p = A.clone().lerp(B, u);
      a.child.set({ x: p.x, z: p.z, y: p.y, heading: Math.atan2(B.z - A.z, B.x - A.x), pose: 'run', armUp: 0.9, visible: true });
      // the kite starts right in front of the lens and climbs away ahead of us
      const k = cam.pos.clone().addScaledVector(cam.fwd, 6.5 + 13 * u).addScaledVector(cam.right, 2.1 - 1.4 * u).add(v(0, 1.9 + 4.2 * u, 0));
      k.x += Math.sin(t * 2.3) * 0.25; k.y += Math.sin(t * 3.1 + 1) * 0.18;
      a.kite.set({ pos: [k.x, k.y, k.z], visible: true });
      a.petals.set({ amount: 0.75 });
    },
  },
  {
    // The wheel: a long-lens chase down the old jetty, kite, child and wheel in one line.
    name: 'jetty', t0: CUTS.jetty, t1: CUTS.forest, fov: [38, 36], tod: [0.12, 0.3], wind: WIND_DAY, gust: [1.0, 1.0],
    camFn(u) {
      const cx = lerp(49, 27, u);
      return { pos: v(cx + 17 - 2.5 * u, 3.0 + 0.5 * u, 8.25), look: v(cx - 40, 9.5 + 1.5 * u, 8.6) };
    },
    shadow: 130, reflect: true, shake: 0.02,
    actors(a, u, t) {
      const cx = lerp(49, 27, u);
      a.child.set({ x: cx, z: JETTY.z, y: JETTY.y, heading: Math.PI, pose: 'run', armUp: 0.9, visible: true });
      a.kite.set({ pos: [cx + 4.5 + 0.25 * Math.sin(t * 2.3), 7.6 + 0.2 * Math.sin(t * 3.1 + 1), 11.4 + 0.3 * Math.sin(t * 1.7)], visible: true });
      a.petals.set({ amount: 0.3 });
    },
  },
  {
    // The forest glade: shafts of light, a quiet breath before the hill.
    name: 'forest', t0: CUTS.forest, t1: CUTS.hill, fov: [38, 35], tod: [0.62, 0.8], wind: WIND_DAY, gust: [0.6, 0.6],
    cam: path([g(86, -103, 1.35), g(84, -105, 1.4), g(82, -107.2, 1.5)]),
    look: path([g(69, -119, 2.6), g(70, -118, 2.8), g(71, -117.5, 3.0)]),
    ease: io, shadow: 80, reflect: false, shake: 0.012,
    actors(a, u) {
      const A = g(70.3, -108.1), B = g(73, -113.6);
      const p = A.clone().lerp(B, u);
      a.child.set({ x: p.x, z: p.z, y: p.y, heading: Math.atan2(B.z - A.z, B.x - A.x), pose: 'walk', armUp: 0.35, visible: true });
      a.kite.fly({ height: 1.7, back: 1.5, side: 0.4, visible: true });
      a.petals.set({ amount: 0.22 });
    },
  },
  {
    // Golden hour: running up the kite hill into the wind, the camera at her shoulder.
    name: 'hill', t0: CUTS.hill, t1: CUTS.ascent, fov: [46, 44], tod: [1.02, 1.3], wind: WIND_DAY, gust: [1.35, 1.2],
    camFn: (u) => hillCam(u), shadow: 130, reflect: false, shake: 0.03,
    actors(a, u) {
      const p = HILL_A.clone().lerp(HILL_B, u);
      a.child.set({ x: p.x, z: p.z, y: heightAt(p.x, p.z), heading: Math.atan2(HILL_D.z, HILL_D.x), pose: 'run', armUp: 1, visible: true });
      a.kite.fly({ height: 10 + 8 * u, back: 6 + 1.4 * u, side: 0, visible: true });
      a.petals.set({ amount: 0.55 });
    },
  },
  {
    // The ascent: up the string to the kite, then falling back while the sky catches fire behind the lone tree.
    name: 'ascent', t0: CUTS.ascent, t1: CUTS.sunset, fov: [44, 40], tod: [1.3, 2.0], wind: WIND_DAY, gust: [1.1, 0.9],
    camFn(u, t) {
      const e = io(u);
      const pos = ASCENT.getPointAt(clamp(e));
      const k = kiteAloft(u, t);
      const look = HILL_B.clone().add(v(0, 3.5, 0)).lerp(k, smoothstep(0, 0.24, u)).lerp(v(-113, 31, -70), smoothstep(0.42, 0.88, u));
      return { pos, look };
    },
    todEase: io, shadow: 300, reflect: false, shake: 0.02,
    actors(a, u, t) {
      a.child.set({ x: HILL_B.x, z: HILL_B.z, y: HILL_B.y, heading: Math.atan2(HILL_D.z, HILL_D.x), pose: 'stand', armUp: 1, visible: true });
      const k = kiteAloft(u, t);
      a.kite.set({ pos: [k.x, k.y, k.z], visible: true });
      a.petals.set({ amount: 0.3 * (1 - u) });
    },
  },
  {
    // THE PAINTING: sunset over the pond, the wheel in silhouette. The lamps run down the jetty after her.
    name: 'sunset', t0: CUTS.sunset, t1: CUTS.wake, fov: [44, 42], tod: [2.0, 2.5], wind: WIND_DUSK, gust: [0.8, 0.7],
    cam: path([g(75, 17.5, 1.9), g(72, 16.2, 1.8), g(69.5, 15.2, 1.7)]),
    look: path([v(-22, 13, 2), v(-22, 12.6, 3), v(-22, 12.2, 4)]),
    ease: io, shadow: 240, reflect: true, shake: 0.008,
    actors(a, u) {
      a.child.set({ x: lerp(58, 46, u), z: JETTY.z, y: JETTY.y, heading: Math.PI, pose: 'walk', armUp: 0.85, visible: true });
      a.kite.fly({ height: 11, back: 7, side: 0, visible: true });
      a.petals.set({ amount: 0.12 });
    },
  },
  {
    // The wheel wakes: close behind her as the lights run out along the spokes and it begins to turn.
    name: 'wake', t0: CUTS.wake, t1: CUTS.finale, fov: [54, 55], tod: [2.5, 2.93], wind: WIND_DUSK, gust: [0.7, 0.9],
    cam: path([v(20.0, 1.3, 7.0), v(20.4, 1.5, 7.05), v(21.0, 1.8, 7.15)]),
    look: path([v(-20, 13.5, 8), v(-20, 14.4, 8), v(-20, 15.2, 8)]),
    ease: io, shadow: 120, reflect: true, shake: 0.006,
    actors(a, u) {
      a.child.set({ x: 14.5, z: JETTY.z, y: JETTY.y, heading: Math.PI, pose: 'stand', armUp: 0.9, visible: true });
      a.kite.fly({ height: 10.5, back: 9, side: 0, visible: true });
      a.petals.set({ amount: 0.1 });
    },
  },
  {
    // Afterglow: the wheel turns again. One last wide breath, then out.
    name: 'finale', t0: CUTS.finale, t1: CUTS.end, fov: [41, 44], tod: [2.93, 3.0], wind: WIND_DUSK, gust: [0.8, 0.8],
    cam: path([g(60, 33, 2.6), g(63, 37, 3.6), g(66.5, 41.5, 4.8)]),
    look: path([v(-14, 12.5, 8), v(-15, 12.8, 8), v(-16, 13.2, 8)]),
    ease: (u) => u, shadow: 200, reflect: true, shake: 0.005,
    actors(a, u) {
      a.child.set({ x: 14.5, z: JETTY.z, y: JETTY.y, heading: Math.PI, pose: 'stand', armUp: 0.9, visible: true });
      a.kite.fly({ height: 10.5, back: 9, side: 0, visible: true });
      a.petals.set({ amount: 0.08 });
    },
  },
];

export class Film {
  constructor(world) {
    this.world = world;
    this.duration = CUTS.end;
    this.shots = SHOTS;
    this._warned = new Set();
    this._setupDone = false;
  }

  shotAt(t) {
    for (let i = SHOTS.length - 1; i >= 0; i--) if (t >= SHOTS[i].t0 - 1e-6) return SHOTS[i];
    return SHOTS[0];
  }

  _try(label, fn) {
    try { fn(); } catch (e) { if (!this._warned.has(label)) { this._warned.add(label); console.warn(`film: ${label}: ${e.message}`); } }
  }

  // One-time placement of things the timeline owns (bird launches, butterflies, fireflies).
  _setup() {
    this._setupDone = true;
    const a = this.world.byName.actors;
    if (!a) return;
    this._try('setup', () => {
      a.demo?.(false);
      a.birds.clear();
      a.birds.launch({ origin: [60, 1.2, 30], t0: CUES.birds, count: 26, dir: [-0.75, -0.4], spread: 0.9 });
      a.birds.launch({ origin: [-30, 3, 24], t0: CUTS.sunset + 0.6, count: 18, dir: [0.2, -1], spread: 0.6 });
      a.butterflies.setSpots([[72, heightAt(72, -116) + 1.4, -116, 9], [74, heightAt(74, 45) + 1, 45, 5], [-97, heightAt(-97, -61) + 1, -61, 6]]);
      a.fireflies.setZones([[20, 1.4, 8, 16, 70], [50, 1.8, 12, 22, 60], [-8, 2, 10, 20, 50], [66, heightAt(66, 22) + 1, 22, 14, 40]]);
    });
  }

  // view (look-dev): { pos, look, fov, tod, ground, reflect, shadowSize, film } — with film:true the film's
  // actors/events are applied for time t and only the camera is replaced.
  apply(t, camera, view) {
    const s = { tod: 0, focus: new THREE.Vector3(), shadowSize: 120, reflect: false, fade: 1, shot: null };
    const useFilm = !view || view.film;
    if (useFilm) {
      if (!this._setupDone) this._setup();
      const sh = this.shotAt(Math.min(t, this.duration - 1e-4));
      const u = clamp((t - sh.t0) / (sh.t1 - sh.t0));
      let pos, look;
      if (sh.camFn) ({ pos, look } = sh.camFn(u, t));
      else {
        const e = clamp(sh.ease ? sh.ease(u) : u);
        pos = sh.cam.getPointAt(e); look = sh.look.getPointAt(e);
      }
      // hand-held breath
      const k = sh.shake ?? 0.01;
      camera.position.copy(pos);
      camera.position.x += (valueNoise2(t * 0.7, 1.3) - 0.5) * k * 2;
      camera.position.y += (valueNoise2(t * 0.9, 7.7) - 0.5) * k * 1.4;
      look.x += (valueNoise2(t * 0.5, 4.1) - 0.5) * k * 8;
      look.y += (valueNoise2(t * 0.6, 9.9) - 0.5) * k * 6;
      camera.fov = lerp(sh.fov[0], sh.fov[1], io(u));
      camera.up.set(0, 1, 0);
      camera.lookAt(look);
      s.tod = lerp(sh.tod[0], sh.tod[1], sh.todEase ? sh.todEase(u) : u);
      s.shadowSize = sh.shadow; s.reflect = sh.reflect; s.shot = sh.name; s.u = u;
      U.uWind.value.set(sh.wind[0], sh.wind[1], lerp(sh.gust[0], sh.gust[1], u));
      s.fade = 1 - smoothstep(CUES.fadeOut, this.duration - 0.05, t);
      this._events(t, sh, u, camera);
    }
    if (view) {
      if (view.pos) {
        const p = view.pos, l = view.look;
        camera.position.set(p[0], view.ground ? heightAt(p[0], p[2]) + p[1] : p[1], p[2]);
        camera.fov = view.fov ?? 42;
        camera.up.set(0, 1, 0);
        camera.lookAt(l[0], l[1], l[2]);
      }
      if (view.tod !== undefined || !useFilm) s.tod = view.tod ?? 0;
      s.shadowSize = view.shadowSize ?? (useFilm ? s.shadowSize : 120);
      s.reflect = view.reflect ?? (useFilm ? s.reflect : false);
      s.fade = 1;
      if (!useFilm) U.uWind.value.set(WIND_DAY[0], WIND_DAY[1], 1);
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
    const fx = camera.position.x + fwd.x * s.shadowSize * 0.36, fz = camera.position.z + fwd.z * s.shadowSize * 0.36;
    s.focus.set(fx, heightAt(fx, fz), fz);
    return s;
  }

  _events(t, sh, u, camera) {
    const w = this.world.byName;
    camera.updateMatrixWorld(true);
    const cam = {
      pos: camera.position.clone(),
      fwd: new THREE.Vector3(0, 0, -1).transformDirection(camera.matrixWorld),
      right: new THREE.Vector3(1, 0, 0).transformDirection(camera.matrixWorld),
    };
    if (w.actors && sh.actors) this._try('actors:' + sh.name, () => sh.actors(w.actors, u, t, cam));
    if (w.actors) this._try('fireflies', () => { w.actors.fireflies.amount = smoothstep(26.5, 33, t); });
    if (w.props) {
      this._try('lights', () => {
        // lamp i switches on when lamps * (n + 1) > i + 1; drive that count from the per-lamp cue times
        const n = w.props.lamps?.length ?? LAMP_T.length;
        let count = clamp((t - (LAMP_T[0] - 0.2)) / 0.2);
        for (let i = 0; i < Math.min(n, LAMP_T.length); i++) {
          const next = LAMP_T[i + 1] ?? LAMP_T[i] + 0.6;
          if (t >= LAMP_T[i]) count = i + 1 + clamp((t - LAMP_T[i]) / (next - LAMP_T[i]));
        }
        const wheel = clamp((t - CUES.wheelOn) / (CUES.wheelLit - CUES.wheelOn));
        w.props.setLights({ lamps: Math.min(1, count / (n + 1) + 1e-4), wheel: wheel });
        // the wheel eases into a slow turn
        const dt = Math.max(0, t - CUES.wheelTurn);
        w.props.setWheelAngle(0.21 + 0.12 * (dt - 1.6 * (1 - Math.exp(-dt / 1.6))));
      });
    }
  }
}
