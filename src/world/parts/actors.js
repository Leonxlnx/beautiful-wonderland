// Living things: the child with the red kite, white birds, butterflies, drifting petals and fireflies.
// Everything is a pure function of the API state and film time t (frames render out of order).
//
// API (units metres / seconds / radians):
//   child.set({ x, z, y?, heading, pose, armUp, visible })
//       heading: 0 = facing +X, positive turns towards +Z (facing = (cos h, 0, sin h)); pose 'stand'|'walk'|'run'|'sit'
//       y defaults to heightAt(x, z) whenever x or z is given without y; armUp 0..1 raises the kite (right) arm,
//       aiming it at the kite when one is visible; visible defaults to true. Fields not given keep their value.
//   child.handWorld(t?) -> THREE.Vector3 kite hand (t defaults to the last updated time)
//   kite.set({ pos: [x, y, z], visible, string })            explicit placement (no wobble)
//   kite.fly({ height = 7, back = 9, side = 0, visible, string })  downwind of the child by `back`, `height` above the
//       hand, `side` metres to the left of the wind; figure-eight wobble from t.  kite.position() -> Vector3
//   birds.launch({ origin: [x, y, z], t0, count = 12, dir: [x, z] (default into the wind), spread = 0.9 rad }), birds.clear()
//   butterflies.setSpots([[x, y, z, count, radius = 1.6], ...])
//   petals.set({ amount 0..1, color: 0xrrggbb | [r, g, b] })
//   fireflies.setZones([[x, y, z, radius, count], ...]); fireflies.amount = 0..1 (or fireflies.set({ amount }))
// Demo: while nothing has been set through the API, state.demo !== false and globalThis.__actorsDemo !== false,
// a look-dev demo runs (child running on the jetty with the kite, birds at t0 = 1, butterflies, petals, fireflies).
// The first API call switches it off for good; actors.demo(true | false | null) forces on / off / automatic.
import * as THREE from 'three';
import { paintMaterial, register } from '../../core/materials.js';
import { U, hex } from '../../core/env.js';
import { heightAt, JETTY } from '../layout.js';
import { makeRng, valueNoise2 } from '../../core/rng.js';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const glv = (v) => `vec3(${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)})`;

const COL = {
  skin: hex(0xf2cfa8), tunic: hex(0xf4efe2), hair: hex(0x1d2235), boot: hex(0x7a4a2e), cuff: hex(0x5a3522),
  scarf: hex(0xe8442e), eye: hex(0x2a2030), cream: hex(0xf4ecd8), hem: hex(0xc4301f), spar: hex(0x6b4a32),
  string: hex(0xf3ead2), bird: hex(0xf8f5ec), birdTip: hex(0xb2b8c6), petal: hex(0xf5d2dc), fluff: hex(0xfbfaf3),
  bWhite: hex(0xfbf9f0), bYellow: hex(0xf6ee9c), bBody: hex(0x4a4038),
};

// Toon light shared by the solid actors: crisp terminator, cast shadows, sky fill, vivid reds keep luminance.
const ACTOR_SHADE = /* glsl */ `
vec3 actorShade(vec3 base, vec3 N, float keep, float wob){
  float n1 = vnoise3(vW * 7.3);
  float ndl = dot(N, uSunDir) + (n1 - .5) * wob;
  float sh = getShadow(vW + N * .05, vec2(0.));
  float lit = paintBand(ndl, .04, .045) * sh;
  float hi = paintBand(ndl, .8, .05) * .4 * sh;
  vec3 col = paintLight(base, lit, hi);
  col += uAmbientAdd * .5 * smoothstep(.2, .9, N.y) * (1. - lit * uSunAmt);
  float red = step(.5, keep) * step(keep, 1.5), skin = step(1.5, keep);
  col = max(col, base * red * mix(.6, .74, lit));
  // skin: warm, rosy shadows instead of the cool blue
  float sl = dot(col, vec3(.3333));
  col = mix(col, base * vec3(.86, .68, .72) * clamp(sl * 2., 0., 1.), skin * .75 * (1. - lit) * uSunAmt);
  return col;
}`;

// ---------------------------------------------------------------- child rig
// Model space: feet on y = 0, facing +X, the child's right hand side is +Z. Bones rotate about pivots.
const NB = 11;
const PIV = [[0, .53, 0], [0, .53, 0], [0, .9, 0], [0, .85, -.105], [0, .68, -.115], [0, .85, .105], [0, .68, .115],
  [0, .53, -.06], [0, .29, -.06], [0, .53, .06], [0, .29, .06]];
const PAR = [-1, 0, 1, 1, 3, 1, 5, 0, 7, 0, 9];
// 0 pelvis · 1 torso · 2 head · 3/4 left upper/fore arm · 5/6 right (kite) arm · 7/8 left thigh/shin · 9/10 right leg
const HAND_REST = new THREE.Vector3(0.004, 0.515, 0.116);
const KNOT_REST = new THREE.Vector3(-0.066, 0.862, 0);

function buildChildGeometry() {
  const A = { pos: [], nrm: [], col: [], bone: [], flex: [], keep: [], idx: [] };
  const add = (g, { color, bone, keep = 0, flex = null, m = null }) => {
    if (m) g.applyMatrix4(m);
    const p = g.attributes.position, n = g.attributes.normal, base = A.pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      A.pos.push(x, y, z); A.nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      A.col.push(color.x, color.y, color.z); A.bone.push(bone); A.keep.push(keep); A.flex.push(flex ? flex(x, y, z) : 0);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) A.idx.push(base + g.index.getX(i));
    else for (let i = 0; i < p.count; i++) A.idx.push(base + i);
    g.dispose();
  };
  const M = (x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) => new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

  // head + bob haircut (a sphere whose face part is tucked inside the head, the rest hangs straight to the jaw)
  const HC = [0.006, 1.015, 0];
  add(new THREE.SphereGeometry(0.1, 24, 18), { color: COL.skin, keep: 2, bone: 2, m: M(HC[0], HC[1], HC[2], 1, 1.02, 0.95) });
  const hair = new THREE.SphereGeometry(1, 44, 30);
  const hp = hair.attributes.position;
  for (let i = 0; i < hp.count; i++) {
    let x = hp.getX(i), y = hp.getY(i), z = hp.getZ(i);
    const cut = lerp(-0.64, 0.3, sstep(0.28, 0.72, x));
    if (y < cut) { x *= 0.6; y *= 0.6; z *= 0.6; } else if (y < 0.15) {
      const rh = Math.hypot(x, z) || 1, k = (0.989 * (1 + 0.07 * (0.15 - y))) / rh;
      x *= k; z *= k;
    }
    hp.setXYZ(i, x * 0.113, y * 0.116, z * 0.108);
  }
  hair.computeVertexNormals();
  add(hair, { color: COL.hair, bone: 2, m: M(HC[0] - 0.008, HC[1] + 0.01, HC[2]) });
  for (const s of [-1, 1]) add(new THREE.SphereGeometry(0.012, 8, 6), { color: COL.eye, bone: 2, m: M(HC[0] + 0.083, HC[1] - 0.014, s * 0.046) });
  add(new THREE.CylinderGeometry(0.031, 0.035, 0.1, 10), { color: COL.skin, keep: 2, bone: 1, m: M(0, 0.9, 0) });

  // oversized tunic, flaring a little; the skirt part flutters (flex)
  const prof = [[0.17, 0.392], [0.167, 0.42], [0.152, 0.48], [0.134, 0.55], [0.116, 0.63], [0.104, 0.71], [0.099, 0.78],
    [0.095, 0.83], [0.084, 0.865], [0.056, 0.886], [0.03, 0.894]].map(([r, y]) => new THREE.Vector2(r, y));
  add(new THREE.LatheGeometry(prof, 22), {
    color: COL.tunic, bone: 1, m: M(0, 0, 0, 0.84, 1, 1), flex: (x, y) => Math.max(0, Math.min(1, (0.64 - y) / 0.24)),
  });
  // scarf wrapped round the neck + knot at the back
  add(new THREE.TorusGeometry(0.056, 0.027, 8, 20), { color: COL.scarf, bone: 1, keep: 1, m: M(0, 0.868, 0, 0.92, 1, 1, Math.PI / 2) });
  add(new THREE.SphereGeometry(0.032, 10, 8), { color: COL.scarf, bone: 1, keep: 1, m: M(KNOT_REST.x, KNOT_REST.y, 0, 0.8, 1, 1.2) });

  for (const s of [-1, 1]) {
    const ua = s < 0 ? 3 : 5, fa = ua + 1, th = s < 0 ? 7 : 9, sh = th + 1;
    add(new THREE.CapsuleGeometry(0.039, 0.05, 4, 10), { color: COL.tunic, bone: ua, m: M(0, 0.815, s * 0.107) });
    add(new THREE.CapsuleGeometry(0.026, 0.15, 4, 8), { color: COL.skin, keep: 2, bone: ua, m: M(0, 0.765, s * 0.11) });
    add(new THREE.CapsuleGeometry(0.024, 0.14, 4, 8), { color: COL.skin, keep: 2, bone: fa, m: M(0, 0.605, s * 0.115) });
    add(new THREE.SphereGeometry(0.031, 10, 8), { color: COL.skin, keep: 2, bone: fa, m: M(HAND_REST.x, HAND_REST.y, s * HAND_REST.z) });
    add(new THREE.CapsuleGeometry(0.037, 0.22, 4, 10), { color: COL.skin, keep: 2, bone: th, m: M(0, 0.41, s * 0.06) });
    add(new THREE.CapsuleGeometry(0.031, 0.19, 4, 10), { color: COL.skin, keep: 2, bone: sh, m: M(0, 0.185, s * 0.06) });
    add(new THREE.CylinderGeometry(0.039, 0.042, 0.1, 12), { color: COL.boot, bone: sh, m: M(0, 0.075, s * 0.06) });
    add(new THREE.CylinderGeometry(0.045, 0.045, 0.028, 12), { color: COL.cuff, bone: sh, m: M(0, 0.124, s * 0.06) });
    add(new THREE.CapsuleGeometry(0.036, 0.07, 4, 10), { color: COL.boot, bone: sh, m: M(0.028, 0.036, s * 0.06, 0.85, 1, 1.05, 0, 0, Math.PI / 2) });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(A.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(A.nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(A.col, 3));
  g.setAttribute('aBone', new THREE.Float32BufferAttribute(A.bone, 1));
  g.setAttribute('aFlex', new THREE.Float32BufferAttribute(A.flex, 1));
  g.setAttribute('aKeep', new THREE.Float32BufferAttribute(A.keep, 1));
  g.setIndex(A.idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.6, 0), 1.1);
  return g;
}

// Pose: per bone [x, y, z] Euler (order ZXY: z = swing forward/back, x = sideways, y = twist) + pelvis offset.
function childPose(pose, t, armUp, aim) {
  const P = Array.from({ length: NB }, () => [0, 0, 0]);
  const off = [0, 0, 0];
  const s = (i, x, y, z) => { P[i][0] = x; P[i][1] = y; P[i][2] = z; };
  const arm = (side, swing, abd, elbow) => { const u = side < 0 ? 3 : 5; s(u, -side * abd, 0, swing); s(u + 1, 0, 0, elbow); };
  const leg = (side, swing, abd, knee) => { const u = side < 0 ? 7 : 9; s(u, -side * abd, 0, swing); s(u + 1, 0, 0, -knee); };
  let speed = 0;
  if (pose === 'walk') {
    const ph = TAU * 0.9 * t, sn = Math.sin(ph);
    const knee = (q) => 0.08 + 0.65 * Math.pow(Math.max(0, Math.cos(q + 0.6)), 2);
    off[1] = -0.53 * (1 - Math.cos(0.38 * sn)) + 0.005 * Math.cos(2 * ph);
    s(0, 0.025 * sn, 0.07 * sn, 0);
    s(1, 0, -0.12 * sn, -0.06);
    s(2, 0, 0.05 * sn, 0.05);
    leg(-1, 0.38 * sn, 0.02, knee(ph)); leg(1, -0.38 * sn, 0.02, knee(ph + Math.PI));
    arm(-1, -0.34 * sn, 0.17, 0.22 + 0.14 * Math.max(0, -sn)); arm(1, 0.34 * sn, 0.17, 0.22 + 0.14 * Math.max(0, sn));
    speed = 1.15;
  } else if (pose === 'run') {
    const ph = TAU * 1.55 * t, sn = Math.sin(ph);
    const knee = (q) => 0.35 + 1.25 * Math.pow(Math.max(0, Math.cos(q + 1.0)), 1.5);
    off[1] = -0.03 + 0.05 * Math.abs(sn);
    s(0, 0.03 * sn, 0.12 * sn, -0.06);
    s(1, 0, -0.18 * sn, -0.18);
    s(2, 0, 0.1 * sn, 0.2);
    leg(-1, 0.12 + 0.72 * sn, 0.03, knee(ph)); leg(1, 0.12 - 0.72 * sn, 0.03, knee(ph + Math.PI));
    arm(-1, 0.1 - 0.75 * sn, 0.24, 1.25 + 0.2 * sn); arm(1, 0.1 + 0.75 * sn, 0.24, 1.25 - 0.2 * sn);
    speed = 3.4;
  } else if (pose === 'sit') {
    off[1] = 0.08 - 0.53;
    s(0, 0, 0, 0.15);
    s(1, 0.02 * Math.sin(t * 0.5), 0.05 * Math.sin(t * 0.3), 0.15 + 0.012 * Math.sin(t * 1.5));
    s(2, 0.03 * Math.sin(t * 0.37), 0.2 * Math.sin(t * 0.21), -0.2 + 0.06 * Math.sin(t * 0.43));
    const kw = 0.05 * Math.sin(t * 0.6);
    leg(-1, 2.15, 0.13 + kw, 1.71); leg(1, 2.15, 0.13 - kw, 1.71);
    arm(-1, -0.6, 0.3, 0.05); arm(1, -0.6, 0.3, 0.05);
  } else {
    off[1] = 0.004 * Math.sin(t * 1.6);
    s(0, 0.03 * Math.sin(t * 0.55), 0.03 * Math.sin(t * 0.31), 0);
    s(1, -0.02 * Math.sin(t * 0.55 + 0.4), 0.04 * Math.sin(t * 0.37), -0.02 + 0.015 * Math.sin(t * 1.6));
    s(2, 0.04 * Math.sin(t * 0.41), 0.18 * Math.sin(t * 0.23), 0.04 * Math.sin(t * 0.53));
    const w = 0.03 * Math.sin(t * 0.55);
    leg(-1, 0.03, 0.05 + w, 0.04); leg(1, -0.03, 0.05 - w, 0.04);
    arm(-1, 0.04 * Math.sin(t * 0.7), 0.17, 0.12); arm(1, 0.04 * Math.sin(t * 0.7 + 1), 0.17, 0.12);
  }
  if (armUp > 0) {
    // aim the right arm at the kite (direction in the child's frame), mostly upward
    const d = aim ? aim.clone() : new THREE.Vector3(0.25, 1, 0.15);
    d.normalize();
    const u = new THREE.Vector3().copy(UP).lerp(d, 0.6);
    if (u.y < 0.45) u.y = 0.45;
    u.normalize();
    const abd = Math.asin(clamp(u.z, -0.25, 0.9));
    const torsoZ = P[0][2] + P[1][2];
    const swing = Math.atan2(u.x, -u.y) - torsoZ;
    const a = Math.min(1, armUp);
    P[5][2] = lerp(P[5][2], swing, a); P[5][0] = lerp(P[5][0], -abd, a); P[5][1] = lerp(P[5][1], 0, a);
    P[6][2] = lerp(P[6][2], 0.15, a);
    P[2][2] += 0.3 * a;
  }
  return { P, off, speed };
}

const _e = new THREE.Euler(), _v = new THREE.Vector3(), LOC = Array.from({ length: NB }, () => new THREE.Matrix4());
function computeBones(P, off, out) {
  for (let i = 0; i < NB; i++) {
    const p = PIV[i], r = P[i];
    _e.set(r[0], r[1], r[2], 'ZXY');
    const L = LOC[i].makeRotationFromEuler(_e);
    _v.set(p[0], p[1], p[2]).applyMatrix4(L);
    const o = i === 0 ? off : [0, 0, 0];
    L.setPosition(p[0] + o[0] - _v.x, p[1] + o[1] - _v.y, p[2] + o[2] - _v.z);
    if (PAR[i] < 0) out[i].copy(L); else out[i].multiplyMatrices(out[PAR[i]], L);
  }
}

// ---------------------------------------------------------------- kite geometry (local: spine +Y, right +X, front +Z)
const KITE = { top: 0.31, bottom: -0.64, half: 0.36 };
const BRIDLE_KNOT = new THREE.Vector3(0, -0.07, 0.26), BRIDLE_A = new THREE.Vector3(0, 0.2, 0), BRIDLE_B = new THREE.Vector3(0, -0.42, 0);
const TAIL_ROOT = new THREE.Vector3(0, KITE.bottom, 0);
function buildKiteGeometry() {
  const P = [], UV = [], K = [], E = [], I = [];
  const n = 14, T = [0, KITE.top], R = [KITE.half, 0], B = [0, KITE.bottom], L = [-KITE.half, 0];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const a = i / n, b = j / n;
    const x = lerp(lerp(T[0], R[0], a), lerp(L[0], B[0], a), b);
    const y = lerp(lerp(T[1], R[1], a), lerp(L[1], B[1], a), b);
    const ax = Math.abs(x);
    const dT = (1 - ax / 0.36 - y / 0.31) / 4.257, dB = (1 - ax / 0.36 + y / 0.64) / 3.187;
    const ed = Math.max(0, Math.min(dT, dB));
    const inner = Math.min(1, ed / 0.09) * Math.min(1, ax / 0.1) * Math.min(1, Math.abs(y) / 0.1);
    P.push(x, y, -0.085 * (x / 0.36) ** 2 - 0.02 * inner); UV.push(x, y); K.push(0); E.push(inner);
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    I.push(a, b, d, a, d, c);
  }
  const tubes = [
    new THREE.TubeGeometry(new THREE.LineCurve3(new THREE.Vector3(0, KITE.top, -0.032), new THREE.Vector3(0, KITE.bottom, -0.032)), 2, 0.006, 5),
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(Array.from({ length: 9 }, (_, i) => {
      const x = -0.36 + (0.72 * i) / 8; return new THREE.Vector3(x, 0, -0.085 * (x / 0.36) ** 2 - 0.032);
    })), 12, 0.006, 5),
  ];
  for (const tg of tubes) {
    const base = P.length / 3, p = tg.attributes.position;
    for (let i = 0; i < p.count; i++) { P.push(p.getX(i), p.getY(i), p.getZ(i)); UV.push(0, 0); K.push(1); E.push(0); }
    for (let i = 0; i < tg.index.count; i++) I.push(base + tg.index.getX(i));
    tg.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('aUV', new THREE.Float32BufferAttribute(UV, 2));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(K, 1));
  g.setAttribute('aEdge', new THREE.Float32BufferAttribute(E, 1));
  g.setIndex(I);
  g.computeVertexNormals();
  return g;
}

// ribbon strip helper: attribute aSV = (s 0..1, v -1|1, k)
function ribbonGeometry(strips) {
  const SV = [], I = [];
  for (const { segs, k } of strips) {
    const base = SV.length / 3;
    for (let i = 0; i <= segs; i++) SV.push(i / segs, -1, k, i / segs, 1, k);
    for (let i = 0; i < segs; i++) { const a = base + i * 2; I.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(SV.length), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(SV.length), 3));
  g.setAttribute('aSV', new THREE.Float32BufferAttribute(SV, 3));
  g.setIndex(I);
  return g;
}

function instGeometry(verts, extra = {}) {
  // verts: flat xyz list (non-indexed triangles or quads via index in extra.index)
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(verts.length), 3));
  for (const [k, v] of Object.entries(extra.attrs || {})) g.setAttribute(k, new THREE.Float32BufferAttribute(v.data, v.size));
  if (extra.index) g.setIndex(extra.index);
  g.instanceCount = 0;
  return g;
}
const instAttr = (g, name, size, n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(n * size), size); g.setAttribute(name, a); return a; };

const parseColor = (c, fallback) => {
  if (c == null) return fallback.clone();
  if (typeof c === 'number') return hex(c);
  if (Array.isArray(c)) return new THREE.Vector3(c[0], c[1], c[2]);
  if (c.isVector3) return c.clone();
  if (c.isColor) return new THREE.Vector3(c.r, c.g, c.b);
  return fallback.clone();
};

// =====================================================================================================
export default async function create(world) {
  const { pipeline } = world;
  const density = world.quality?.density ?? 1;
  const group = new THREE.Group();
  group.name = 'actors';

  // ------------------------------------------------------------------ child
  const boneMats = Array.from({ length: NB }, () => new THREE.Matrix4());
  const runVel = new THREE.Vector3();
  const bodyMat = paintMaterial({
    name: 'actor-child', side: THREE.DoubleSide,
    uniforms: { uBones: { value: boneMats }, uRunVel: { value: runVel } },
    vertexPars: `attribute vec3 color; attribute float aBone; attribute float aFlex; attribute float aKeep;
      uniform mat4 uBones[${NB}]; uniform vec3 uRunVel; varying vec3 vCol; varying float vKeep;`,
    vertexMain: `
      mat4 cB = uBones[int(aBone + .5)];
      float cAng = atan(position.z, position.x + 1e-5);
      pos = (cB * vec4(pos, 1.)).xyz; nrm = mat3(cB) * nrm;
      vCol = color; vKeep = aKeep;`,
    vertexWorld: `
      if (aFlex > 0.){
        float cg = gustAt(wp.xz);
        float cph = uTime * (5. + 3. * cg) + cAng * 3.;
        vec3 cTrail = vec3(uWind.x, 0., uWind.y) * (.012 + .03 * cg) * uWind.z - uRunVel * .011;
        wp.xyz += (cTrail * (1. + .6 * sin(cph)) + vec3(0., .005 * sin(cph * 1.3), 0.)) * aFlex;
      }`,
    fragmentPars: `varying vec3 vCol; varying float vKeep; ${ACTOR_SHADE}`,
    fragmentMain: `
      vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
      paintOut(applyHaze(actorShade(vCol, N, vKeep, .1), vW), 1., .35);`,
  });
  const body = new THREE.Mesh(buildChildGeometry(), bodyMat);
  body.matrixAutoUpdate = false;
  register(pipeline, body, { cast: true, reflect: true });
  group.add(body);

  // scarf tails (world space ribbons, travelling wave)
  const scarfU = {
    uKnot: { value: new THREE.Vector3() }, uSDir: { value: new THREE.Vector3(1, 0, 0) }, uSSide: { value: new THREE.Vector3(0, 0, 1) },
    uSLen: { value: new THREE.Vector2(0.82, 0.62) }, uSFlow: { value: 1 }, uSVis: { value: 0 },
  };
  const scarfMat = paintMaterial({
    name: 'actor-scarf', side: THREE.DoubleSide, uniforms: scarfU,
    vertexPars: `attribute vec3 aSV; uniform vec3 uKnot, uSDir, uSSide; uniform vec2 uSLen; uniform float uSFlow, uSVis; varying float vS;
      vec3 scarfAt(float s, float v, float k){
        float L = mix(uSLen.x, uSLen.y, k);
        float g = gustAt(uKnot.xz);
        float flow = uSFlow + g;
        vec3 d = uSDir, sd = uSSide, nd = normalize(cross(sd, d));
        float x = s * L, ph = k * 2.3;
        float w = x * (8. + 2. * k) - uTime * (5. + 4. * flow) + ph;
        float amp = (.012 + .1 * s * s) * (.5 + .5 * min(flow, 1.6));
        vec3 p = uKnot + sd * ((k - .5) * .04) + d * x - vec3(0., .05, 0.) * (1. - exp(-x * 12.));
        p += sd * amp * sin(w) + nd * amp * .45 * sin(w * .8 + 1.1 + ph);
        float tw = (.3 + .6 * s) * sin(w * .6 + .7 + ph);
        p += (nd * cos(tw) + sd * sin(tw)) * v * .048 * (1. - .2 * s);
        return p;
      }`,
    vertexMain: `
      vec3 sP = scarfAt(aSV.x, aSV.y, aSV.z);
      vec3 sA = scarfAt(aSV.x + .02, aSV.y, aSV.z) - sP, sB = scarfAt(aSV.x, aSV.y + .25, aSV.z) - sP;
      nrm = normalize(cross(sA, sB));
      pos = uSVis > .5 ? sP : uKnot;
      vS = aSV.x;`,
    fragmentPars: `varying float vS; ${ACTOR_SHADE}`,
    fragmentMain: `
      vec3 N = normalize(vN); if (dot(N, cameraPosition - vW) < 0.) N = -N;
      vec3 base = ${glv(COL.scarf)} * (1. - .07 * vS);
      base = mix(base, ${glv(COL.cream)}, step(.84, vS) * step(vS, .89));
      paintOut(applyHaze(actorShade(base, N, 1. - step(.84, vS) * step(vS, .89), .05), vW), 1., .35);`,
  });
  const scarf = new THREE.Mesh(ribbonGeometry([{ segs: 14, k: 0 }, { segs: 14, k: 1 }]), scarfMat);
  scarf.frustumCulled = false;
  register(pipeline, scarf, { cast: true, reflect: true });
  group.add(scarf);

  // ------------------------------------------------------------------ kite
  const kiteU = { uKFlut: { value: 0 } };
  const kiteMat = paintMaterial({
    name: 'actor-kite', side: THREE.DoubleSide, uniforms: kiteU,
    vertexPars: `attribute vec2 aUV; attribute float aKind; attribute float aEdge; uniform float uKFlut; varying vec2 vUV; varying float vKind;`,
    vertexMain: `
      vUV = aUV; vKind = aKind;
      pos.z -= aEdge * .012 * (.5 + .5 * sin(uTime * (9. + 6. * uKFlut) + aUV.y * 9. + aUV.x * 4.)) * (.5 + uKFlut);`,
    fragmentPars: `varying vec2 vUV; varying float vKind;`,
    fragmentMain: `
      vec3 N = normalize(vN); if (dot(N, cameraPosition - vW) < 0.) N = -N;
      vec2 q = vUV;
      vec3 base = ${glv(COL.spar)};
      float spar = 0., sail = 1. - step(.5, vKind);
      if (sail > .5){
        float aa = length(fwidth(q)) * .8 + 1e-4;
        float ax = abs(q.x), ay = abs(q.y);
        float crs = max(1. - smoothstep(.024 - aa, .024 + aa, ax), 1. - smoothstep(.024 - aa, .024 + aa, ay));
        float dia = 1. - smoothstep(.125 - aa, .125 + aa, ax + ay);
        float dT = (1. - ax / .36 - q.y / .31) / 4.257, dB = (1. - ax / .36 + q.y / .64) / 3.187;
        float hem = 1. - smoothstep(.02 - aa, .02 + aa, min(dT, dB));
        base = mix(${glv(COL.scarf)}, ${glv(COL.cream)}, max(crs, dia));
        base = mix(base, ${glv(COL.hem)}, hem);
        spar = 1. - smoothstep(.004, .006 + aa, min(ax, ay));
      }
      float ndl = dot(N, uSunDir);
      float sh = getShadow(vW + uSunDir * .08, vec2(0.));
      float lit = paintBand(ndl, .02, .06) * sh;
      vec3 col = paintLight(base, lit, paintBand(ndl, .75, .06) * .3 * sh);
      // sun shining through the sail: glowing cloth, the sticks silhouetted
      float back = paintBand(-ndl, .02, .1) * uSunAmt * sh * sail;
      vec3 glow = (base * uSunTint * .97 + vec3(.04, .03, 0.)) * (1. - spar * .22);
      col = mix(col, glow, back * .8);
      col = max(col, base * .52 * sail);
      paintOut(applyHaze(col, vW), 1., .35);`,
  });
  const kiteMesh = new THREE.Mesh(buildKiteGeometry(), kiteMat);
  kiteMesh.matrixAutoUpdate = false;
  kiteMesh.frustumCulled = false;
  register(pipeline, kiteMesh, { cast: true, reflect: true });
  group.add(kiteMesh);

  // kite tail: camera-facing ribbon with five bows, snaking downwind
  const tailU = {
    uTRoot: { value: new THREE.Vector3() }, uTDir: { value: new THREE.Vector3(1, 0, 0) }, uTSide: { value: new THREE.Vector3(0, 0, 1) },
    uTLen: { value: 3.5 }, uTGust: { value: 0 }, uTVis: { value: 0 },
  };
  const tailMat = paintMaterial({
    name: 'actor-kitetail', side: THREE.DoubleSide, uniforms: tailU,
    vertexPars: `attribute vec4 aT; uniform vec3 uTRoot, uTDir, uTSide; uniform float uTLen, uTGust, uTVis; varying float vKind;
      vec3 tailAt(float s){
        float x = s * uTLen, g = uTGust;
        float w = x * 1.9 - uTime * (5.5 + 3.5 * g);
        float amp = (.02 + .26 * s) * (.75 + .6 * g);
        vec3 up2 = normalize(cross(uTSide, uTDir));
        vec3 p = uTRoot + uTDir * x - vec3(0., .1 * x * s, 0.);
        return p + uTSide * amp * sin(w) + up2 * amp * .45 * sin(w * .7 + 1.7);
      }`,
    vertexMain: `
      float tS = aT.x;
      vec3 tP = tailAt(tS);
      vec3 tG = normalize(tailAt(tS + .01) - tP);
      vec3 tV = normalize(cameraPosition - tP);
      vec3 tSd = normalize(cross(tG, tV));
      float tPx = distance(cameraPosition, tP) * uPxAngle;
      if (aT.z < .5) tP += tSd * aT.y * max(.016, 1.3 * tPx);
      else tP += (tSd * aT.y * .095 + tG * aT.w * .055) * max(1., 5. * tPx / .095);
      nrm = cross(tSd, tG);
      pos = uTVis > .5 ? tP : uTRoot;
      vKind = aT.z;`,
    fragmentPars: `varying float vKind;`,
    fragmentMain: `
      vec3 base = vKind > .5 ? ${glv(COL.cream)} : ${glv(COL.scarf)};
      vec3 col = paintLight(base, .85, 0.);
      col = max(col, base * .52 * (1. - vKind));
      paintOut(applyHaze(col, vW), 1., .3);`,
  });
  {
    // ribbon (40 segs) + 5 bows (2 triangles each)
    const T = [], I = [];
    const segs = 40;
    for (let i = 0; i <= segs; i++) T.push(i / segs, -1, 0, 0, i / segs, 1, 0, 0);
    for (let i = 0; i < segs; i++) { const a = i * 2; I.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    for (let b = 0; b < 5; b++) {
      const sb = 0.2 + b * 0.16, base = T.length / 4;
      T.push(sb, 0, 1, 0, sb, -1, 1, -1, sb, -1, 1, 1, sb, 1, 1, 1, sb, 1, 1, -1);
      I.push(base, base + 1, base + 2, base, base + 3, base + 4);
    }
    var tailGeo = new THREE.BufferGeometry();
    tailGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((T.length / 4) * 3), 3));
    tailGeo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array((T.length / 4) * 3), 3));
    tailGeo.setAttribute('aT', new THREE.Float32BufferAttribute(T, 4));
    tailGeo.setIndex(I);
  }
  const tail = new THREE.Mesh(tailGeo, tailMat);
  tail.frustumCulled = false;
  register(pipeline, tail, { cast: false, reflect: true });
  group.add(tail);

  // string + two bridle legs: camera-facing, at least ~1.7 px wide, pale cream, slightly translucent
  const strU = {
    uLA: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
    uLB: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
    uLSag: { value: new THREE.Vector3() }, uLVis: { value: 0 },
  };
  const strMat = paintMaterial({
    name: 'actor-string', side: THREE.DoubleSide, blend: 'over', depthWrite: false, uniforms: strU,
    vertexPars: `attribute vec3 aSV; uniform vec3 uLA[3]; uniform vec3 uLB[3]; uniform vec3 uLSag; uniform float uLVis;
      vec3 lineAt(int i, float s){
        float sag = i == 0 ? uLSag.x : (i == 1 ? uLSag.y : uLSag.z);
        return mix(uLA[i], uLB[i], s) - vec3(0., 4. * sag * s * (1. - s), 0.);
      }`,
    vertexMain: `
      int li = int(aSV.z + .5);
      vec3 lP = lineAt(li, aSV.x);
      vec3 lT = lineAt(li, aSV.x + .01) - lineAt(li, aSV.x - .01);
      vec3 lSd = normalize(cross(lT, cameraPosition - lP));
      float lPx = distance(cameraPosition, lP) * uPxAngle;
      pos = lP + lSd * aSV.y * .5 * max(.004, 1.8 * lPx);
      if (uLVis < .5) pos = uLA[0];
      nrm = normalize(cameraPosition - lP);`,
    fragmentMain: `
      vec3 base = ${glv(COL.string)};
      vec3 col = mix(base, paintLight(base, 1., 0.), .6);
      paintOutBlend(applyHaze(col, vW), .82, .05);`,
  });
  const str = new THREE.Mesh(ribbonGeometry([{ segs: 48, k: 0 }, { segs: 2, k: 1 }, { segs: 2, k: 2 }]), strMat);
  str.frustumCulled = false;
  register(pipeline, str, { cast: false, reflect: true });
  group.add(str);

  // ------------------------------------------------------------------ birds
  const MAXB = 128;
  const birdGeo = (() => {
    const V = [], PS = [];
    const tri = (a, b, c, part, side) => { V.push(...a, ...b, ...c); for (let i = 0; i < 3; i++) PS.push(part, side); };
    const N = [0.16, 0.012, 0], Tl = [-0.13, 0.006, 0], Up = [0, 0.036, 0], Dn = [0.01, -0.03, 0], Lf = [0, 0, -0.04], Rt = [0, 0, 0.04];
    [[N, Up, Rt], [N, Rt, Dn], [N, Dn, Lf], [N, Lf, Up], [Tl, Rt, Up], [Tl, Dn, Rt], [Tl, Lf, Dn], [Tl, Up, Lf]].forEach((t) => tri(...t, 0, 0));
    tri([-0.1, 0.006, 0], [-0.21, 0.004, -0.045], [-0.21, 0.004, 0.045], 3, 0);
    for (const sd of [-1, 1]) {
      const rf = [0.07, 0, 0.02], rb = [-0.055, 0, 0.02], mf = [0.06, 0, 0.24], mb = [-0.035, 0, 0.24], tp = [-0.04, 0, 0.45];
      tri(rf, rb, mb, 1, sd); tri(rf, mb, mf, 1, sd); tri(mf, mb, tp, 2, sd);
    }
    return instGeometry(V, { attrs: { aPS: { data: PS, size: 2 } } });
  })();
  const bA = instAttr(birdGeo, 'aA', 4, MAXB), bB = instAttr(birdGeo, 'aB', 4, MAXB), bC = instAttr(birdGeo, 'aC', 4, MAXB), bO = instAttr(birdGeo, 'aO', 4, MAXB);
  const birdMat = paintMaterial({
    name: 'actor-birds', side: THREE.DoubleSide,
    vertexPars: `attribute vec4 aA; attribute vec4 aB; attribute vec4 aC; attribute vec4 aO; attribute vec2 aPS;
      varying float vSpan; varying float vWing;
      // aA: t0, heading, vmax, climb · aB: burst height, curve, weave amp, weave freq · aC: f0, f1, phase, glide · aO: origin, size
      vec3 birdPath(float a){
        float dist = aA.z * (a - .85 * (1. - exp(-a / .85)));
        vec2 hd = vec2(cos(aA.y), sin(aA.y)), pd = vec2(-hd.y, hd.x);
        float lat = aB.y * dist * dist + aB.z * sin(a * aB.w + aC.z * 6.2832) * smoothstep(0., 3., a);
        vec2 xz = aO.xz + hd * dist + pd * lat;
        float y = aO.y + aB.x * (1. - exp(-a / .55)) + aA.w * a + .5 * sin(a * .7 + aC.w * 6.2832) * smoothstep(1., 4., a);
        return vec3(xz.x, y, xz.y);
      }`,
    vertexMain: `
      float age = uTime - aA.x;
      float alive = step(0., age) * smoothstep(13.5, 11., age);
      float ag = max(age, 0.);
      vec3 bP = birdPath(ag);
      vec3 bV = birdPath(ag + .05) - bP;
      vec3 fw = normalize(bV * vec3(1., .55, 1.) + vec3(cos(aA.y), 0., sin(aA.y)) * .04);
      vec3 rt = normalize(cross(fw, vec3(0., 1., 0.)));
      vec3 up = cross(rt, fw);
      float roll = clamp(-aB.z * aB.w * aB.w * sin(ag * aB.w + aC.z * 6.2832) * .25 * smoothstep(0., 3., ag), -.6, .6);
      vec3 up2 = up * cos(roll) + rt * sin(roll);
      vec3 rt2 = cross(fw, up2);
      float tf = 1.3;
      float ph = 6.2832 * (aC.y * ag + (aC.x - aC.y) * tf * (1. - exp(-ag / tf))) + aC.z * 6.2832;
      float glide = smoothstep(.2, .7, sin(ag * .75 + aC.w * 6.2832)) * smoothstep(2., 4., ag);
      float amp = mix(1.05, .8, smoothstep(0., 3., ag)) * (1. - .85 * glide);
      float th1 = amp * sin(ph) + .1 + .08 * glide;
      float th2 = amp * 1.25 * sin(ph - .6) + .14 + .05 * glide;
      vec3 lp = position, ln = normalize(position * vec3(.06, 1., .8) + vec3(0., 1e-4, 0.));
      float part = aPS.x, sd = aPS.y;
      vSpan = 0.; vWing = 0.;
      if (part > .5 && part < 2.5){
        float sp = position.z, h = .24;
        if (part < 1.5){ lp = vec3(position.x, sin(th1) * sp, cos(th1) * sp * sd); ln = vec3(0., cos(th1), -sin(th1) * sd); }
        else { lp = vec3(position.x, sin(th1) * h + sin(th2) * (sp - h), (cos(th1) * h + cos(th2) * (sp - h)) * sd); ln = vec3(0., cos(th2), -sin(th2) * sd); }
        vSpan = sp; vWing = 1.;
      } else if (part > 2.5){ ln = vec3(0., 1., 0.); vWing = 1.; }
      float bs = aO.w * alive;
      pos = bP + (fw * lp.x + up2 * lp.y + rt2 * lp.z) * bs;
      nrm = fw * ln.x + up2 * ln.y + rt2 * ln.z;`,
    fragmentPars: `varying float vSpan; varying float vWing;`,
    fragmentMain: `
      vec3 N = normalize(vN);
      if (vWing > .5 && dot(N, cameraPosition - vW) < 0.) N = -N;
      vec3 base = mix(${glv(COL.bird)}, ${glv(COL.birdTip)}, smoothstep(.31, .37, vSpan));
      float ndl = dot(N, uSunDir);
      float sh = getShadow(vW + N * .05, vec2(0.));
      float lit = paintBand(ndl, 0., .07) * sh;
      vec3 col = paintLight(base, lit, 0.);
      col = mix(col, base * uSunTint * .92, paintBand(-ndl, .1, .1) * .35 * uSunAmt * vWing * sh);
      paintOut(applyHaze(col, vW), 1., .3);`,
  });
  const birds = new THREE.Mesh(birdGeo, birdMat);
  birds.frustumCulled = false;
  register(pipeline, birds, { cast: true, reflect: true });
  group.add(birds);

  // ------------------------------------------------------------------ butterflies
  const MAXF = 64;
  const bflyGeo = (() => {
    const V = [], PS = [];
    const tri = (a, b, c, part, side) => { V.push(...a, ...b, ...c); for (let i = 0; i < 3; i++) PS.push(part, side); };
    tri([0.018, 0, 0], [-0.022, 0.004, 0], [-0.022, -0.004, 0], 0, 0);
    for (const sd of [-1, 1]) {
      tri([0.01, 0, 0.004], [0.036, 0, 0.06], [-0.006, 0, 0.052], 1, sd);
      tri([0.002, 0, 0.004], [-0.008, 0, 0.05], [-0.038, 0, 0.032], 1, sd);
    }
    return instGeometry(V, { attrs: { aPS: { data: PS, size: 2 } } });
  })();
  const fSpot = instAttr(bflyGeo, 'aSpot', 4, MAXF), fR = instAttr(bflyGeo, 'aR', 4, MAXF);
  const bflyMat = paintMaterial({
    name: 'actor-butterflies', side: THREE.DoubleSide,
    vertexPars: `attribute vec4 aSpot; attribute vec4 aR; attribute vec2 aPS; varying vec2 vLoc; varying float vPart; varying float vYel;
      vec3 bfPath(float T){
        vec4 r = aR * 6.2832;
        vec3 o = vec3(
          .62 * sin(T * .53 + r.x) + .3 * sin(T * 1.37 + r.y) + .1 * sin(T * 3.9 + r.z),
          .22 * sin(T * .91 + r.w) + .1 * sin(T * 2.3 + r.x) + .05 * sin(T * 5.1 + r.y),
          .62 * sin(T * .47 + r.z) + .3 * sin(T * 1.21 + r.w) + .1 * sin(T * 4.3 + r.x));
        return aSpot.xyz + o * aSpot.w;
      }`,
    vertexMain: `
      float T = uTime + aR.x * 37.;
      vec3 fP = bfPath(T);
      vec3 fV = bfPath(T + .05) - fP;
      vec3 fw = normalize(vec3(fV.x, 0., fV.z) + vec3(1e-4, 0., 0.));
      fw = normalize(fw + vec3(0., .3, 0.));
      vec3 rt = normalize(cross(fw, vec3(0., 1., 0.)));
      vec3 up = cross(rt, fw);
      float ph = T * (50. + 15. * aR.y);
      float th = .22 + 1.18 * (.5 + .5 * sin(ph));
      fP.y += .025 * cos(ph);
      vec3 lp = position, ln = vec3(0., 0., 1.);
      if (aPS.x > .5){ lp = vec3(position.x, sin(th) * position.z, cos(th) * position.z * aPS.y); ln = vec3(0., cos(th), -sin(th) * aPS.y); }
      pos = fP + (fw * lp.x + up * lp.y + rt * lp.z) * 1.25;
      nrm = fw * ln.x + up * ln.y + rt * ln.z;
      vLoc = position.xz; vPart = aPS.x; vYel = step(.55, aR.w);`,
    fragmentPars: `varying vec2 vLoc; varying float vPart; varying float vYel;`,
    fragmentMain: `
      vec3 N = normalize(vN); if (dot(N, cameraPosition - vW) < 0.) N = -N;
      vec3 base = mix(${glv(COL.bWhite)}, ${glv(COL.bYellow)}, vYel);
      base = mix(base, vec3(.42, .42, .45), smoothstep(.046, .054, vLoc.y) * smoothstep(.008, .02, vLoc.x) * (1. - vYel) * .8);
      base = mix(${glv(COL.bBody)}, base, step(.5, vPart));
      float ndl = dot(N, uSunDir);
      float sh = getShadow(vW + N * .03, vec2(0.));
      vec3 col = paintLight(base, paintBand(ndl, -.1, .1) * sh, 0.);
      col = mix(col, base * uSunTint, paintBand(-ndl, .1, .1) * .3 * uSunAmt * sh);
      paintOut(applyHaze(col, vW), 1., .3);`,
  });
  const bflies = new THREE.Mesh(bflyGeo, bflyMat);
  bflies.frustumCulled = false;
  register(pipeline, bflies, { cast: false, reflect: true });
  group.add(bflies);

  // ------------------------------------------------------------------ petals / seed fluff around the camera
  const NP = Math.max(300, Math.round(3200 * density));
  const quadIdx = [0, 1, 2, 0, 2, 3];
  const quadV = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
  const petalGeo = instGeometry(quadV, { index: quadIdx });
  {
    const aR = instAttr(petalGeo, 'aR', 4, NP), aQ = instAttr(petalGeo, 'aQ', 4, NP);
    const rng = makeRng(9127);
    for (let i = 0; i < NP; i++) {
      aR.setXYZW(i, rng(), rng(), rng(), (i + rng()) / NP);
      aQ.setXYZW(i, rng(), rng(), rng(), rng());
    }
    petalGeo.instanceCount = NP;
  }
  const petalU = { uAmount: { value: 0 }, uPetalCol: { value: COL.petal.clone() } };
  const petalMat = paintMaterial({
    name: 'actor-petals', side: THREE.DoubleSide, blend: 'over', depthWrite: false, uniforms: petalU,
    vertexPars: `attribute vec4 aR; attribute vec4 aQ; uniform float uAmount;
      varying vec2 vUv; varying float vA; varying float vKind; varying float vSoft; varying float vTint; varying vec3 vPN;
      vec3 rotAx(vec3 v, vec3 k, float a){ return v * cos(a) + cross(k, v) * sin(a) + k * dot(k, v) * (1. - cos(a)); }`,
    vertexMain: `
      float pVis = step(aR.w, uAmount);
      float kind = step(.68, aQ.w);
      vec3 Bx = vec3(30., 12., 30.);
      vec3 wd = vec3(uWind.x, 0., uWind.y);
      float spd = (2. + 2. * aQ.x) * (.6 + .4 * uWind.z);
      float T = uTime;
      vec3 drift = wd * spd * T + vec3(0., (kind > .5 ? .1 : -.32) * T, 0.)
        + vec3(.5 * sin(T * .9 + aQ.y * 6.28), .35 * sin(T * 1.3 + aQ.z * 6.28), .5 * sin(T * .7 + aQ.w * 6.28));
      vec3 ctr = uCamPos + vec3(0., 2., 0.);
      vec3 f = fract((aR.xyz * Bx + drift - ctr) / Bx + .5);
      vec3 P = ctr + (f - .5) * Bx;
      vec3 e = abs(f - .5) * 2.;
      vA = 1. - smoothstep(.82, 1., max(max(e.x, e.z), e.y));
      float d = distance(P, uCamPos);
      vSoft = clamp((1.6 - d) / 1.3, 0., 1.);
      vec3 U1, V1;
      if (kind > .5){
        U1 = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        V1 = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      } else {
        vec3 ax = normalize(vec3(aQ.y - .5, aQ.z - .2, aQ.w - .5) + vec3(0., 0., 1e-3));
        float ang = T * (2. + 3. * aQ.z) + aQ.y * 6.28;
        U1 = rotAx(vec3(1., 0., 0.), ax, ang); V1 = rotAx(vec3(0., 0., 1.), ax, ang);
      }
      vec2 hs = kind > .5 ? vec2(.032) : vec2(.045, .027) * (.8 + .4 * aQ.x);
      pos = P + (U1 * position.x * hs.x + V1 * position.y * hs.y) * (1. + vSoft * .6) * pVis;
      nrm = normalize(cross(U1, V1));
      vPN = nrm; vUv = position.xy; vKind = kind; vTint = aQ.z;`,
    fragmentPars: `uniform vec3 uPetalCol; varying vec2 vUv; varying float vA; varying float vKind; varying float vSoft; varying float vTint; varying vec3 vPN;`,
    fragmentMain: `
      vec2 uv = vUv;
      float a;
      if (vKind < .5){
        float r = length(vec2(uv.x, uv.y * (1. + .3 * uv.x)));
        float aa = fwidth(r) * 1.2 + vSoft * .85;
        a = 1. - smoothstep(1. - aa, 1., r);
      } else {
        float r = length(uv);
        float aa = fwidth(r) * 1.2 + vSoft * .5;
        a = (1. - smoothstep(.32 - aa * .5, .42 + aa * .5, r)) * .95 + (1. - smoothstep(.3, 1., r)) * .3;
      }
      a = clamp(a, 0., 1.) * vA * (1. - .62 * vSoft);
      if (a < .01) discard;
      vec3 base = vKind > .5 ? ${glv(COL.fluff)} : mix(uPetalCol, vec3(1.), vTint * .35);
      float lit = .62 + .38 * abs(dot(normalize(vPN), uSunDir));
      vec3 col = mix(base, paintLight(base, lit, 0.), .75);
      paintOutBlend(applyHaze(col, vW), a, .3);`,
  });
  const petals = new THREE.Mesh(petalGeo, petalMat);
  petals.frustumCulled = false;
  petals.renderOrder = 2;
  group.add(petals);

  // ------------------------------------------------------------------ fireflies
  const MAXY = 160;
  const flyGeo = instGeometry(quadV, { index: quadIdx });
  const yZone = instAttr(flyGeo, 'aZone', 4, MAXY), yR = instAttr(flyGeo, 'aR', 4, MAXY);
  const flyU = { uFire: { value: 0 } };
  const flyMat = paintMaterial({
    name: 'actor-fireflies', side: THREE.DoubleSide, blend: 'add', uniforms: flyU,
    vertexPars: `attribute vec4 aZone; attribute vec4 aR; uniform float uFire; varying vec2 vUv; varying float vB; varying float vCore;`,
    vertexMain: `
      float T = uTime;
      vec3 c = aZone.xyz; float R = aZone.w;
      float rise = fract(aR.x + T * (.025 + .02 * aR.y));
      vec3 P = c + vec3(
        R * (.7 * sin(T * (.23 + .2 * aR.z) + aR.w * 6.28) + .3 * sin(T * .71 + aR.y * 9.)),
        (rise - .4) * min(R, 1.5) * 1.6 + .15 * sin(T * 1.3 + aR.z * 7.),
        R * (.7 * sin(T * (.19 + .2 * aR.w) + aR.z * 6.28) + .3 * sin(T * .83 + aR.x * 9.)));
      float blink = .2 + .8 * smoothstep(.15, .85, .5 + .5 * sin(T * (1.3 + 1.6 * aR.y) + aR.z * 40.));
      vB = blink * sin(3.14159 * rise) * uFire;
      float px = distance(P, cameraPosition) * uPxAngle;
      float coreR = max(.06, 1.7 * px), haloR = max(.25, 7. * px);
      vec3 cR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
      vec3 cU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      pos = P + (cR * position.x + cU * position.y) * haloR * step(.002, vB);
      nrm = normalize(cameraPosition - P);
      vUv = position.xy; vCore = coreR / haloR;`,
    fragmentPars: `varying vec2 vUv; varying float vB; varying float vCore;`,
    fragmentMain: `
      float r = length(vUv);
      float core = 1. - smoothstep(vCore * .55, vCore, r);
      float halo = exp(-r * r * 5.) * (1. - smoothstep(.7, 1., r));
      paintOutAdd((vec3(1., .96, .74) * core * 1.25 + vec3(1., .7, .26) * halo * .45) * vB);`,
  });
  const flies = new THREE.Mesh(flyGeo, flyMat);
  flies.frustumCulled = false;
  flies.renderOrder = 3;
  register(pipeline, flies, { cast: false, reflect: true });
  group.add(flies);

  // ================================================================== state
  const mkState = () => ({
    child: { x: 0, y: null, z: 0, heading: 0, pose: 'stand', armUp: 0, visible: false },
    kite: { mode: null, pos: [0, 0, 0], height: 7, back: 9, side: 0, visible: false, string: true },
    launches: [], lver: 0, spots: [], sver: 0,
    petals: { amount: 0, color: COL.petal.clone() },
    zones: [], zver: 0, fireAmount: 1,
  });
  const EXT = mkState(), DEMO = mkState();
  let external = false, demoMode = 'auto', lastT = 0, lastState = undefined;

  const ops = {
    setChild(S, o = {}) {
      const c = S.child;
      if (o.x !== undefined || o.z !== undefined || 'y' in o) c.y = o.y ?? null;
      if (o.x !== undefined) c.x = o.x;
      if (o.z !== undefined) c.z = o.z;
      if (o.heading !== undefined) c.heading = o.heading;
      if (o.pose !== undefined) c.pose = ['stand', 'walk', 'run', 'sit'].includes(o.pose) ? o.pose : 'stand';
      if (o.armUp !== undefined) c.armUp = clamp(o.armUp, 0, 1);
      c.visible = o.visible ?? true;
    },
    kiteSet(S, o = {}) {
      const k = S.kite;
      k.mode = 'set';
      if (o.pos) k.pos = [o.pos[0], o.pos[1], o.pos[2]];
      k.visible = o.visible ?? true;
      if (o.string !== undefined) k.string = !!o.string;
    },
    kiteFly(S, o = {}) {
      const k = S.kite;
      k.mode = 'fly';
      if (o.height !== undefined) k.height = o.height;
      if (o.back !== undefined) k.back = o.back;
      if (o.side !== undefined) k.side = o.side;
      k.visible = o.visible ?? true;
      if (o.string !== undefined) k.string = !!o.string;
    },
    launch(S, o = {}) {
      const L = {
        origin: [...(o.origin || [0, 1, 0])], t0: o.t0 ?? 0, count: Math.max(0, Math.round(o.count ?? 12)),
        dir: o.dir ? [o.dir[0], o.dir[1]] : null, spread: o.spread ?? 0.9,
      };
      const key = JSON.stringify(L);
      if (S.launches.some((x) => x.key === key)) return;
      L.key = key;
      S.launches.push(L); S.lver++;
    },
    clearBirds(S) { if (S.launches.length) { S.launches = []; S.lver++; } },
    setSpots(S, spots = []) { const s = JSON.stringify(spots); if (s !== S.spotKey) { S.spotKey = s; S.spots = spots.map((a) => [...a]); S.sver++; } },
    setZones(S, zones = []) { const s = JSON.stringify(zones); if (s !== S.zoneKey) { S.zoneKey = s; S.zones = zones.map((a) => [...a]); S.zver++; } },
    petals(S, o = {}) { if (o.amount !== undefined) S.petals.amount = clamp(o.amount, 0, 1); if (o.color !== undefined) S.petals.color = parseColor(o.color, COL.petal); },
  };
  // the look-dev demo
  ops.setChild(DEMO, { x: 40, z: 8, y: JETTY.y, heading: Math.PI, pose: 'run', armUp: 1 });
  ops.kiteFly(DEMO, { height: 7, back: 9, side: 1.5 });
  ops.launch(DEMO, { origin: [10, 1, 0], t0: 1, count: 14 });
  ops.setSpots(DEMO, [[45, 1.5, 14, 6]]);
  ops.petals(DEMO, { amount: 0.6 });
  ops.setZones(DEMO, [[40, 1, 14, 4, 40]]);

  const mark = () => { external = true; };
  const isDemo = (state) => {
    if (demoMode === 'on' || state?.demo === true) return true;
    if (demoMode === 'off' || state?.demo === false || external) return false;
    return globalThis.__actorsDemo !== false;
  };
  const activeState = (state) => (isDemo(state) ? DEMO : EXT);

  // ------------------------------------------------------------------ solve one frame (CPU side)
  const rootM = new THREE.Matrix4(), kiteM = new THREE.Matrix4();
  const W = new THREE.Vector3(1, 0, 0), Pp = new THREE.Vector3(0, 0, 1);
  const hand = new THREE.Vector3(), kitePos = new THREE.Vector3(), kiteVel = new THREE.Vector3(), knot = new THREE.Vector3();
  const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tv3 = new THREE.Vector3();
  const res = { kiteOn: false, gust: 0, flut: 0, speed: 0, roll: 0 };

  function solve(S, t) {
    const c = S.child, k = S.kite;
    const cy = c.y ?? heightAt(c.x, c.z);
    const wv = U.uWind.value, wl = Math.hypot(wv.x, wv.y) || 1;
    W.set(wv.x / wl, 0, wv.y / wl); Pp.set(-W.z, 0, W.x);
    const gust = sstep(0.4, 0.8, valueNoise2(t * 0.3, 7.7)) * wv.z;
    res.gust = gust;
    rootM.makeRotationY(-c.heading); rootM.setPosition(c.x, cy, c.z);

    // kite placement
    res.kiteOn = !!(k.visible && k.mode);
    kiteVel.set(0, 0, 0); res.roll = 0;
    if (k.mode === 'fly') {
      const handH = c.pose === 'sit' ? 0.75 : 1.25;
      const ph = (tt) => tt * 1.2 + 3 * valueNoise2(tt * 0.15, 1.3);
      const off = (tt, out) => {
        const p = ph(tt), amp = 0.32 * (1 + 0.6 * gust);
        const lat = amp * (Math.sin(p) + 0.25 * Math.sin(2.3 * p)), ver = amp * 0.6 * Math.sin(2 * p + 0.4), alo = amp * 0.35 * Math.cos(p);
        return out.set(c.x, cy + handH + k.height, c.z).addScaledVector(W, k.back + alo).addScaledVector(Pp, k.side + lat).addScaledVector(UP, ver);
      };
      off(t, kitePos); off(t + 0.05, tv);
      kiteVel.subVectors(tv, kitePos).multiplyScalar(20);
      res.roll = clamp(-kiteVel.dot(Pp) * 0.45, -0.6, 0.6);
    } else if (k.mode === 'set') kitePos.set(k.pos[0], k.pos[1], k.pos[2]);

    // child pose, the kite arm aimed at the kite
    let aim = null;
    if (res.kiteOn) {
      aim = tv2.set(kitePos.x - c.x, kitePos.y - (cy + 0.85), kitePos.z - c.z).applyAxisAngle(UP, c.heading);
    }
    const pz = childPose(c.pose, t, c.armUp, aim);
    computeBones(pz.P, pz.off, boneMats);
    res.speed = pz.speed;
    hand.copy(HAND_REST).applyMatrix4(boneMats[6]).applyMatrix4(rootM);
    knot.copy(KNOT_REST).applyMatrix4(boneMats[1]).applyMatrix4(rootM);

    // kite frame: front (+Z) faces up-wind and a little down, towards the hand; spine leans to the flyer
    if (res.kiteOn) {
      const n = tv.copy(W).multiplyScalar(-Math.cos(0.6)).addScaledVector(UP, -Math.sin(0.6));
      const toHand = tv3.subVectors(c.visible ? hand : tv3.set(c.x, cy + 1.2, c.z), kitePos).normalize();
      n.multiplyScalar(0.6).addScaledVector(toHand, 0.4).normalize();
      const spine = tv2.copy(UP).addScaledVector(n, -UP.dot(n)).normalize();
      const right = tv3.crossVectors(spine, n).normalize();
      const flut = 0.05 * Math.sin(t * 7.3) * (0.4 + gust);
      const r = res.roll + flut, cr = Math.cos(r), sr = Math.sin(r);
      const sp2 = new THREE.Vector3().copy(spine).multiplyScalar(cr).addScaledVector(right, sr);
      const rt2 = new THREE.Vector3().crossVectors(sp2, n);
      kiteM.makeBasis(rt2, sp2, n).setPosition(kitePos);
      res.flut = gust;
    }
    return res;
  }

  // ------------------------------------------------------------------ GPU-side refreshes
  let birdKey = null, spotKey = null, zoneKey = null;
  function refreshBirds(S) {
    const key = S === DEMO ? 'd' + S.lver : 'e' + S.lver;
    if (key === birdKey) return;
    birdKey = key;
    let n = 0;
    S.launches.forEach((L, li) => {
      const seed = (Math.floor(Math.abs(L.origin[0] * 131.7 + L.origin[1] * 17.3 + L.origin[2] * 71.1 + L.t0 * 997 + L.count * 13)) + li * 7919) >>> 0;
      const rng = makeRng(seed || 1);
      const d = L.dir || [-W.x, -W.z];
      const h0 = Math.atan2(d[1], d[0]);
      for (let j = 0; j < L.count && n < MAXB; j++, n++) {
        const ra = rng() * TAU, rr = 1.4 * Math.sqrt(rng());
        bO.setXYZW(n, L.origin[0] + Math.cos(ra) * rr, L.origin[1] + rng() * 0.3, L.origin[2] + Math.sin(ra) * rr, 0.85 + rng() * 0.3);
        bA.setXYZW(n, L.t0 + rng() * 0.45, h0 + (rng() - 0.5) * L.spread, 6.5 + rng() * 3.5, 0.7 + rng() * 1.1);
        bB.setXYZW(n, 1.6 + rng() * 2.2, (rng() - 0.5) * 0.003, 0.4 + rng() * 1.6, 0.35 + rng() * 0.5);
        bC.setXYZW(n, 6 + rng() * 2, 2.6 + rng() * 0.9, rng(), rng());
      }
    });
    for (const a of [bA, bB, bC, bO]) a.needsUpdate = true;
    birdGeo.instanceCount = n;
  }
  function refreshSpots(S) {
    const key = (S === DEMO ? 'd' : 'e') + S.sver;
    if (key === spotKey) return;
    spotKey = key;
    let n = 0;
    S.spots.forEach((sp, si) => {
      const rng = makeRng(((Math.floor(Math.abs(sp[0] * 97.1 + sp[1] * 13.7 + sp[2] * 53.3)) + si * 4111) >>> 0) || 1);
      for (let j = 0; j < (sp[3] ?? 4) && n < MAXF; j++, n++) {
        fSpot.setXYZW(n, sp[0], sp[1], sp[2], (sp[4] ?? 1.6) * (0.7 + 0.5 * rng()));
        fR.setXYZW(n, rng(), rng(), rng(), rng());
      }
    });
    fSpot.needsUpdate = fR.needsUpdate = true;
    bflyGeo.instanceCount = n;
  }
  function refreshZones(S) {
    const key = (S === DEMO ? 'd' : 'e') + S.zver;
    if (key === zoneKey) return;
    zoneKey = key;
    let n = 0;
    S.zones.forEach((z, zi) => {
      const rng = makeRng(((Math.floor(Math.abs(z[0] * 71.3 + z[1] * 29.1 + z[2] * 43.7)) + zi * 6007) >>> 0) || 1);
      for (let j = 0; j < (z[4] ?? 20) && n < MAXY; j++, n++) {
        yZone.setXYZW(n, z[0], z[1], z[2], (z[3] ?? 3) * (0.5 + 0.5 * rng()));
        yR.setXYZW(n, rng(), rng(), rng(), rng());
      }
    });
    yZone.needsUpdate = yR.needsUpdate = true;
    flyGeo.instanceCount = n;
  }

  function update(t, camera, state) {
    lastT = t; lastState = state;
    const S = activeState(state);
    const r = solve(S, t);
    const c = S.child, k = S.kite;

    // child + scarf
    body.visible = scarf.visible = !!c.visible;
    body.matrix.copy(rootM); body.matrixWorldNeedsUpdate = true;
    runVel.set(Math.cos(c.heading), 0, Math.sin(c.heading)).multiplyScalar(r.speed);
    {
      const wv = U.uWind.value;
      const rel = tv.set(W.x * 2.6 * wv.z, 0, W.z * 2.6 * wv.z).sub(runVel);
      const m = Math.hypot(rel.x, rel.z);
      const droop = -2 / (1 + 0.3 * m * m) - 0.15;
      const dir = tv2.set(rel.x, droop, rel.z).normalize();
      scarfU.uSDir.value.copy(dir);
      const side = tv3.crossVectors(dir, UP);
      if (side.lengthSq() < 1e-4) side.set(-Math.sin(c.heading), 0, Math.cos(c.heading));
      scarfU.uSSide.value.copy(side.normalize());
      scarfU.uKnot.value.copy(knot);
      scarfU.uSFlow.value = clamp(m / 3, 0, 2);
      scarfU.uSVis.value = c.visible ? 1 : 0;
    }

    // kite, tail, string
    kiteMesh.visible = tail.visible = r.kiteOn;
    if (r.kiteOn) {
      kiteMesh.matrix.copy(kiteM); kiteMesh.matrixWorldNeedsUpdate = true;
      kiteU.uKFlut.value = r.flut;
      tailU.uTRoot.value.copy(TAIL_ROOT).applyMatrix4(kiteM);
      const wz = U.uWind.value.z;
      const td = tv.copy(W).multiplyScalar(0.4 + 0.8 * wz).addScaledVector(UP, -0.55).addScaledVector(kiteVel, -0.25).normalize();
      tailU.uTDir.value.copy(td);
      const ts = tv2.crossVectors(td, UP);
      if (ts.lengthSq() < 1e-4) ts.copy(Pp);
      tailU.uTSide.value.copy(ts.normalize());
      tailU.uTGust.value = r.gust;
      tailU.uTVis.value = 1;
    }
    const strOn = r.kiteOn && c.visible && k.string;
    str.visible = strOn;
    if (strOn) {
      const kn = tv.copy(BRIDLE_KNOT).applyMatrix4(kiteM);
      strU.uLA.value[0].copy(hand); strU.uLB.value[0].copy(kn);
      strU.uLA.value[1].copy(kn); strU.uLB.value[1].copy(BRIDLE_A).applyMatrix4(kiteM);
      strU.uLA.value[2].copy(kn); strU.uLB.value[2].copy(BRIDLE_B).applyMatrix4(kiteM);
      strU.uLSag.value.set(0.03 * hand.distanceTo(kn), 0, 0);
      strU.uLVis.value = 1;
    }

    // birds, butterflies, petals, fireflies
    refreshBirds(S);
    birds.visible = birdGeo.instanceCount > 0 && S.launches.some((L) => t > L.t0 - 0.1 && t < L.t0 + 15);
    refreshSpots(S);
    bflies.visible = bflyGeo.instanceCount > 0;
    petalU.uAmount.value = S.petals.amount;
    petalU.uPetalCol.value.copy(S.petals.color);
    petals.visible = S.petals.amount > 0.001;
    refreshZones(S);
    flyU.uFire.value = sstep(0.05, 0.9, U.uNight.value) * clamp(S.fireAmount, 0, 1);
    flies.visible = flyGeo.instanceCount > 0 && flyU.uFire.value > 0.003;
  }

  // ------------------------------------------------------------------ public API
  const child = {
    set(o) { mark(); ops.setChild(EXT, o); },
    handWorld(t = lastT) { solve(activeState(lastState), t); return hand.clone(); },
  };
  const kite = {
    set(o) { mark(); ops.kiteSet(EXT, o); },
    fly(o) { mark(); ops.kiteFly(EXT, o); },
    position(t = lastT) { solve(activeState(lastState), t); return kitePos.clone(); },
  };
  const birdsApi = {
    launch(o) { mark(); ops.launch(EXT, o); },
    clear() { mark(); ops.clearBirds(EXT); },
  };
  const butterflies = { setSpots(s) { mark(); ops.setSpots(EXT, s); } };
  const petalsApi = { set(o) { mark(); ops.petals(EXT, o); } };
  const fireflies = {
    setZones(z) { mark(); ops.setZones(EXT, z); },
    set(o = {}) { mark(); if (o.amount !== undefined) EXT.fireAmount = clamp(o.amount, 0, 1); if (o.zones) ops.setZones(EXT, o.zones); },
    get amount() { return EXT.fireAmount; },
    set amount(v) { mark(); EXT.fireAmount = clamp(v, 0, 1); },
  };

  return {
    group, update, child, kite, birds: birdsApi, butterflies, petals: petalsApi, fireflies,
    demo(on) { demoMode = on === true ? 'on' : on === false ? 'off' : 'auto'; },
  };
}
