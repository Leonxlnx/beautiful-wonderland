import * as THREE from 'three';
import { paintMaterial } from '../../core/materials.js';
import { SHADOW, TOON } from '../../core/glsl.js';
import { hex } from '../../core/env.js';
import { makeRng, valueNoise2, fbm2, smoothstep } from '../../core/rng.js';
import { GROUND_GLSL, terrainUniforms } from '../terrain.js';
import { TERRAIN_SIZE, FOREST, PATH, heightAt, shoreDist, pathDist, forestAmount } from '../layout.js';

// Grass tufts and wildflowers: instanced painted blades and colour dabs over the meadows.
// Every blade is one flat stroke (dark cool foot, bright upper part) lit as a whole from its root, so
// tufts read as chunky painted clumps. Wind (travelling gust fronts + per-blade flutter) is a pure
// function of uTime. Instances are split into 40 m chunks; each chunk is drawn in a random order so
// that drawing only the first k instances thins it evenly with distance.

export const GRASS = {
  blades: 800000,           // blades at quality.density = 1
  flowers: 90000,           // flowering plants at quality.density = 1 (lupin spikes add 3 dabs each)
  cell: 40,                 // chunk size, metres
  extent: 262,              // half-size of the planted square around the pond
  site: 0.7,                // spacing of tuft sites
  flowerSite: 0.6,          // spacing of flower sites
  // x, z, radius, relative density — fading out at the rim
  zones: [
    [58, 12, 70, 1.0],      // jetty / east shore
    [75, 60, 80, 1.0],      // south-east meadow (the film opens here)
    [-112, -74, 75, 1.0],   // kite hill incl. its top
    [-48, 14, 45, 0.8],     // west shore near the wheel
    [88, -58, 55, 0.7],     // promenade
    [70, -118, 35, 0.5],    // forest glade
  ],
  scatter: 0.12, scatterRadius: 260,     // thin scatter everywhere
  clearings: [],                         // [x, z, radius]: keep these spots free of grass and flowers (props, trunks)
  lodKeep: 42, lodPower: 1.3,            // blades kept = min(1, (lodKeep / dist) ^ lodPower)
  lodMinPx: 3.0,                         // far blades are widened to this many 1080p-pixels
  lodFarGeo: 50,                         // chunks further than this use the 5-vertex blade
  flowerKeep: 65, flowerPower: 1.3, flowerMinPx: 3.2,
};

export const FLOWERS = [
  // petal colour, lobe depth (0 = round blob, .5 = deep petals), centre colour, centre radius
  { name: 'poppy', col: 0xf0562e, lobe: 0.1, ctr: 0x3a1d3c, ctrR: 0.27 },
  { name: 'daisy', col: 0xfffcf2, lobe: 0.26, ctr: 0xffd84a, ctrR: 0.43 },
  { name: 'pink', col: 0xff7fb0, lobe: 0.16, ctr: 0xffd6e4, ctrR: 0.36 },
  { name: 'lupin', col: 0x8a5fd0, lobe: 0.12, ctr: 0xb695ee, ctrR: 0.5 },
  { name: 'yellow', col: 0xffd84a, lobe: 0.2, ctr: 0xffa62e, ctrR: 0.38 },
];

// ------------------------------------------------------------------------------------------ shaders

const WIND_GLSL = /* glsl */ `
uniform vec4 uGrassWind;    // steady lean, gust lean, flutter, gust sheen
// tip bend (radians, as a direction on xz) of a stem rooted at 'root': steady breeze + gust front + flutter
vec2 windBend(vec2 root, vec4 rnd, float gust, float stiff){
  float ph = rnd.x * 6.2832;
  float flut = sin(uTime * (2.3 + 2.4 * rnd.y) + ph) * (.35 + .65 * gust)
             + .45 * sin(uTime * 1.3 + dot(root, vec2(.31, .23)));
  float side = sin(uTime * (1.7 + 1.9 * rnd.z) + ph * 1.7) * (.4 + .6 * gust);
  float fl = uGrassWind.z * (.3 + .7 * uWind.z);      // flutter follows the wind strength
  return (uWind.xy * (uGrassWind.x * uWind.z + uGrassWind.y * gust + fl * flut)
        + vec2(-uWind.y, uWind.x) * (fl * .6 * side)) * stiff;
}
// point at fraction f along a stem of length H that bends by 'bend' at its tip (length preserving arc:
// the sideways offset grows with the square of the height)
vec3 stemPoint(vec3 root, vec2 bend, float H, float f){
  float phi = length(bend);
  vec2 bd = bend / max(phi, 1e-4);
  float ps = max(phi / (1. + .4 * phi), 1e-3);
  float a = ps * f;
  return root + vec3(bd.x, 0., bd.y) * (H * (1. - cos(a)) / ps) + vec3(0., H * sin(a) / ps, 0.);
}
// the light the ground gets at this spot: terminator on the ground normal, cast shadow, drifting cloud shade
float rootLight(vec3 root, vec4 rnd, float lift){
  float e = 1.6;
  float hx = terrainInfo(root.xz + vec2(e, 0.)).r - terrainInfo(root.xz - vec2(e, 0.)).r;
  float hz = terrainInfo(root.xz + vec2(0., e)).r - terrainInfo(root.xz - vec2(0., e)).r;
  vec3 gn = normalize(vec3(-hx, 2. * e, -hz));
  float lit = paintBand(dot(gn, uSunDir) + lift + (rnd.w - .5) * .1, .1, .03);
  float sh = smoothstep(.35, .65, getShadow(root + vec3(0., .22, 0.), (rnd.xy - .5) * .3));
  vec2 cq = root.xz + uWind.xy * uTime * 2.2;
  float cloud = smoothstep(.5, .62, fbm(cq * .0075 + 4.) + (rnd.z - .5) * .05);
  return lit * sh * (1. - cloud * .62);
}
`;

function bladeMaterial(uniforms) {
  return paintMaterial({
    name: 'grass', side: THREE.DoubleSide, uniforms,
    vertexPars: /* glsl */ `
      ${SHADOW}${TOON}${GROUND_GLSL}${WIND_GLSL}
      attribute vec4 aRoot;     // root xyz, draw rank 0..1
      attribute vec4 aBlade;    // height, width (negative: seed-head stalk), static lean xz (tip angle)
      uniform float uPx1080;    // angle of one 1080p pixel
      uniform vec4 uGrassLod;   // keep distance, falloff power, min width in 1080p pixels, settle distance
      uniform vec4 uGrassTone;  // foot darkening, tip mix, tone jitter, sun translucency
      varying vec3 vLow; varying vec3 vHigh; varying vec2 vBV;
    `,
    vertexMain: `nrm = vec3(0., 1., 0.);`,
    vertexWorld: /* glsl */ `
      vec3 root = aRoot.xyz;
      vec3 toCam = uCamPos - root;
      float dist = length(toCam);
      float keep = min(1., pow(uGrassLod.x / max(dist, 1.), uGrassLod.y));
      float grow = clamp((keep * 1.3 - aRoot.w) / (keep * .3), 0., 1.) * smoothstep(.35, 1.3, dist);
      wn = vec3(0., 1., 0.);
      if (grow <= 0.){
        wp = vec4(root, 1.); vLow = vec3(0.); vHigh = vec3(0.); vBV = vec2(0.);
      } else {
        vec4 rnd = hash42(root.xz * 37.13 + 3.7);
        float v = position.y, side = position.x;
        bool stalk = aBlade.y < 0.;
        // outline: broad tapered strip, or a thin stalk carrying a spindle-shaped seed head
        float lv = v < .2 ? 0. : (v < .4 ? 1. : (v < .5 ? 2. : (v < .9 ? 3. : 4.)));
        float hw, vv = v;
        if (stalk){
          vv = lv < .5 ? 0. : (lv < 1.5 ? .83 : (lv < 3.5 ? .9 : 1.));
          hw = lv < 1.5 ? .32 : (lv < 3.5 ? 1. : 0.);
        } else {
          hw = lv < .5 ? 1. : (lv < 1.5 ? .95 : (lv < 2.5 ? .86 : (lv < 3.5 ? .62 : 0.)));
        }
        float H = aBlade.x * grow;
        float W = max(abs(aBlade.y), dist * uPx1080 * uGrassLod.z * (stalk ? 1.5 : 1.));
        float gust = gustAt(root.xz);
        vec2 bend = aBlade.zw + windBend(root.xz, rnd, gust, stalk ? .55 : 1.);
        vec3 p = stemPoint(root, bend, H, vv);
        // the flat side mostly faces the lens, so strokes never thin out to wires
        vec2 cr = normalize(vec2(-toCam.z, toCam.x) + vec2(1e-4, 0.));
        float tw = (rnd.z - .5) * 1.5, ct = cos(tw), st = sin(tw);
        p.xz += vec2(cr.x * ct - cr.y * st, cr.x * st + cr.y * ct) * (side * .5 * hw * W);
        wp = vec4(p, 1.);

        // paint: the ground's own colour, darker and cooler at the foot, tip colour above
        vec3 g = groundStudy(root.xz);
        float tone = 1. + (rnd.w - .5) * uGrassTone.z + (hash12(floor(root.xz * .8) + 11.) - .5) * uGrassTone.z * .6;
        vec3 low = g * mix(vec3(1.), vec3(.68, .83, .88), uGrassTone.x) * tone;
        float light = rootLight(root, rnd, .07);
        vec3 high = mix(g, uGrassTip, uGrassTone.y * (.35 + .65 * mix(1., light, uSunAmt))) * tone;
        if (stalk) high = mix(uGrassTip, uGrassC, .55) * 1.03;
        vec2 vh = normalize(-toCam.xz + vec2(1e-4, 0.)), sunH = normalize(uSunDir.xz + vec2(1e-4, 0.));
        float back = pow(max(dot(vh, sunH), 0.), 2.) * light * uSunAmt;
        vec3 cl = paintLight(low, light, 0.);
        vec3 ch = paintLight(high, light, light * clamp(gust * uGrassWind.w * .75 + back * .3, 0., 1.));
        ch += vec3(.12, .08, -.03) * back * uGrassTone.w;                      // sun through the blades
        ch = mix(ch, ch * 1.12 + vec3(.035, .04, 0.) * uSunAmt, gust * uGrassWind.w);    // sheen where a gust passes
        cl *= 1. + .05 * gust;
        vec3 cool = vec3(-.012, .012, .04) * (1. - light) * (1. - uNight);
        cl += cool; ch += cool * .6;
        // far tufts settle into the ground paint
        float far = smoothstep(uGrassLod.w * .3, uGrassLod.w, dist);
        vec3 cg = paintLight(g * tone, light, 0.);
        cl = mix(cl, cg, far * .7); ch = mix(ch, cg, far * .45);
        vLow = cl; vHigh = ch;
        vBV = vec2(vv + side * (rnd.y - .5) * .14, stalk ? .85 : .28 + .42 * rnd.x - .26 * gust * uGrassWind.w);
      }
    `,
    fragmentPars: `varying vec3 vLow; varying vec3 vHigh; varying vec2 vBV;`,
    fragmentMain: /* glsl */ `
      float fw = max(fwidth(vBV.x), 1e-4);
      vec3 col = mix(vLow, vHigh, smoothstep(vBV.y - fw, vBV.y + fw, vBV.x));
      paintOut(applyHaze(col, vW), 1., 1.);
    `,
  });
}

function flowerMaterial(uniforms) {
  return paintMaterial({
    name: 'flowers', side: THREE.DoubleSide, uniforms,
    vertexPars: /* glsl */ `
      ${SHADOW}${TOON}${GROUND_GLSL}${WIND_GLSL}
      attribute vec4 aRoot;       // plant root xyz, draw rank 0..1
      attribute vec4 aFlower;     // plant height, dab position along the stem 0..1, dab size (negative: no stem), kind
      uniform float uPx1080;
      uniform vec4 uFlowerLod;    // keep distance, falloff power, min dab size in 1080p pixels, stem fade distance
      uniform vec4 uFlowerCol[${FLOWERS.length}];   // petal rgb, lobe depth
      uniform vec4 uFlowerCtr[${FLOWERS.length}];   // centre rgb, centre radius
      uniform float uFlowerGlow;
      varying vec3 vPetal; varying vec3 vCtr; varying vec2 vFR;
    `,
    vertexMain: `nrm = vec3(0., 1., 0.);`,
    vertexWorld: /* glsl */ `
      vec3 root = aRoot.xyz;
      vec3 toCam = uCamPos - root;
      float dist = length(toCam);
      float keep = min(1., pow(uFlowerLod.x / max(dist, 1.), uFlowerLod.y));
      float grow = clamp((keep * 1.3 - aRoot.w) / (keep * .3), 0., 1.) * smoothstep(.35, 1.2, dist);
      wn = vec3(0., 1., 0.);
      if (grow <= 0.){
        wp = vec4(root, 1.); vPetal = vec3(0.); vCtr = vec3(0.); vFR = vec2(0.);
      } else {
        vec4 rnd = hash42(root.xz * 41.7 + 9.1);
        int kind = int(aFlower.w + .5);
        vec4 fc = uFlowerCol[kind], cc = uFlowerCtr[kind];
        bool head = position.z > .5;
        float H = aFlower.x * (.5 + .5 * grow);
        float gust = gustAt(root.xz);
        vec2 bend = (rnd.zw - .5) * .5 + windBend(root.xz, rnd, gust, .85);
        vec3 c = stemPoint(root, bend, H, aFlower.y * (head ? 1. : position.y));
        vec3 fwd = normalize(uCamPos - c);
        vec3 right = normalize(cross(vec3(0., 1., 0.), fwd) + vec3(1e-5, 0., 0.));
        vec3 up = cross(fwd, right);
        float r = 2.;
        if (head){
          float sMin = dist * uPx1080 * uFlowerLod.z;
          float size = max(abs(aFlower.z), sMin) * grow;
          if (aFlower.z < 0.) size *= 1. - smoothstep(.5, 1.1, sMin / abs(aFlower.z));
          float rot = rnd.x * 6.2832, cr = cos(rot), sr = sin(rot);
          vec2 q = position.xy * (position.z > 1.5 ? 1. - fc.w : 1.);
          q.y *= .66 + .34 * rnd.w;                               // heads tilt every which way
          q = vec2(q.x * cr - q.y * sr, q.x * sr + q.y * cr);
          c += (right * q.x + up * q.y) * (size * .5) + fwd * .02;
          r = length(position.xy);
        } else {
          float sw = (aFlower.z > 0. ? 1. : 0.) * max(.02, dist * uPx1080 * 1.6)
                   * (1. - smoothstep(uFlowerLod.w * .6, uFlowerLod.w, dist));
          c += right * (position.x * .5 * sw);
        }
        wp = vec4(c, 1.);

        float light = rootLight(root, rnd, .07);
        vec2 vh = normalize(-toCam.xz + vec2(1e-4, 0.)), sunH = normalize(uSunDir.xz + vec2(1e-4, 0.));
        float back = pow(max(dot(vh, sunH), 0.), 2.) * light * uSunAmt;
        vec3 lum = mix(vec3(.5, .48, .74), uSunTint, uSunAmt);      // accents stay a little luminous in the shade
        vec3 petal = fc.rgb * (1. + (rnd.y - .5) * .16);
        vec3 pc = mix(paintLight(petal, light, 0.), petal * lum, uFlowerGlow) + petal * back * .18;
        vec3 kc = mix(paintLight(cc.rgb, light, 0.), cc.rgb * lum, uFlowerGlow);
        if (!head){ pc = paintLight(groundStudy(root.xz) * vec3(.6, .8, .72), light, 0.); kc = pc; }
        vPetal = pc; vCtr = kc; vFR = vec2(r, cc.w);
      }
    `,
    fragmentPars: `varying vec3 vPetal; varying vec3 vCtr; varying vec2 vFR; uniform float uFlowerMask;`,
    fragmentMain: /* glsl */ `
      float fw = max(fwidth(vFR.x), 1e-4);
      vec3 col = mix(vCtr, vPetal, smoothstep(vFR.y - fw, vFR.y + fw, vFR.x));
      paintOut(applyHaze(col, vW), 1., uFlowerMask);
    `,
  });
}

// ---------------------------------------------------------------------------------------- templates

function bladeTemplates() {
  const mk = (levels) => {
    const p = [], idx = [];
    for (const v of levels) p.push(-1, v, 0, 1, v, 0);
    p.push(0, 1, 0);
    for (let k = 0; k < levels.length - 1; k++) { const b = k * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    const b = (levels.length - 1) * 2; idx.push(b, b + 1, b + 2);
    return { position: new THREE.Float32BufferAttribute(p, 3), index: new THREE.Uint16BufferAttribute(idx, 1) };
  };
  return { near: mk([0, 0.36, 0.7]), far: mk([0, 0.45]) };      // 7 and 5 vertices
}

function flowerTemplates() {
  const mk = (rim, stem) => {
    const p = [], idx = [];
    if (stem) { p.push(-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0); idx.push(0, 1, 2, 1, 3, 2); }
    const c = p.length / 3;
    p.push(0, 0, 1);
    for (let k = 0; k < rim; k++) {
      const a = (k / rim) * Math.PI * 2;
      p.push(Math.cos(a), Math.sin(a), stem && k % 2 ? 2 : 1);     // z: 1 = petal tip, 2 = notch between petals
      idx.push(c, c + 1 + k, c + 1 + ((k + 1) % rim));
    }
    return { position: new THREE.Float32BufferAttribute(p, 3), index: new THREE.Uint16BufferAttribute(idx, 1) };
  };
  return { near: mk(10, true), far: mk(6, false) };
}

// ---------------------------------------------------------------------------------------- placement

function zoneDensity(x, z) {
  let d = GRASS.scatter * (1 - smoothstep(GRASS.scatterRadius - 45, GRASS.scatterRadius, Math.hypot(x, z)));
  for (const [zx, zz, R, w] of GRASS.zones) {
    const r = Math.hypot(x - zx, z - zz);
    if (r < R) d = Math.max(d, w * (1 - smoothstep(R * 0.6, R, r)));
  }
  return d * clearing(x, z);
}
function clearing(x, z) {
  let c = 1;
  for (const [cx, cz, R] of GRASS.clearings) c *= smoothstep(R + 0.75, R + 1.35, Math.hypot(x - cx, z - cz));     // + tuft radius and site jitter
  return c;
}
// layout queries with cheap early-outs (they are evaluated at ~1.3 million candidate sites)
const PB = PATH.reduce((b, p) => [Math.min(b[0], p[0]), Math.max(b[1], p[0]), Math.min(b[2], p[1]), Math.max(b[3], p[1])], [1e9, -1e9, 1e9, -1e9]);
const pathWobble = (x, z) => (x < PB[0] - 7 || x > PB[1] + 7 || z < PB[2] - 7 || z > PB[3] + 7) ? 99
  : pathDist(x, z) + (valueNoise2(x * 0.35, z * 0.35) - 0.5) * 1.6;                          // as painted on the ground
const shoreNear = (x, z) => (x * x + z * z > 86 * 86 ? 99 : shoreDist(x, z));
const forestNear = (x, z) => (Math.hypot(x - FOREST.x, z - FOREST.z) > FOREST.r + 26 ? 0 : forestAmount(x, z));

function tuftWeight(x, z, meshH) {
  const D = zoneDensity(x, z);
  if (D <= 0 || meshH(x, z) < 0.06) return 0;
  const sd = shoreNear(x, z);
  if (sd < 0.3) return 0;
  let w = D * (0.35 + 0.65 * smoothstep(0.5, 3.2, sd));
  w *= 0.1 + 0.9 * smoothstep(2.0, 4.2, pathWobble(x, z));
  w *= 1 - 0.65 * forestNear(x, z);
  // clumps with gaps of plain painted ground between them
  const m = 0.42 * fbm2(x * 0.07 + 5.3, z * 0.07 + 9.1, 3) / 0.875 + 0.58 * valueNoise2(x * 0.4 + 1.7, z * 0.4 + 7.9);
  return w * (0.03 + 0.97 * smoothstep(0.37, 0.53, m));
}

const drift = (x, z, f, ox, oz, lo, hi) => smoothstep(lo, hi, fbm2(x * f + ox, z * f + oz, 3) / 0.875);

// probability weights of the five flower kinds at a spot; returns their sum
function flowerWeights(x, z, out) {
  out[0] = out[1] = out[2] = out[3] = out[4] = 0;
  const r0 = Math.hypot(x, z);
  if (r0 > GRASS.scatterRadius) return 0;
  const sd = shoreNear(x, z);
  if (sd < 0.6) return 0;
  const mods = (0.08 + 0.92 * smoothstep(2.2, 4.4, pathWobble(x, z))) * (1 - 0.8 * forestNear(x, z));
  const every = 1 - smoothstep(GRASS.scatterRadius - 45, GRASS.scatterRadius, r0);
  // south-east meadow and the pond shore: vermilion poppies, white daisies
  const zm = 1 - smoothstep(46, 88, Math.hypot(x - 75, z - 60));
  const shore = smoothstep(0.6, 2.5, sd) * (1 - smoothstep(7, 17, sd));
  const wM = Math.max(zm, shore * 0.75);
  if (wM > 0) {
    out[0] = wM * (0.015 + 0.55 * drift(x, z, 0.06, 31.3, 7.7, 0.53, 0.66));
    out[1] = wM * (0.03 + 0.5 * drift(x, z, 0.075, 71.9, 53.1, 0.5, 0.63));
  }
  // kite hill and its slopes: pink, purple spikes, yellow
  const zh = 1 - smoothstep(52, 94, Math.hypot(x + 112, z + 74));
  if (zh > 0) {
    out[2] = zh * (0.02 + 0.5 * drift(x, z, 0.065, 13.7, 91.3, 0.52, 0.65));
    out[3] = zh * (0.012 + 0.42 * drift(x, z, 0.08, 57.1, 23.9, 0.54, 0.66));
    out[4] = zh * (0.025 + 0.5 * drift(x, z, 0.07, 83.3, 37.7, 0.51, 0.64));
  }
  // a sprinkle of white and yellow everywhere
  out[1] += every * 0.011; out[4] += every * 0.011;
  let s = 0;
  const m = mods * clearing(x, z);
  for (let k = 0; k < 5; k++) { out[k] *= m; s += out[k]; }
  return s;
}

// scale k so that sum(min(1, k * w)) = target
function solveScale(w, target) {
  const sum = (k) => { let s = 0; for (let i = 0; i < w.length; i++) { const p = k * w[i]; s += p > 1 ? 1 : p; } return s; };
  let lo = 0, hi = 1;
  while (sum(hi) < target && hi < 4096) hi *= 2;
  for (let it = 0; it < 22; it++) { const mid = (lo + hi) / 2; if (sum(mid) < target) lo = mid; else hi = mid; }
  return hi;
}

// height of the rendered terrain mesh (not the analytic height) so roots sit exactly on the paint
function meshHeightSampler(world) {
  const pos = world.terrain?.mesh?.geometry?.attributes?.position;
  const n1 = pos ? Math.round(Math.sqrt(pos.count)) : 321, seg = n1 - 1;
  const cell = TERRAIN_SIZE / seg, half = TERRAIN_SIZE / 2;
  const h = new Float32Array(n1 * n1);
  for (let j = 0; j < n1; j++) for (let i = 0; i < n1; i++) h[j * n1 + i] = pos ? pos.getY(j * n1 + i) : heightAt(-half + i * cell, -half + j * cell);
  return (x, z) => {
    const u = (x + half) / cell, v = (z + half) / cell;
    const i = Math.max(0, Math.min(seg - 1, Math.floor(u))), j = Math.max(0, Math.min(seg - 1, Math.floor(v)));
    const fu = u - i, fv = v - j, o = j * n1 + i;
    const a = h[o], d = h[o + 1], b = h[o + n1], c = h[o + n1 + 1];
    return fu + fv <= 1 ? a + (d - a) * fu + (b - a) * fv : c + (b - c) * (1 - fu) + (d - c) * (1 - fv);
  };
}

class ChunkGrid {
  constructor() { this.map = new Map(); this.count = 0; }
  bucket(x, z) {
    const key = Math.floor((x + 4000) / GRASS.cell) * 1024 + Math.floor((z + 4000) / GRASS.cell);
    let b = this.map.get(key);
    if (!b) this.map.set(key, b = { data: [], keys: [] });
    return b;
  }
  // seven numbers per instance (root xyz + four parameters); 'key' orders the draw rank
  push(b, key, x, y, z, p0, p1, p2, p3) { b.data.push(x, y, z, p0, p1, p2, p3); b.keys.push(key); this.count++; }
}

function plantBlades(density, meshH) {
  const rng = makeRng(0x51a7e5);
  const grid = new ChunkGrid();
  const S = GRASS.site, E = GRASS.extent, n = Math.floor((2 * E) / S);
  const w = new Float32Array(n * n);
  for (let j = 0, o = 0; j < n; j++) for (let i = 0; i < n; i++, o++) w[o] = tuftWeight(-E + (i + 0.5) * S, -E + (j + 0.5) * S, meshH);
  const MEAN = 15.3;      // blades per accepted tuft site
  const k = solveScale(w, (GRASS.blades * density) / MEAN);
  let tufts = 0;
  for (let j = 0, o = 0; j < n; j++) for (let i = 0; i < n; i++, o++) {
    if (w[o] <= 0 || rng() >= k * w[o]) continue;
    const cx = -E + (i + 0.5 + (rng() - 0.5) * 0.9) * S, cz = -E + (j + 0.5 + (rng() - 0.5) * 0.9) * S;
    const rT = rng.range(0.17, 0.42);
    const sdC = shoreDist(cx, cz);
    if (sdC < 0.3 + rT || meshH(cx, cz) < 0.06) continue;                  // whole tufts only at the water's edge
    const tall = valueNoise2(cx * 0.035 + 40.5, cz * 0.035 + 17.3);       // short turf here, long grass there
    let hT = (0.3 + 0.36 * tall) * rng.range(0.85, 1.18);
    const pd = pathDist(cx, cz);
    if (pd < 5) hT *= 0.68 + 0.32 * (pd / 5);
    const nB = Math.max(5, Math.round(rng.range(11, 20) * (rT / 0.295)));
    const stalkP = 0.008 + 0.03 * tall;
    const b = grid.bucket(cx, cz);
    tufts++;
    for (let q = 0; q < nB; q++) {
      const a = rng() * 6.2832, rr = Math.sqrt(rng()), ca = Math.cos(a), sa = Math.sin(a);
      const x = cx + ca * rr * rT, z = cz + sa * rr * rT;
      let h = Math.min(0.72, Math.max(0.22, hT * (1 - 0.45 * rr * rr) * rng.range(0.72, 1.2)));     // dome: tall middle, short rim
      let wd = Math.min(0.066, rng.range(0.032, 0.058) * (0.88 + 0.45 * (h - 0.22)));
      const lean = (0.1 + 0.7 * rr) * rng.range(0.55, 1.25);                                        // blades fan outwards
      let lx = ca * lean + (rng() - 0.5) * 0.3, lz = sa * lean + (rng() - 0.5) * 0.3;
      if (rng() < stalkP) { h = rng.range(0.62, 0.92) * (0.85 + 0.3 * tall); wd = -rng.range(0.028, 0.04); lx *= 0.3; lz *= 0.3; }
      const y = meshH(x, z);
      if (y < 0.02) continue;                                                                       // never under water
      grid.push(b, 0, x, y - 0.012, z, h, wd, lx, lz);
    }
  }
  return { grid, tufts };
}

function plantFlowers(density, meshH) {
  const rng = makeRng(0xf10e25);
  const grid = new ChunkGrid();
  const S = GRASS.flowerSite, E = GRASS.extent, n = Math.floor((2 * E) / S);
  const out = [0, 0, 0, 0, 0];
  const sx = new Float32Array(n * n), szz = new Float32Array(n * n), sw = new Float32Array(n * n), sk = new Uint8Array(n * n);
  const pre = makeRng(0x2b0ca7);
  for (let j = 0, o = 0; j < n; j++) for (let i = 0; i < n; i++, o++) {
    const x = -E + (i + 0.5 + (pre() - 0.5) * 0.9) * S, z = -E + (j + 0.5 + (pre() - 0.5) * 0.9) * S;
    const u = pre();
    const s = flowerWeights(x, z, out);
    if (s <= 0) continue;
    let kind = 0, acc = out[0];
    while (kind < 4 && u * s > acc) acc += out[++kind];
    sx[o] = x; szz[o] = z; sw[o] = s; sk[o] = kind;
  }
  const k = solveScale(sw, GRASS.flowers * density * 1.012);
  const plants = [0, 0, 0, 0, 0];
  for (let i = 0; i < sw.length; i++) {
    if (sw[i] <= 0 || rng() >= k * sw[i]) continue;
    const x = sx[i], z = szz[i], kind = sk[i];
    const y = meshH(x, z);
    if (y < 0.03) continue;
    const tall = valueNoise2(x * 0.035 + 40.5, z * 0.035 + 17.3);
    const b = grid.bucket(x, z), key = rng();
    plants[kind]++;
    const up = 0.8 + 0.3 * tall;                    // flowers stand a little above the local grass
    if (kind === 0) grid.push(b, key, x, y, z, rng.range(0.34, 0.58) * up, 1, rng.range(0.09, 0.14), 0);
    else if (kind === 1) grid.push(b, key, x, y, z, rng.range(0.18, 0.36) * up, 1, rng.range(0.06, 0.1), 1);
    else if (kind === 2) grid.push(b, key, x, y, z, rng.range(0.28, 0.5) * up, 1, rng.range(0.07, 0.115), 2);
    else if (kind === 3) {
      const H = rng.range(0.5, 0.85) * up, s = rng.range(0.085, 0.125);
      grid.push(b, key, x, y, z, H, 0.97, s * 0.55, 3);            // the top dab carries the stem
      grid.push(b, key, x, y, z, H, 0.85, -s * 0.74, 3);
      grid.push(b, key, x, y, z, H, 0.72, -s * 0.9, 3);
      grid.push(b, key, x, y, z, H, 0.58, -s, 3);
    } else grid.push(b, key, x, y, z, rng.range(0.17, 0.34) * up, 1, rng.range(0.06, 0.09), 4);
  }
  return { grid, plants };
}

// one mesh per chunk; instances in random order so that drawing the "first k" is an even thinning
function buildChunks(grid, tpl, material, attrName, group, order, shuffle) {
  const chunks = [];
  for (const b of grid.map.values()) {
    const n = b.keys.length;
    if (!n) continue;
    const perm = new Uint32Array(n);
    for (let i = 0; i < n; i++) perm[i] = i;
    const keys = b.keys;
    if (shuffle) for (let i = n - 1; i > 0; i--) { const q = Math.floor(shuffle() * (i + 1)), tmp = perm[i]; perm[i] = perm[q]; perm[q] = tmp; }
    else perm.sort((p, q) => keys[p] - keys[q] || p - q);
    const root = new Float32Array(n * 4), par = new Float32Array(n * 4);
    let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
    for (let i = 0; i < n; i++) {
      const s = perm[i] * 7, d = b.data;
      const x = d[s], y = d[s + 1], z = d[s + 2];
      root[i * 4] = x; root[i * 4 + 1] = y; root[i * 4 + 2] = z; root[i * 4 + 3] = (i + 0.5) / n;
      par[i * 4] = d[s + 3]; par[i * 4 + 1] = d[s + 4]; par[i * 4 + 2] = d[s + 5]; par[i * 4 + 3] = d[s + 6];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const center = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2 + 0.4, (z0 + z1) / 2);
    const radius = Math.hypot(x1 - x0, y1 - y0 + 0.8, z1 - z0) / 2 + 1.3;      // + blade height, bend and far widening
    const aRoot = new THREE.InstancedBufferAttribute(root, 4), aPar = new THREE.InstancedBufferAttribute(par, 4);
    const mkGeo = (t) => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', t.position); g.setIndex(t.index);
      g.setAttribute('aRoot', aRoot); g.setAttribute(attrName, aPar);
      g.instanceCount = n;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius);
      return g;
    };
    const near = mkGeo(tpl.near), far = mkGeo(tpl.far);
    const mesh = new THREE.Mesh(near, material);
    // the shaders work in world space and ignore the model matrix: the position only serves culling and
    // front-to-back sorting. Drawn before the ground so the ground's costly strokes are depth-rejected.
    mesh.position.copy(center);
    mesh.renderOrder = order;
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    group.add(mesh);
    chunks.push({ mesh, near, far, n, center, radius });
  }
  return chunks;
}

// --------------------------------------------------------------------------------------------- part

export default async function create(world) {
  const group = new THREE.Group();
  group.name = 'grass';
  const density = Math.max(0.02, world.quality?.density ?? 1);
  const meshH = meshHeightSampler(world);

  const uniforms = {
    ...terrainUniforms,
    uPx1080: { value: (2 * Math.tan((21 * Math.PI) / 180)) / 1080 },
    uGrassLod: { value: new THREE.Vector4(GRASS.lodKeep, GRASS.lodPower, GRASS.lodMinPx, 170) },
    uGrassWind: { value: new THREE.Vector4(0.1, 0.95, 0.11, 0.8) },     // steady lean, gust lean, flutter (radians), gust sheen
    uGrassTone: { value: new THREE.Vector4(1.0, 0.55, 0.16, 0.7) },     // foot darkening, tip mix, tone jitter, sun translucency
    uFlowerLod: { value: new THREE.Vector4(GRASS.flowerKeep, GRASS.flowerPower, GRASS.flowerMinPx, 34) },
    uFlowerCol: { value: FLOWERS.map((f) => { const c = hex(f.col); return new THREE.Vector4(c.x, c.y, c.z, f.lobe); }) },
    uFlowerCtr: { value: FLOWERS.map((f) => { const c = hex(f.ctr); return new THREE.Vector4(c.x, c.y, c.z, f.ctrR); }) },
    uFlowerGlow: { value: 0.3 },      // how far flowers are lifted out of the shade (0 = lit like the grass)
    uFlowerMask: { value: 0.35 },     // paint-filter mask of the dabs (lower = crisper)
  };

  const blades = plantBlades(density, meshH);
  const flowers = plantFlowers(density, meshH);
  const bladeChunks = buildChunks(blades.grid, bladeTemplates(), bladeMaterial(uniforms), 'aBlade', group, -2, makeRng(0x7a11c3));
  const flowerChunks = buildChunks(flowers.grid, flowerTemplates(), flowerMaterial(uniforms), 'aFlower', group, -1, null);
  // blades neither cast shadows nor show in the pond's mirror: not registered with the pipeline

  const stats = {
    blades: blades.grid.count, tufts: blades.tufts, bladeChunks: bladeChunks.length,
    flowerDabs: flowers.grid.count, flowerPlants: flowers.plants.reduce((a, b) => a + b, 0),
    flowersByKind: Object.fromEntries(FLOWERS.map((f, i) => [f.name, flowers.plants[i]])), flowerChunks: flowerChunks.length,
  };
  console.info('[grass] ' + JSON.stringify(stats));

  const cam = new THREE.Vector3();
  const lod = (chunks, v, farGeo) => {
    for (const c of chunks) {
      const d = Math.max(0, cam.distanceTo(c.center) - c.radius);
      const keep = Math.min(1, Math.pow(v.x / Math.max(d, 1), v.y)) * 1.3;      // same law as in the vertex shader
      const count = Math.min(c.n, Math.ceil(c.n * keep));
      const g = d > farGeo ? c.far : c.near;
      g.instanceCount = count;
      c.mesh.geometry = g;
      c.mesh.visible = count > 0;
    }
  };

  return {
    group, uniforms, stats,
    update(t, camera) {
      cam.setFromMatrixPosition(camera.matrixWorld);
      uniforms.uPx1080.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / 1080;
      lod(bladeChunks, uniforms.uGrassLod.value, GRASS.lodFarGeo);
      lod(flowerChunks, uniforms.uFlowerLod.value, GRASS.flowerKeep * 0.75);
    },
  };
}
