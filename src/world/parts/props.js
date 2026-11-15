import * as THREE from 'three';
import { paintMaterial, register } from '../../core/materials.js';
import { U } from '../../core/env.js';
import { makeRng } from '../../core/rng.js';
import { WHEEL, PATH, JETTY, heightAt, shoreDist } from '../layout.js';

// Man-made relics: the half-sunk Ferris wheel, the jetty with its boarding platform and ticket booth,
// the old promenade lamps, a line of leaning utility poles and far wind turbines — plus their lights.
// Everything is merged into a handful of meshes with vertex colours. The wheel spins (and its gondolas
// hang) in the vertex shader, so wheel, gondolas, vines, bulbs and glow sprites stay in lock-step.

const TAU = Math.PI * 2;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const col = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mulc = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const clamp01 = (x) => Math.min(1, Math.max(0, x));

const PAL = {
  cream: col(0xe9dfc8), verm: col(0xd9583f), teal: col(0x4fa7a0), mustard: col(0xe0b040), blue: col(0x9cc4d8),
  steel: col(0x8f9aa0), wood: col(0x6b5444), concrete: col(0xcfc8b8), mint: col(0x9fd3b5), pink: col(0xe8a3a3),
  lilac: col(0xb7a8d6), woodGrey: col(0x8b7d6b), dark: col(0x34302e), white: col(0xebe8e0),
};
const LAMP_IRON = col(0x47716b);
const GLASS = col(0xffd9a0);
const BULB_COLS = [col(0xfff0c8), col(0xffb070), col(0xffd890)];
const BULB_BASE = 32;            // light-texture slot of the first wheel bulb (lamps use 0..31)
const LIGHT_TEX_W = 512;
const TILT_X = 0.04, TILT_Z = -0.03;

// ------------------------------------------------------------------------------------------------
// geometry templates + a small merge builder
const T_BOX = new THREE.BoxGeometry(1, 1, 1);
const T_BEAM = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const T_PYR = (() => { const g = new THREE.CylinderGeometry(0, Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4).toNonIndexed(); g.computeVertexNormals(); return g; })();
const T_OCT = new THREE.OctahedronGeometry(1, 0);
const T_TORUS = new THREE.TorusGeometry(0.33, 0.055, 4, 14);
const cylCache = new Map();
function T_CYL(sides, ratio, caps) {
  const key = `${sides}_${ratio.toFixed(3)}_${caps}`;
  if (!cylCache.has(key)) cylCache.set(key, new THREE.CylinderGeometry(ratio, 1, 1, sides, 1, !caps).translate(0, 0.5, 0));
  return cylCache.get(key);
}
const UP = V(0, 1, 0), XA = V(1, 0, 0), ZA = V(0, 0, 1);
const _M = new THREE.Matrix4(), _M2 = new THREE.Matrix4(), _NM = new THREE.Matrix3();
const _a = V(), _b = V(), _d = V(), _u = V(), _w = V(), _t1 = V(), _t2 = V(), _t3 = V(), _S = V();
const _QI = new THREE.Quaternion(), _QF = new THREE.Quaternion().setFromAxisAngle(XA, Math.PI);
const quatE = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));

function basis(a, b, hint) {
  _d.subVectors(b, a); const L = _d.length(); _d.divideScalar(L || 1);
  let h = hint || UP;
  if (Math.abs(_d.dot(h)) > 0.95) h = Math.abs(_d.x) < 0.9 ? XA : ZA;
  _u.crossVectors(h, _d).normalize(); _w.crossVectors(_u, _d);
  return L;
}

class Builder {
  constructor(extras = {}) {
    this.P = []; this.N = []; this.C = []; this.UV = []; this.I = []; this.n = 0;
    this.sizes = extras; this.ex = {}; this.cur = {};
    for (const k in extras) { this.ex[k] = []; this.cur[k] = new Array(extras[k]).fill(0); }
    if (extras.aLight) this.cur.aLight = [-1];
    this.xf = new THREE.Matrix4();
  }
  vert(p, n, c, u, v) {
    this.P.push(p.x, p.y, p.z); this.N.push(n.x, n.y, n.z); this.C.push(c[0], c[1], c[2]); this.UV.push(u, v);
    for (const k in this.ex) { const a = this.cur[k]; for (let i = 0; i < a.length; i++) this.ex[k].push(a[i]); }
    return this.n++;
  }
  geo(g, m, c) {
    const M = _M.multiplyMatrices(this.xf, m); _NM.getNormalMatrix(M);
    const P = g.attributes.position, N = g.attributes.normal, UVa = g.attributes.uv, base = this.n;
    for (let i = 0; i < P.count; i++) {
      _a.fromBufferAttribute(P, i).applyMatrix4(M); _b.fromBufferAttribute(N, i).applyMatrix3(_NM).normalize();
      this.vert(_a, _b, c, UVa ? UVa.getX(i) : 0, UVa ? UVa.getY(i) : 0);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) this.I.push(base + g.index.getX(i));
    else for (let i = 0; i < P.count; i++) this.I.push(base + i);
  }
  box(c0, sx, sy, sz, c, q = null) { this.geo(T_BOX, _M2.compose(c0, q || _QI, _S.set(sx, sy, sz)), c); }
  pyr(c0, sx, sy, sz, c, down = false) { this.geo(T_PYR, _M2.compose(c0, down ? _QF : _QI, _S.set(sx, sy, sz)), c); }
  dab(c0, r, c) { this.geo(T_OCT, _M2.compose(c0, _QI, _S.set(r, r, r)), c); }
  beam(a, b, w, h, c, hint) {
    const L = basis(a, b, hint);
    _M2.makeBasis(_t1.copy(_u).multiplyScalar(w), _t2.copy(_d).multiplyScalar(L), _t3.copy(_w).multiplyScalar(h)).setPosition(a);
    this.geo(T_BEAM, _M2, c);
  }
  cyl(a, b, r0, r1, c, sides = 6, caps = true) {
    const L = basis(a, b);
    _M2.makeBasis(_t1.copy(_u).multiplyScalar(r0), _t2.copy(_d).multiplyScalar(L), _t3.copy(_w).multiplyScalar(r0)).setPosition(a);
    this.geo(T_CYL(sides, r1 / r0, caps), _M2, c);
  }
  quad(p0, p1, p2, p3, c, n) {
    const xf = this.xf; _NM.getNormalMatrix(xf);
    const nn = _b.copy(n).applyMatrix3(_NM).normalize().clone();
    const i0 = this.vert(_a.copy(p0).applyMatrix4(xf), nn, c, 0, 0);
    this.vert(_a.copy(p1).applyMatrix4(xf), nn, c, 1, 0);
    this.vert(_a.copy(p2).applyMatrix4(xf), nn, c, 1, 1);
    this.vert(_a.copy(p3).applyMatrix4(xf), nn, c, 0, 1);
    this.I.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  }
  // a leaf card: stem point s, across-direction h, tip direction t (units), width w, length l
  leaf(s, h, t, w, l, c) {
    const n = V().crossVectors(h, t).normalize();
    const hw = h.clone().multiplyScalar(w / 2), tl = t.clone().multiplyScalar(l);
    this.quad(s.clone().sub(hw), s.clone().add(hw), s.clone().add(tl).add(hw), s.clone().add(tl).sub(hw), c, n);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.UV, 2));
    for (const k in this.ex) g.setAttribute(k, new THREE.Float32BufferAttribute(this.ex[k], this.sizes[k]));
    g.setIndex(this.I);
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------------------------------------------
// shaders
const WHEEL_FN = /* glsl */ `
uniform float uWheelAngle; uniform float uTiltX; uniform float uTiltZ;
vec3 rotX(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z); }
vec3 rotZ(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z); }
vec3 hangDir(vec3 v){ return rotZ(rotX(v, -uTiltX), -uTiltZ); }
// mode 0: static · 1: turns with the wheel · 2: hangs (plumb) from a pivot that turns with the wheel
void wheelXform(inout vec3 p, inout vec3 n, vec3 piv, float mode, float swing){
  if (mode > 1.5){
    float sw = swing * sin(uTime * .8 + piv.y * .37 + piv.z * .23);
    vec3 off = rotX(p - piv, sw);
    p = rotX(piv, uWheelAngle) + hangDir(off);
    n = hangDir(rotX(n, sw));
  } else if (mode > .5){
    p = rotX(p, uWheelAngle); n = rotX(n, uWheelAngle);
  }
}`;
const LIGHT_FN = /* glsl */ `
uniform sampler2D uLightTex; uniform float uBulbBase;
float lightLevel(float idx){
  if (idx < -.5) return 0.;
  float b = texelFetch(uLightTex, ivec2(int(idx + .5), 0), 0).r;
  if (idx > uBulbBase - .5) b *= 1. + .06 * sin(uTime * 2.3 + idx * 2.17);
  return b;
}`;

function relicMaterial({ moss = 0.5, rust = 0.4, mask = 1, wobble = 0.12, defines = {}, side = THREE.FrontSide, uniforms = {}, name = 'relic' } = {}) {
  return paintMaterial({
    name, side, defines,
    uniforms: { uMoss: { value: moss }, uRust: { value: rust }, uMaskVal: { value: mask }, uWobble: { value: wobble }, ...uniforms },
    vertexPars: /* glsl */ `
      attribute vec3 color; varying vec3 vCol;
      #ifdef WHEEL
        attribute vec3 aPivot; attribute float aMode;
        ${WHEEL_FN}
      #endif
      #ifdef LIGHTS
        attribute float aLight; varying float vLight; varying float vLB;
        ${LIGHT_FN}
      #endif
      #ifdef TURBINE
        attribute vec3 aHub; attribute vec3 aAxis; attribute vec2 aSpin;
        vec3 rotAxis(vec3 v, vec3 k, float a){ float c = cos(a), s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1. - c); }
      #endif`,
    vertexMain: /* glsl */ `
      vCol = color;
      #ifdef WHEEL
        wheelXform(pos, nrm, aPivot, aMode, .025);
      #endif
      #ifdef TURBINE
        { float ang = aSpin.x * uTime + aSpin.y; pos = aHub + rotAxis(pos - aHub, aAxis, ang); nrm = rotAxis(nrm, aAxis, ang); }
      #endif
      #ifdef LIGHTS
        vLight = aLight; vLB = lightLevel(aLight);
      #endif`,
    fragmentPars: /* glsl */ `
      varying vec3 vCol; uniform float uMoss, uRust, uMaskVal, uWobble;
      #ifdef LIGHTS
        varying float vLight; varying float vLB;
      #endif`,
    fragmentMain: /* glsl */ `
      vec3 N = normalize(vN);
      if (!gl_FrontFacing) N = -N;
      vec3 base = vCol;
      float isL = 0., lb = 0.;
      #ifdef LIGHTS
        isL = step(-.5, vLight); lb = clamp(vLB, 0., 1.);
        base = mix(base, mix(vec3(.52, .5, .47), vCol, .3) * .85, isL);
      #endif
      float n1 = vnoise3(vW * 1.7), n2 = vnoise3(vW * 6.3), n3 = fbm3lo(vW * .55);
      float rs = smoothstep(.52, .78, n3 * .7 + n1 * .3) * uRust * (1. - isL);
      base = mix(base, base * vec3(.78, .56, .42) + vec3(.1, .03, 0.), rs);
      base *= .93 + .14 * n2;
      float up = smoothstep(.25, .85, N.y);
      float mossy = smoothstep(.5, .72, up * (.45 + .55 * n3) + (n1 - .5) * .35) * uMoss * (1. - isL);
      base = mix(base, mix(uGrassB, uGrassA, n2) * .92, mossy);
      float ndl = dot(N, uSunDir);
      float wob = (n1 - .5) * uWobble + (n2 - .5) * uWobble * .5;
      float lit = paintBand(ndl + wob, .1, .035);
      float hi = paintBand(ndl + wob, .78, .05) * .5;
      float sh = getShadow(vW + N * .09, vec2(n1 - .5, n2 - .5) * .12);
      vec3 col = paintLight(base, lit * sh, hi * sh);
      col += uGrassB * uSunTint * .07 * smoothstep(0., -.8, N.y) * uSunAmt;
      vec3 outc = applyHaze(col, vW);
      #ifdef TURBINE
        outc = mix(outc, mix(uHazeFar, uHazeNear, .3), .38);     // far away: a pale, hazy silhouette
      #endif
      #ifdef LIGHTS
        vec3 em = vCol * 1.3 + .28;
        outc = mix(outc, mix(applyHaze(em, vW), em, .55), lb * isL);
      #endif
      paintOut(outc, 1., mix(uMaskVal, .3, isL));`,
  });
}

function vineMaterial(uniforms) {
  return paintMaterial({
    name: 'relic-vine', side: THREE.DoubleSide, a2c: true, uniforms,
    vertexPars: /* glsl */ `attribute vec3 color; attribute vec3 aPivot; attribute float aMode; attribute vec2 aSway;
      varying vec2 vUv; varying float vTone;
      ${WHEEL_FN}`,
    vertexMain: /* glsl */ `
      vUv = uv; vTone = color.x;
      float sw = aSway.x;
      pos += vec3(sin(uTime * 1.3 + aSway.y + sw * .7), 0., sin(uTime * .95 + aSway.y * 1.7 + sw * .5) * 1.3) * (.04 * sw);
      wheelXform(pos, nrm, aPivot, aMode, .025);`,
    fragmentPars: /* glsl */ `varying vec2 vUv; varying float vTone;
      float leafA(vec2 q){ float v = clamp(q.y, 0., 1.); float w = .5 * pow(sin(3.14159 * pow(v, .7)), .85); return .5 + (w - abs(q.x - .5)) * 9.; }`,
    fragmentMain: /* glsl */ `
      float a = leafA(vUv);
      vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
      float n1 = vnoise3(vW * 2.3), n2 = vnoise3(vW * 5.1 + 3.);
      vec3 base = mix(uLeafMid, uLeafLight, vTone);
      base = mix(base, uLeafDark, smoothstep(.55, .9, n1) * .35);
      float ndl = dot(N, uSunDir);
      float lit = paintBand(abs(ndl) * .75 + ndl * .25 + (n1 - .5) * .3, .12, .05);
      float sh = getShadow(vW + N * .05, vec2(n1 - .5, n2 - .5) * .14);
      vec3 col = paintLight(base, lit * sh, 0.);
      float hi = paintBand(ndl + (n2 - .5) * .25, .55, .05) * sh * uSunAmt;
      col = mix(col, uLeafHi * uSunTint, hi * .55 * vTone);
      paintOut(applyHaze(col, vW), cutAlpha(a), .6);`,
    depthMain: `if (leafA(vUv) < .5) discard;`,
  });
}

function glowMaterial(uniforms) {
  return paintMaterial({
    name: 'relic-glow', blend: 'add', depthWrite: false, uniforms,
    vertexPars: /* glsl */ `attribute vec3 iPos; attribute vec4 iData; attribute vec3 iCol; uniform mat4 uWheelMatrix;
      varying vec2 vQ; varying vec3 vGCol; varying float vGB; varying float vRatio;
      ${WHEEL_FN}
      ${LIGHT_FN}`,
    vertexWorld: /* glsl */ `
      vec3 c = iPos;
      if (iData.w > .5) c = (uWheelMatrix * vec4(rotX(iPos, uWheelAngle), 1.)).xyz;
      float b = lightLevel(iData.z);
      vec3 cR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
      vec3 cU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      vec3 cB = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
      float dist = length(c - uCamPos);
      float fog = 1. - exp(-pow(dist * uFogDensity, 1.25));
      vGB = b * (1. - .55 * fog) * mix(.65, 1., uNight);
      vQ = position.xy; vGCol = iCol; vRatio = iData.x / iData.y;
      float rad = b > .003 ? iData.y : 0.;
      c += cB * min(iData.x * .55, .6);
      wp = vec4(c + (cR * position.x + cU * position.y) * rad, 1.);`,
    fragmentPars: /* glsl */ `varying vec2 vQ; varying vec3 vGCol; varying float vGB; varying float vRatio;`,
    fragmentMain: /* glsl */ `
      float r = length(vQ);
      if (r > 1.) discard;
      float dc = r / vRatio;
      float core = exp(-dc * dc * 3.);
      float halo = (1. - r) * (1. - r) * .16;
      float amp = max(max(vGCol.r, vGCol.g), vGCol.b);
      vec3 c = vGCol * (core * .9 + halo) + mix(vGCol, vec3(amp), .6) * pow(core, 5.) * .4;
      paintOutAdd(c * vGB);`,
  });
}

// ------------------------------------------------------------------------------------------------
// vegetation helpers (leaf cards in the vine material: color.x = tone)
function strand(vb, a, len, rng, size = 1) {
  const n = Math.max(3, Math.round(len / 0.21));
  const bend = V(rng.range(-1, 1), 0, rng.range(-1, 1)).setLength(rng.range(0.1, 0.45));
  const ph = rng() * TAU;
  for (let k = 0; k < 4; k++) {
    const yaw = rng() * TAU, o = V(Math.cos(yaw), 0, Math.sin(yaw));
    const t = V(o.x, rng.range(-0.6, 0.2), o.z).normalize();
    vb.cur.aSway = [0.1, ph];
    vb.leaf(a.clone().addScaledVector(t, -0.05), V(-o.z, 0, o.x), t, 0.42 * size, 0.5 * size, [rng(), 0, 0]);
  }
  for (let i = 0; i < n; i++) {
    const d = ((i + 0.6) / n) * len, f = d / len;
    const s = V(a.x + bend.x * f * f, a.y - d, a.z + bend.z * f * f);
    const sz = size * (1 - 0.35 * f) * rng.range(0.85, 1.15);
    for (let side = 0; side < 2; side++) {
      const yaw = rng() * TAU, h = V(Math.cos(yaw), 0, Math.sin(yaw));
      const o = V(-h.z, 0, h.x).multiplyScalar(side ? 1 : -1);
      const t = V(o.x * 0.75, -1, o.z * 0.75).normalize();
      vb.cur.aSway = [d, ph];
      vb.leaf(s.clone().addScaledVector(o, 0.04), h, t, 0.36 * sz, 0.46 * sz, [rng(), 0, 0]);
    }
  }
}
function clump(vb, c, r, n, rng, size = 1, sway = 0.4) {
  const ph = rng() * TAU;
  for (let i = 0; i < n; i++) {
    const u = rng.range(-0.3, 1), phi = rng() * TAU, sx = Math.sqrt(1 - u * u);
    const dir = V(sx * Math.cos(phi), u, sx * Math.sin(phi));
    const s = c.clone().addScaledVector(dir, r * rng.range(0.35, 1));
    const t = dir.clone().add(V(rng.range(-0.3, 0.3), -0.25, rng.range(-0.3, 0.3))).normalize();
    const h = V().crossVectors(t, Math.abs(t.y) > 0.9 ? XA : UP).normalize();
    vb.cur.aSway = [sway * (0.4 + Math.max(0, dir.y)), ph];
    vb.leaf(s.addScaledVector(t, -0.12 * size), h, t, 0.44 * size, 0.54 * size, [rng.range(0.2, 1), 0, 0]);
  }
}

// ------------------------------------------------------------------------------------------------
// the Ferris wheel (wheel-local frame: hub at the origin, axle along x)
function buildWheel(rng) {
  const wb = new Builder({ aPivot: 3, aMode: 1, aLight: 1 });
  const vb = new Builder({ aPivot: 3, aMode: 1, aSway: 2 });
  const R = WHEEL.radius, RIN = R - 2.9, XR = 1.1, XIN = 1.17;
  const P = (x, r, th) => V(x, r * Math.sin(th), r * Math.cos(th));
  const rimC = PAL.cream, trussC = mixc(PAL.blue, PAL.cream, 0.3), hubC = mixc(PAL.verm, PAL.cream, 0.12);
  const legC = mixc(PAL.teal, PAL.steel, 0.55), steelC = PAL.steel;
  const bulbs = [];

  const ring = (x, r, rad, segs, c) => {
    for (let i = 0; i < segs; i++) wb.cyl(P(x, r, (i / segs) * TAU), P(x, r, ((i + 1) / segs) * TAU), rad, rad, c, 6, false);
  };
  // --- turning structure
  wb.cur.aMode = [1];
  for (const sx of [-1, 1]) {
    ring(sx * XR, R, 0.2, 96, rimC);
    ring(sx * XIN, RIN, 0.13, 72, trussC);
    for (let j = 0; j < 32; j++) {
      const a0 = (j / 32) * TAU, a1 = a0 + TAU / 64, a2 = a0 + TAU / 32;
      wb.cyl(P(sx * XR, R, a0), P(sx * XIN, RIN, a1), 0.075, 0.075, trussC, 5, false);
      wb.cyl(P(sx * XIN, RIN, a1), P(sx * XR, R, a2), 0.075, 0.075, trussC, 5, false);
    }
  }
  for (let j = 0; j < 32; j++) {                       // zig-zag bracing between the two inner rings
    const a0 = (j / 32) * TAU, a1 = a0 + TAU / 64, a2 = a0 + TAU / 32;
    wb.cyl(P(-XIN, RIN, a0), P(XIN, RIN, a1), 0.075, 0.075, trussC, 5, false);
    wb.cyl(P(XIN, RIN, a1), P(-XIN, RIN, a2), 0.075, 0.075, trussC, 5, false);
  }
  for (let s = 0; s < 16; s++) {                       // 16 spoke pairs + a tie across the rims at each spoke
    const th = (s / 16) * TAU;
    for (const sx of [-1, 1]) wb.cyl(P(sx * 1.55, 1.2, th), P(sx * XR, R - 0.15, th), 0.11, 0.095, rimC, 6, false);
    wb.cyl(P(-XR, R, th), P(XR, R, th), 0.1, 0.1, trussC, 6, false);
  }
  wb.cyl(V(-1.7, 0, 0), V(1.7, 0, 0), 1.3, 1.3, hubC, 10, true);               // fat hub drum
  for (const sx of [-1, 1]) wb.cyl(V(sx * 1.42, 0, 0), V(sx * 1.68, 0, 0), 1.75, 1.75, rimC, 12, true);

  // --- gondolas (16, hanging between the rims)
  const gPal = [PAL.verm, PAL.teal, PAL.mustard, PAL.blue, PAL.mint, PAL.pink, PAL.lilac, PAL.cream];
  const missing = new Set([4, 14]);
  const askew = { 2: 0.2, 7: -0.15, 10: 0.1 };
  const vineGondolas = new Set([1, 5, 9, 12, 15]);
  for (let k = 0; k < 16; k++) {
    const th = ((k + 0.5) / 16) * TAU, piv = P(0, R, th);
    wb.cur.aMode = [1]; wb.cur.aPivot = [0, 0, 0];
    wb.cyl(P(-XR, R, th), P(XR, R, th), 0.12, 0.12, steelC, 6, false);
    if (missing.has(k)) continue;
    const bodyBase = gPal[(k * 3) % 8];
    const body = mixc(bodyBase, PAL.cream, 0.16 + rng() * 0.1);
    const isCream = bodyBase === PAL.cream;
    const roof = isCream ? mixc(PAL.teal, PAL.cream, 0.2) : mixc(PAL.cream, bodyBase, 0.12);
    const trim = isCream ? mixc(PAL.verm, PAL.cream, 0.25) : PAL.cream;
    wb.cur.aMode = [2]; wb.cur.aPivot = [piv.x, piv.y, piv.z];
    wb.xf.makeRotationX(askew[k] || 0).setPosition(piv);
    for (const sx of [-0.5, 0.5]) wb.box(V(sx, -0.24, 0), 0.14, 0.48, 0.16, steelC);
    wb.pyr(V(0, -0.32, 0), 1.6, 0.32, 2.2, roof);
    wb.box(V(0, -0.56, 0), 1.72, 0.16, 2.4, roof);
    for (const sx of [-0.74, 0.74]) for (const sz of [-1.0, 0, 1.0]) wb.box(V(sx, -0.97, sz), 0.15, 0.66, 0.15, trim);
    wb.box(V(0, -1.38, 0), 1.72, 0.16, 2.3, trim);
    wb.box(V(0, -1.91, 0), 1.6, 0.9, 2.16, body);
    wb.box(V(0, -2.44, 0), 1.2, 0.16, 1.7, mulc(steelC, 0.8));
    for (const sz of [-0.72, 0.72]) {
      wb.box(V(0, -1.2, sz), 1.36, 0.2, 0.42, PAL.wood);
      wb.box(V(0, -0.95, sz + Math.sign(sz) * 0.17), 1.36, 0.3, 0.14, PAL.wood);
    }
    if (vineGondolas.has(k)) {
      vb.cur.aMode = [2]; vb.cur.aPivot = [piv.x, piv.y, piv.z];
      vb.xf.copy(wb.xf);
      const nv = 1 + (rng() < 0.5 ? 1 : 0);
      for (let i = 0; i < nv; i++) strand(vb, V(rng.range(-0.7, 0.7), -0.58, rng.sign() * 1.18), rng.range(0.9, 2.3), rng, 1.1);
      clump(vb, V(rng.range(-0.4, 0.4), -0.3, rng.range(-0.6, 0.6)), 0.5, 9, rng, 1.1, 0.2);
      vb.xf.identity();
    }
    wb.xf.identity();
  }
  wb.cur.aPivot = [0, 0, 0];

  // --- supports (static): axle, bearings, two A-frames with ties
  wb.cur.aMode = [0];
  wb.cyl(V(-2.95, 0, 0), V(2.95, 0, 0), 0.45, 0.45, steelC, 8, true);
  const legTop = (sx) => V(sx * 2.55, -0.3, 0), legFoot = (sx, sz) => V(sx * 3.9, -18.6, sz * 10.6);
  const legAt = (sx, sz, y) => { const a = legTop(sx), b = legFoot(sx, sz); return a.clone().lerp(b, (a.y - y) / (a.y - b.y)); };
  for (const sx of [-1, 1]) {
    wb.box(V(sx * 2.5, 0, 0), 0.8, 1.3, 1.3, mulc(steelC, 0.92));
    for (const sz of [-1, 1]) wb.beam(legTop(sx), legFoot(sx, sz), 0.5, 0.5, legC, XA);
    for (const y of [-6.5, -12.5]) wb.beam(legAt(sx, -1, y), legAt(sx, 1, y), 0.34, 0.36, legC, UP);
    wb.beam(legAt(sx, -1, -6.5), legAt(sx, 1, -12.5), 0.26, 0.26, legC, XA);
    wb.beam(legAt(sx, 1, -6.5), legAt(sx, -1, -12.5), 0.26, 0.26, legC, XA);
    wb.beam(legAt(sx, -1, -12.5), legAt(sx, 1, -17.5), 0.26, 0.26, legC, XA);
  }

  // --- bulbs: hub star, spokes, both rims (turning)
  wb.cur.aMode = [1];
  const addBulb = (p, c, order) => {
    wb.cur.aLight = [BULB_BASE + bulbs.length];
    bulbs.push({ p, c, order });
    wb.dab(p, 0.15, c);
    wb.cur.aLight = [-1];
  };
  for (const sx of [-1, 1]) for (let k = 0; k < 7; k++) addBulb(P(sx * 1.8, 1.15, (k / 7) * TAU + 0.3), BULB_COLS[k % 3], 0.01 + (0.05 * k) / 7);
  for (let s = 0; s < 16; s++) {
    const th = (s / 16) * TAU;
    for (const sx of [-1, 1]) for (let i = 0; i < 4; i++) {
      const f = (i + 1) / 5, r = 1.2 + (R - 1.35) * f, x = sx * (1.55 + (XR - 1.55) * f + 0.17);
      addBulb(P(x, r, th), BULB_COLS[(i + s) % 3], 0.08 + 0.42 * f);
    }
  }
  for (const sx of [-1, 1]) for (let j = 0; j < 40; j++) {
    const th = (j / 40) * TAU;
    const frac = ((((Math.PI / 2 - th) % TAU) + TAU) % TAU) / TAU;
    addBulb(P(sx * (XR + 0.24), R, th), BULB_COLS[j % 3], 0.55 + 0.43 * frac);
  }

  // --- vines: from rims and spokes (hang from turning anchors), on the supports (static)
  for (let i = 0; i < 16; i++) {
    const th = rng() * TAU, sx = rng.sign();
    const a = P(sx * XR, R - 0.2, th);
    vb.cur.aMode = [2]; vb.cur.aPivot = [a.x, a.y, a.z];
    strand(vb, a, rng.range(1.4, 4.6), rng, 1.25);
  }
  for (let i = 0; i < 14; i++) {
    const s = Math.floor(rng() * 16), th = (s / 16) * TAU, sx = rng.sign(), f = rng.range(0.3, 0.92);
    const r = 1.2 + (R - 1.35) * f, a = P(sx * (1.55 + (XR - 1.55) * f), r - 0.12, th);
    vb.cur.aMode = [2]; vb.cur.aPivot = [a.x, a.y, a.z];
    strand(vb, a, rng.range(1.2, 3.8), rng, 1.2);
  }
  vb.cur.aMode = [0]; vb.cur.aPivot = [0, 0, 0];
  for (const sx of [-1, 1]) {
    clump(vb, V(sx * 2.55, 0.85, rng.range(-0.3, 0.3)), 0.75, 22, rng, 1.3, 0.25);     // bushes on the bearings
    strand(vb, V(sx * 2.6, -0.7, 0.5), rng.range(2, 3.5), rng, 1.25);
    const tie = legAt(sx, rng.sign(), -6.5);
    clump(vb, tie.clone().add(V(0, 0.4, 0)), 0.6, 14, rng, 1.2, 0.25);
    strand(vb, tie.clone().add(V(0, -0.2, 0)), rng.range(2, 4), rng, 1.2);
    for (const sz of [-1, 1]) {                                                           // reeds of ivy climbing the legs
      for (const y of [-14.5, -16.2]) clump(vb, legAt(sx, sz, y), 0.55, 10, rng, 1.2, 0.2);
    }
  }
  // a sapling growing out of the lower tie of the west A-frame
  {
    const base = legAt(-1, 1, -12.5).add(V(0, 0.2, 0));
    wb.cur.aMode = [0];
    wb.cyl(base, base.clone().add(V(-0.25, 2.2, 0.3)), 0.09, 0.07, PAL.wood, 5, false);
    for (const o of [V(-0.3, 2.3, 0.3), V(-0.6, 1.8, 0.0), V(0.1, 2.0, 0.6)]) clump(vb, base.clone().add(o), 0.6, 14, rng, 1.2, 0.3);
  }
  return { wb, vb, bulbs };
}

// ------------------------------------------------------------------------------------------------
// lamps (local frame: base at origin, neck reaching toward +x)
function tallLamp(b, idx) {
  const iron = LAMP_IRON, ironD = mulc(LAMP_IRON, 0.8);
  b.box(V(0, 0.08, 0), 0.58, 0.5, 0.58, PAL.concrete);
  b.cyl(V(0, 0.3, 0), V(0, 1.15, 0), 0.24, 0.13, iron, 8, true);
  b.cyl(V(0, 1.08, 0), V(0, 1.22, 0), 0.17, 0.17, ironD, 8, true);
  b.cyl(V(0, 1.15, 0), V(0, 4.05, 0), 0.105, 0.085, iron, 6, false);
  b.cyl(V(0, 2.92, 0), V(0, 3.02, 0), 0.145, 0.145, ironD, 8, true);
  let prev = V(0, 4.0, 0);
  for (let i = 1; i <= 6; i++) {
    const a = Math.PI - ((Math.PI - 0.25) * i) / 6;
    const p = V(0.42 + 0.42 * Math.cos(a), 4.05 + 0.42 * Math.sin(a), 0);
    b.cyl(prev, p, 0.078, 0.078, iron, 6, true); prev = p;
  }
  const hx = 0.84;
  b.cyl(V(hx, 4.17, 0), V(hx, 3.98, 0), 0.065, 0.065, iron, 5, false);
  b.pyr(V(hx, 3.99, 0), 0.52, 0.22, 0.52, iron);
  b.box(V(hx, 3.86, 0), 0.48, 0.08, 0.48, ironD);
  b.cur.aLight = [idx]; b.box(V(hx, 3.6, 0), 0.34, 0.44, 0.34, GLASS); b.cur.aLight = [-1];
  b.pyr(V(hx, 3.31, 0), 0.32, 0.16, 0.32, iron, true);
  return V(hx, 3.6, 0);
}
function shortLamp(b, idx) {
  const iron = LAMP_IRON, ironD = mulc(LAMP_IRON, 0.8);
  b.cyl(V(0, 0, 0), V(0, 2.35, 0), 0.1, 0.085, iron, 6, true);
  b.cyl(V(0, 2.22, 0), V(0, 2.42, 0), 0.15, 0.15, ironD, 8, true);
  b.box(V(0, 2.45, 0), 0.4, 0.07, 0.4, iron);
  b.cur.aLight = [idx]; b.box(V(0, 2.69, 0), 0.32, 0.4, 0.32, GLASS); b.cur.aLight = [-1];
  b.box(V(0, 2.92, 0), 0.46, 0.07, 0.46, ironD);
  b.pyr(V(0, 3.05, 0), 0.44, 0.22, 0.44, iron);
  b.box(V(0, 3.2, 0), 0.11, 0.14, 0.11, iron);
  return V(0, 2.69, 0);
}

// a railing from a to b (deck level y), posts leaning outward, gaps where time took pieces
function railing(b, a, e, n, out, rng, c, { gap = 0.18, h = 1.1 } = {}) {
  const tops = [];
  for (let i = 0; i <= n; i++) {
    const p = a.clone().lerp(e, i / n);
    if (i > 0 && i < n && rng() < 0.1) { tops.push(null); continue; }
    const lean = rng.range(0.02, 0.13);
    const top = p.clone().add(V(out.x * lean * h + rng.range(-0.05, 0.05), h * Math.cos(lean), out.z * lean * h + rng.range(-0.05, 0.05)));
    b.beam(p.clone().add(V(0, -0.22, 0)), top, 0.15, 0.15, c(), XA);
    tops.push(top);
  }
  for (let i = 0; i < n; i++) {
    const t0 = tops[i], t1 = tops[i + 1];
    if (!t0 || !t1) continue;
    const r = rng();
    if (r < gap) continue;
    if (r < gap + 0.05) {                  // broken rail, one end fallen onto the deck
      b.beam(t0.clone().add(V(0, -0.05, 0)), t1.clone().lerp(t0, 0.25).setY(a.y + 0.08), 0.14, 0.12, c(), UP);
      continue;
    }
    b.beam(t0.clone().add(V(0, -0.04, 0)), t1.clone().add(V(0, -0.04 - rng.range(0, 0.06), 0)), 0.14, 0.13, c(), UP);
    if (rng() < 0.45) {
      const m0 = t0.clone().lerp(a.clone().lerp(e, i / n), 0.5), m1 = t1.clone().lerp(a.clone().lerp(e, (i + 1) / n), 0.5);
      b.beam(m0, m1, 0.13, 0.12, c(), UP);
    }
  }
}

function buildBooth(b, cx, cz) {
  const Y = JETTY.y;
  const wall = mixc(PAL.teal, PAL.cream, 0.22), trim = PAL.cream, roofC = mixc(PAL.verm, PAL.cream, 0.28);
  const stripeA = mixc(PAL.verm, PAL.cream, 0.18), stripeB = mixc(PAL.cream, PAL.mustard, 0.12);
  b.xf.compose(V(cx, Y, cz), quatE(0.02, 0.05, 0.03), V(1, 1, 1));
  b.box(V(0, 0.06, 0), 2.2, 0.12, 1.8, mulc(PAL.wood, 0.9));
  b.box(V(0, 1.15, -0.73), 2.0, 2.1, 0.14, wall);
  for (const sx of [-1, 1]) b.box(V(sx * 0.93, 1.15, 0), 0.14, 2.1, 1.6, wall);
  b.box(V(0, 0.6, 0.73), 2.0, 1.0, 0.14, wall);
  b.box(V(0, 2.03, 0.73), 2.0, 0.34, 0.14, wall);
  b.box(V(0, 1.13, 0.88), 2.16, 0.1, 0.38, trim);
  for (const sx of [-1, 1]) b.box(V(sx * 0.98, 1.15, 0.78), 0.2, 2.14, 0.2, trim);
  b.box(V(0, 0.3, 0.2), 1.2, 0.6, 0.5, PAL.wood);                        // an old stool / crate inside
  b.box(V(0, 2.28, 0), 2.5, 0.16, 2.1, roofC);
  b.box(V(0, 2.62, -0.5), 1.7, 0.5, 0.14, PAL.mustard);
  b.box(V(0, 2.62, -0.42), 1.4, 0.22, 0.04, PAL.cream);
  const n = 7, w = 2.16 / n;
  for (let i = 0; i < n; i++) {
    const x = -1.08 + (i + 0.5) * w, c = i % 2 ? stripeB : stripeA;
    b.beam(V(x, 2.02, 0.8), V(x, 1.64, 1.56), w + 0.004, 0.08, c, UP);
    b.box(V(x, 1.53, 1.56), w, 0.22, 0.08, c);
  }
  b.xf.identity();
}

function buildJetty(b, vb, rng) {
  const Z = JETTY.z, Y = JETTY.y, X0 = 66.5, X1 = 10.5;
  const wc = () => mulc(mixc(PAL.wood, PAL.woodGrey, rng() * 0.75), rng.range(0.9, 1.08));
  const postC = mulc(PAL.wood, 0.85);
  // deck planks across the walk
  for (let x = X0; x > X1 + 0.2; x -= 0.36) {
    const r = rng();
    if (r < 0.03) continue;
    let L = rng.range(2.32, 2.5), off = rng.range(-0.06, 0.06);
    if (r < 0.075) { L = rng.range(0.9, 1.3); off = (rng() < 0.5 ? -1 : 1) * (1.2 - L / 2); }
    b.box(V(x - 0.15, Y - 0.06 + rng.range(-0.025, 0.012), Z + off), 0.3, 0.12, L, wc(), quatE(rng.range(-0.03, 0.03), rng.range(-0.025, 0.025), rng.range(-0.02, 0.02)));
  }
  // posts, cross beams, stringers
  for (let x = 66; x >= X1; x -= 3) {
    for (const sz of [-1.15, 1.15]) b.cyl(V(x + rng.range(-0.15, 0.15), -1.9, Z + sz + rng.range(-0.1, 0.1)), V(x, Y - 0.14, Z + sz), 0.14, 0.13, postC, 6, true);
    b.box(V(x, Y - 0.22, Z), 0.2, 0.18, 2.7, postC, quatE(rng.range(-0.04, 0.04), 0, 0));
    if (x - 3 >= X1 - 0.5) for (const sz of [-0.85, 0.85]) b.beam(V(x + 0.1, Y - 0.22, Z + sz), V(x - 3.1, Y - 0.22 + rng.range(-0.04, 0.02), Z + sz), 0.16, 0.2, postC, UP);
  }
  railing(b, V(66, Y, Z + 1.24), V(12, Y, Z + 1.24), 18, ZA, rng, wc);
  // boarding platform
  const PX0 = 1.0, PX1 = X1, PZ0 = Z - 4.4, PZ1 = Z + 4.4;
  for (let x = PX1 - 0.18; x > PX0 + 0.1; x -= 0.36) {
    for (const [z0, z1] of [[PZ0, Z], [Z, PZ1]]) {
      if (rng() < 0.04) continue;
      b.box(V(x, Y - 0.06 + rng.range(-0.02, 0.01), (z0 + z1) / 2 + rng.range(-0.05, 0.05)), 0.3, 0.12, z1 - z0 - 0.05, wc(), quatE(rng.range(-0.02, 0.02), rng.range(-0.02, 0.02), rng.range(-0.025, 0.025)));
    }
  }
  for (const [p0, p1] of [[V(PX0, Y - 0.2, PZ0), V(PX1, Y - 0.2, PZ0)], [V(PX0, Y - 0.2, PZ1), V(PX1, Y - 0.2, PZ1)], [V(PX0, Y - 0.2, PZ0), V(PX0, Y - 0.2, PZ1)], [V(PX1, Y - 0.2, PZ0), V(PX1, Y - 0.2, PZ1)]]) {
    b.beam(p0, p1, 0.2, 0.26, postC, UP);
  }
  for (const x of [PX0 + 0.2, (PX0 + PX1) / 2, PX1 - 0.2]) for (const z of [PZ0 + 0.2, Z, PZ1 - 0.2]) {
    b.cyl(V(x + rng.range(-0.1, 0.1), -1.9, z), V(x, Y - 0.14, z), 0.16, 0.15, postC, 6, true);
  }
  railing(b, V(PX0 + 0.12, Y, PZ0 + 0.12), V(PX0 + 0.12, Y, Z - 1.4), 2, XA.clone().negate(), rng, wc, { gap: 0.1 });
  railing(b, V(PX0 + 0.12, Y, Z + 1.4), V(PX0 + 0.12, Y, PZ1 - 0.12), 2, XA.clone().negate(), rng, wc, { gap: 0.1 });
  railing(b, V(PX0 + 0.12, Y, PZ0 + 0.12), V(PX1 - 0.12, Y, PZ0 + 0.12), 4, ZA.clone().negate(), rng, wc);
  railing(b, V(PX0 + 0.12, Y, PZ1 - 0.12), V(PX1 - 0.12, Y, PZ1 - 0.12), 4, ZA, rng, wc);
  railing(b, V(PX1 - 0.12, Y, PZ0 + 0.12), V(PX1 - 0.12, Y, Z - 1.3), 2, XA, rng, wc, { gap: 0.3 });
  railing(b, V(PX1 - 0.12, Y, Z + 1.35), V(PX1 - 0.12, Y, PZ1 - 0.12), 2, XA, rng, wc, { gap: 0.3 });
  // greenery reclaiming the boards
  b.cyl(V(1.9, Y - 0.1, 11.7), V(1.6, Y + 2.3, 11.95), 0.09, 0.07, PAL.wood, 5, false);
  for (const o of [V(1.6, 2.5, 11.95), V(1.2, 2.0, 11.6), V(2.1, 2.1, 12.3), V(1.7, 1.4, 11.4)]) clump(vb, o.add(V(0, Y, 0)), 0.65, 15, rng, 1.2, 0.35);
  clump(vb, V(9.9, Y + 0.35, 12.0), 0.7, 18, rng, 1.2, 0.3);
  clump(vb, V(1.5, Y + 0.3, 4.2), 0.6, 14, rng, 1.2, 0.3);
  clump(vb, V(40.2, Y + 0.2, Z - 1.05), 0.5, 10, rng, 1.1, 0.3);
  clump(vb, V(22.7, Y + 0.2, Z - 1.1), 0.45, 9, rng, 1.1, 0.3);
  for (const x of [57, 33, 18]) strand(vb, V(x, Y + 0.95, Z + 1.32), rng.range(1.0, 1.8), rng, 1.1);
}

function buildSmallThings(b, fb, vb, rng, lampBase) {
  // bench facing the pond
  {
    const x = 68.6, z = 12.6, y = heightAt(x, z);
    b.xf.compose(V(x, y - 0.05, z), quatE(0, -Math.PI / 2 + 0.15, 0.04), V(1, 1, 1));
    const slat = mixc(PAL.verm, PAL.cream, 0.3), iron = mulc(LAMP_IRON, 0.9);
    b.box(V(0, 0.46, 0), 1.8, 0.12, 0.5, slat);
    b.box(V(0, 0.8, -0.25), 1.8, 0.34, 0.14, slat, quatE(-0.18, 0, 0));
    for (const sx of [-0.78, 0.78]) { b.box(V(sx, 0.22, 0), 0.14, 0.46, 0.48, iron); b.box(V(sx, 0.66, -0.25), 0.14, 0.52, 0.14, iron); }
    b.xf.identity();
    clump(vb, V(x - 0.3, y + 0.2, z + 0.9), 0.5, 10, rng, 1.1, 0.3);
  }
  // crooked signpost
  {
    const x = 64.4, z = 11.6, y = heightAt(x, z);
    b.xf.compose(V(x, y - 0.3, z), quatE(0.12, 0.3, -0.07), V(1, 1, 1));
    b.box(V(0, 1.3, 0), 0.15, 2.6, 0.15, mulc(PAL.wood, 1.1));
    b.box(V(0.38, 2.3, 0), 0.95, 0.26, 0.09, PAL.cream, quatE(0, 0, 0.06));
    b.box(V(0.4, 2.3, 0.02), 0.3, 0.12, 0.08, PAL.teal);
    b.box(V(-0.3, 1.94, 0), 0.85, 0.24, 0.09, mixc(PAL.mustard, PAL.cream, 0.2), quatE(0, 0.9, -0.1));
    b.xf.identity();
  }
  // old bicycle leaning on the entrance lamp
  {
    const x = lampBase.x + 0.1, z = lampBase.z + 0.42, y = heightAt(x, z);
    fb.xf.compose(V(x, y - 0.04, z), quatE(-0.3, 0.12, 0), V(1, 1, 1));
    const frame = mixc(PAL.verm, PAL.cream, 0.2), tyre = PAL.dark;
    for (const wx of [-0.52, 0.52]) fb.geo(T_TORUS, _M2.makeTranslation(wx, 0.34, 0), tyre);
    const bb = V(-0.05, 0.36, 0), seat = V(-0.2, 0.86, 0), head = V(0.38, 0.86, 0);
    for (const [p, q] of [[bb, seat], [seat, head], [bb, head], [bb, V(-0.52, 0.34, 0)], [seat, V(-0.52, 0.34, 0)], [head, V(0.52, 0.34, 0)], [head, V(0.36, 1.02, 0)]]) fb.cyl(p, q, 0.055, 0.055, frame, 5, true);
    fb.cyl(V(0.36, 1.02, -0.27), V(0.36, 1.02, 0.27), 0.05, 0.05, PAL.dark, 5, true);
    fb.box(V(-0.22, 0.92, 0), 0.28, 0.08, 0.14, PAL.dark);
    fb.box(V(0.56, 0.62, 0), 0.26, 0.2, 0.3, mixc(PAL.mustard, PAL.cream, 0.3));        // little basket
    fb.xf.identity();
  }
}

// utility poles crossing the south meadow, wires sagging between them
function buildPoles(b, fb, vb, rng) {
  const A = [150, 95], B = [-70, 130], N = 9;
  const dx = B[0] - A[0], dz = B[1] - A[1], L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L, px = -uz, pz = ux;
  const poleC = mulc(PAL.wood, 1.05), barC = mulc(PAL.woodGrey, 0.95), ceramic = mixc(PAL.blue, PAL.cream, 0.4);
  const attach = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1), j1 = rng.range(-3, 3), j2 = rng.range(-2, 2);
    const x = A[0] + dx * t + px * j1 + ux * j2, z = A[1] + dz * t + pz * j1 + uz * j2, y = heightAt(x, z) - 0.4;
    const H = rng.range(7.8, 9.2);
    const yaw = Math.atan2(-pz, px) + rng.range(-0.08, 0.08);
    const lean = new THREE.Quaternion().setFromAxisAngle(V(rng.range(-1, 1), 0, rng.range(-1, 1)).normalize(), rng.range(0.02, 0.11));
    b.xf.compose(V(x, y, z), lean.multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw)), V(1, 1, 1));
    b.cyl(V(0, 0, 0), V(0, H, 0), 0.19, 0.14, poleC, 7, true);
    b.box(V(0, H - 0.45, 0), 2.5, 0.16, 0.2, barC, quatE(0, 0, rng.range(-0.06, 0.06)));
    for (const sx of [-1, 1]) b.beam(V(sx * 0.75, H - 0.5, 0.12), V(0, H - 1.25, 0.12), 0.12, 0.12, barC, ZA);
    if (rng() < 0.45) b.box(V(0, H - 1.45, 0), 1.6, 0.14, 0.18, barC);
    const pts = [];
    for (const ox of [-1.05, -0.4, 1.05]) {
      b.cyl(V(ox, H - 0.37, 0), V(ox, H - 0.1, 0), 0.08, 0.06, ceramic, 6, true);
      pts.push(V(ox, H - 0.12, 0).applyMatrix4(b.xf));
    }
    if (i === 3) {                                            // a little transformer can
      b.cyl(V(0, H - 2.9, 0.42), V(0, H - 2.0, 0.42), 0.3, 0.3, mixc(PAL.steel, PAL.blue, 0.3), 8, true);
      b.box(V(0, H - 2.45, 0.2), 0.14, 0.5, 0.2, barC);
    }
    if (i === 2 || i === 6) {                                 // ivy climbing the pole
      const m = b.xf.clone();
      for (let k = 0; k < 5; k++) clump(vb, V(rng.range(-0.15, 0.15), 0.6 + k * 0.7, rng.range(-0.15, 0.15)).applyMatrix4(m), 0.45, 9, rng, 1.1, 0.2);
      strand(vb, V(0.9, H - 0.6, 0).applyMatrix4(m), 2.2, rng, 1.1);
    }
    b.xf.identity();
    attach.push(pts);
  }
  const wireC = mixc(PAL.dark, PAL.steel, 0.2);
  const wire = (a, c, sag, steps = 18) => {
    const pts = [];
    for (let i = 0; i <= steps; i++) { const t = i / steps; const p = a.clone().lerp(c, t); p.y -= sag * 4 * t * (1 - t); pts.push(p); }
    ribbon(pts);
  };
  const ribbon = (pts, w = 0.09) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      const d = V().subVectors(q, p).normalize(), side = V(-d.z, 0, d.x).normalize();
      const hw = w / 2;
      fb.quad(p.clone().add(V(0, -hw, 0)), q.clone().add(V(0, -hw, 0)), q.clone().add(V(0, hw, 0)), p.clone().add(V(0, hw, 0)), wireC, side);
      fb.quad(p.clone().addScaledVector(side, -hw), q.clone().addScaledVector(side, -hw), q.clone().addScaledVector(side, hw), p.clone().addScaledVector(side, hw), wireC, UP);
    }
  };
  for (let i = 0; i < N - 1; i++) {
    for (let w = 0; w < 3; w++) {
      if (i === 5 && w === 0) {                               // snapped wire dangling into the grass
        const a = attach[i][w], g = a.clone().add(V(ux * 2.5 + px * 0.6, 0, uz * 2.5 + pz * 0.6));
        g.y = heightAt(g.x, g.z) + 0.05;
        const pts = [];
        for (let k = 0; k <= 12; k++) { const t = k / 12; const p = a.clone().lerp(g, t); p.y = a.y + (g.y - a.y) * Math.pow(t, 0.55); pts.push(p); }
        const tail = g.clone().add(V(ux * 2.2, 0, uz * 2.2 + 0.6)); tail.y = heightAt(tail.x, tail.z) + 0.05;
        pts.push(tail);
        ribbon(pts);
        continue;
      }
      wire(attach[i][w], attach[i + 1][w], rng.range(0.9, 1.5));
    }
  }
}

// far, hazy wind turbines on the western ridge
function buildTurbines(rng) {
  const tb = new Builder({ aHub: 3, aAxis: 3, aSpin: 2 });
  const spots = [[-300, -235, 82], [-345, -150, 92], [-318, -58, 74], [-362, 32, 95], [-330, 118, 78], [-296, 203, 86]];
  const periods = [11.5, 0, 9.6, 13.4, 0, 10.4];       // 0 = stopped
  const white = PAL.white;
  spots.forEach(([x, z, H], i) => {
    const y0 = heightAt(x, z) - 2;
    const yaw = rng.range(-0.25, 0.25), A = V(0.92, 0, 0.39).normalize().applyAxisAngle(UP, yaw);
    const top = V(x, y0 + H, z);
    const hub = top.clone().addScaledVector(A, H * 0.085).add(V(0, H * 0.004, 0));
    const omega = periods[i] ? -TAU / periods[i] : 0;
    const ph = rng() * TAU;
    tb.cur.aHub = [hub.x, hub.y, hub.z]; tb.cur.aAxis = [A.x, A.y, A.z]; tb.cur.aSpin = [0, 0];
    tb.cyl(V(x, y0, z), top, H * 0.021, H * 0.0115, white, 8, false);
    tb.beam(top.clone().addScaledVector(A, -H * 0.045).add(V(0, -H * 0.012, 0)), top.clone().addScaledVector(A, H * 0.07).add(V(0, -H * 0.012, 0)), H * 0.032, H * 0.034, white, UP);
    tb.cur.aSpin = [omega, ph];
    tb.cyl(hub.clone().addScaledVector(A, -H * 0.012), hub.clone().addScaledVector(A, H * 0.04), H * 0.022, H * 0.005, white, 8, true);
    for (let k = 0; k < 3; k++) {
      if (i === 1 && k === 2) continue;                      // lost a blade
      const dir = UP.clone().applyAxisAngle(A, (k / 3) * TAU + (i === 4 ? 0.5 : 0));
      const chord = V().crossVectors(dir, A).normalize();
      const root = hub.clone().addScaledVector(dir, H * 0.015), Lb = H * 0.43;
      _M2.makeBasis(chord.multiplyScalar(H * 0.028), dir.clone().multiplyScalar(Lb), A.clone().multiplyScalar(H * 0.006)).setPosition(root);
      tb.geo(T_CYL(4, 0.28, true), _M2, white);
    }
  });
  return tb;
}

// ------------------------------------------------------------------------------------------------
export default async function create(world) {
  const pipeline = world.pipeline;
  const rng = makeRng(4207);
  const group = new THREE.Group();
  group.name = 'props';

  const lightData = new Float32Array(LIGHT_TEX_W);
  const lightTex = new THREE.DataTexture(lightData, LIGHT_TEX_W, 1, THREE.RedFormat, THREE.FloatType);
  lightTex.minFilter = lightTex.magFilter = THREE.NearestFilter;
  lightTex.generateMipmaps = false;
  lightTex.needsUpdate = true;

  const wheelGroup = new THREE.Group();
  wheelGroup.position.set(WHEEL.x, WHEEL.radius - WHEEL.sink, WHEEL.z);
  wheelGroup.rotation.set(TILT_X, 0, TILT_Z);
  group.add(wheelGroup);
  wheelGroup.updateMatrixWorld(true);

  const shared = {
    uWheelAngle: { value: 0 }, uTiltX: { value: TILT_X }, uTiltZ: { value: TILT_Z },
    uLightTex: { value: lightTex }, uBulbBase: { value: BULB_BASE }, uWheelMatrix: { value: wheelGroup.matrixWorld },
  };
  const wheelMat = relicMaterial({ name: 'relic-wheel', moss: 0.45, rust: 0.45, mask: 0.55, defines: { WHEEL: 1, LIGHTS: 1 }, uniforms: shared });
  const staticMat = relicMaterial({ name: 'relic-static', moss: 0.5, rust: 0.4, mask: 0.85, defines: { LIGHTS: 1 }, uniforms: shared });
  const fineMat = relicMaterial({ name: 'relic-fine', moss: 0.15, rust: 0.5, mask: 0.35, side: THREE.DoubleSide, uniforms: shared });
  const turbMat = relicMaterial({ name: 'relic-turbine', moss: 0, rust: 0.12, mask: 1, wobble: 0.05, defines: { TURBINE: 1 } });
  const vineMat = vineMaterial(shared);
  const glowMat = glowMaterial(shared);

  // --- the wheel
  const { wb, vb: wheelVines, bulbs } = buildWheel(rng);

  // --- lamps, jetty, booth, poles, small things
  const sb = new Builder({ aLight: 1 });
  const svb = new Builder({ aPivot: 3, aMode: 1, aSway: 2 });
  const fb = new Builder({});
  const lamps = [];                       // { glow: Vector3 (world), kind, broken, power }
  const placeLamp = (kind, pos, yaw, lean, tall, opts = {}) => {
    const idx = lamps.length;
    sb.xf.compose(pos, lean.clone().multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw)), V(1, 1, 1));
    const g = (tall ? tallLamp : shortLamp)(sb, idx).applyMatrix4(sb.xf);
    const m = sb.xf.clone();
    sb.xf.identity();
    lamps.push({ glow: g, kind, broken: !!opts.broken, power: opts.power ?? 1, base: pos.clone() });
    return m;
  };
  // promenade lamps, far end first
  const segs = [];
  let total = 0;
  for (let i = 0; i < PATH.length - 1; i++) {
    const [ax, az] = PATH[i], [bx, bz] = PATH[i + 1], l = Math.hypot(bx - ax, bz - az);
    segs.push({ ax, az, dx: (bx - ax) / l, dz: (bz - az) / l, l, s0: total }); total += l;
  }
  const pathAt = (s) => { let g = segs[segs.length - 1]; for (const q of segs) if (s <= q.s0 + q.l) { g = q; break; } const u = s - g.s0; return { x: g.ax + g.dx * u, z: g.az + g.dz * u, dx: g.dx, dz: g.dz }; };
  let k = 0;
  for (let s = 4; s < total; s += 13, k++) {
    const p = pathAt(s), side = k % 2 ? -1 : 1, nx = -p.dz * side, nz = p.dx * side;
    const x = p.x + nx * 2.6, z = p.z + nz * 2.6;
    if (shoreDist(x, z) < 2.5) continue;
    const yaw = Math.atan2(nz, -nx);                  // neck reaches back over the path
    const fallen = k === 3;
    let lean = new THREE.Quaternion();
    if (fallen) lean.setFromAxisAngle(V(p.dx, 0, p.dz), 1.47 * side);
    else if (rng() < 0.5) lean.setFromAxisAngle(V(rng.range(-1, 1), 0, rng.range(-1, 1)).normalize(), rng.range(0.03, 0.1));
    else lean.setFromAxisAngle(XA, rng.range(-0.015, 0.015));
    const y = heightAt(x, z) + (fallen ? 0.22 : -0.08);
    const m = placeLamp('path', V(x, y, z), yaw, lean, true, { broken: fallen, power: k === 5 ? 0.6 : 1 });
    if (!fallen && rng() < 0.45) strand(svb, V(0.35, 4.35, 0).applyMatrix4(m), rng.range(1.0, 2.0), rng, 1.05);
    if (rng() < 0.6 || fallen) clump(svb, V(0, 0.45, 0).applyMatrix4(m), 0.55, 11, rng, 1.15, 0.25);
  }
  // entrance lamp at the jetty head (on land)
  const entrance = V(66.3, 0, 5.4); entrance.y = heightAt(entrance.x, entrance.z) - 0.08;
  placeLamp('entrance', entrance, Math.atan2(-1, 0), new THREE.Quaternion().setFromAxisAngle(XA, -0.05), true);
  // four short lamps on posts along the jetty, alternating sides
  [[58, -1], [47, 1], [36, -1], [25, 1]].forEach(([x, s]) => {
    const z = JETTY.z + s * 1.4;
    sb.cyl(V(x, -1.9, z), V(x, JETTY.y + 0.05, z), 0.15, 0.14, mulc(PAL.wood, 0.85), 6, true);
    placeLamp('jetty', V(x, JETTY.y, z), 0, new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0.3).normalize(), s * rng.range(0.02, 0.06)), false);
  });
  // ticket booth with its two lamps
  const BOOTH = { x: 7.6, z: 5.0 };
  buildBooth(sb, BOOTH.x, BOOTH.z);
  for (const x of [6.0, 9.2]) placeLamp('booth', V(x, JETTY.y, 6.3), 0, new THREE.Quaternion().setFromAxisAngle(ZA, (x - 7.6) * 0.02), false);
  buildJetty(sb, svb, rng);
  buildSmallThings(sb, fb, svb, rng, entrance);
  buildPoles(sb, fb, svb, rng);
  const tb = buildTurbines(rng);
  const nL = lamps.length;

  // --- meshes
  const mk = (geo, mat, parent, opts) => {
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    parent.add(m);
    register(pipeline, m, opts);
    return m;
  };
  mk(wb.build(), wheelMat, wheelGroup, { cast: true, reflect: true });
  mk(wheelVines.build(), vineMat, wheelGroup, { cast: true, reflect: true });
  mk(sb.build(), staticMat, group, { cast: true, reflect: true });
  mk(svb.build(), vineMat, group, { cast: true, reflect: true });
  mk(fb.build(), fineMat, group, { cast: false, reflect: true });
  mk(tb.build(), turbMat, group, { cast: false, reflect: true });

  // --- glow sprites: one instanced batch for every lamp and bulb
  const iPos = [], iData = [], iCol = [];
  lamps.forEach((l, i) => {
    if (l.broken) return;
    iPos.push(l.glow.x, l.glow.y, l.glow.z); iData.push(1.3, 3.5, i, 0); iCol.push(...mulc(GLASS, 0.5));
  });
  bulbs.forEach((b, j) => { iPos.push(b.p.x, b.p.y, b.p.z); iData.push(0.5, 1.15, BULB_BASE + j, 1); iCol.push(...b.c); });
  const quad = new THREE.PlaneGeometry(2, 2);
  const gg = new THREE.InstancedBufferGeometry();
  gg.index = quad.index;
  gg.setAttribute('position', quad.getAttribute('position'));
  gg.setAttribute('normal', quad.getAttribute('normal'));
  gg.setAttribute('uv', quad.getAttribute('uv'));
  gg.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(iPos), 3));
  gg.setAttribute('iData', new THREE.InstancedBufferAttribute(new Float32Array(iData), 4));
  gg.setAttribute('iCol', new THREE.InstancedBufferAttribute(new Float32Array(iCol), 3));
  gg.instanceCount = iPos.length / 3;
  const glow = mk(gg, glowMat, group, { cast: false, reflect: true });
  glow.renderOrder = 10;

  // --- lights
  let external = false, lastL = -1, lastW = -1;
  const lampLevel = (i, p) => {
    const l = lamps[i];
    const q = p * (nL + 1) - (i + 1);
    if (q <= 0 || l.broken) return 0;
    if (q >= 0.25) return l.power;
    const f = q / 0.25, step = Math.floor(f * 10);
    const pattern = [1, 0, 0.15, 1, 0, 1, 0.3, 1, 0, 1];
    return pattern[(step + i * 3) % 10] * (0.55 + 0.45 * f) * l.power;
  };
  const applyLights = (L, W) => {
    L = clamp01(L); W = clamp01(W);
    if (L === lastL && W === lastW) return;
    lastL = L; lastW = W;
    for (let i = 0; i < nL; i++) lightData[i] = lampLevel(i, L);
    for (let j = 0; j < bulbs.length; j++) lightData[BULB_BASE + j] = clamp01((W - bulbs[j].order) / 0.035);
    lightTex.needsUpdate = true;
  };
  applyLights(0, 0);

  return {
    group,
    update(t, camera, state) {
      if (!external) {
        const n = U.uNight.value;
        let v = clamp01((n - 0.2) / 0.6); v = v * v * (3 - 2 * v);
        if (state && state.tod > 2.5) v = 1;
        applyLights(v, v);
      }
    },
    // lamps 0..1: progress along the lamp order (far promenade end → booth); wheel 0..1: hub → spokes → rim sweep
    setLights({ lamps: L = 0, wheel: W = 0 } = {}) { external = true; applyLights(L, W); },
    setWheelAngle(rad) { shared.uWheelAngle.value = rad; },
    lamps: lamps.map((l) => ({ pos: [l.glow.x, l.glow.y, l.glow.z], base: [l.base.x, l.base.y, l.base.z], kind: l.kind, broken: l.broken })),
    bulbCount: bulbs.length,
    hub: [WHEEL.x, WHEEL.radius - WHEEL.sink, WHEEL.z],
    spots: { jetty: [30, JETTY.y, JETTY.z], platform: [3, JETTY.y, JETTY.z], booth: [BOOTH.x, JETTY.y, BOOTH.z], platformEnd: [1, JETTY.y, JETTY.z] },
  };
}
