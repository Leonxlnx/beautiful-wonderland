import * as THREE from 'three';
import { paintMaterial, register } from '../../core/materials.js';
import { makeRng, valueNoise2, clamp, lerp } from '../../core/rng.js';
import { heightAt, shoreDist, pathDist, forestAmount, pondRadius, HILL, FOREST } from '../layout.js';

// Trees, bushes, the forest and its light shafts.
// Canopies are clouds of camera-facing leaf "cards" (cut-out leaf clumps from a generated atlas), grouped in
// ellipsoidal clusters. Every card gets ONE flat colour out of a 4-step ramp, chosen in the vertex shader from
// the cluster/crown normal, a tone jitter and the sun shadow at the card centre — big painted masses, crisp
// leaf-shaped edges.

// ---- knobs ------------------------------------------------------------------------------------------------
export const FLORA = {
  glade: { x: 70, z: -118, r: 9 },       // forest clearing (trunk free)
  gladeSunShift: 7.5,                    // the canopy hole is stretched this far towards the noon sun (m)
  forestTrees: 205,                      // at density 1
  forestSpacing: 7.4,                    // minimum trunk distance (m)
  forestChunk: 60,                       // forest instances are batched per cell of this size (culling)
  loneLean: -Math.PI / 3,                // heading of the lone tree's lean (local +x → world (0.5, 0, 0.87))
  shoreBushes: 26, edgeBushes: 28, gladeBushes: 5,
  farClumps: 230,                        // slots on the far ring (≈ 2/3 get used, half get a companion)
  shafts: 9,
};
// uniforms shared by the flora materials (live-tweakable)
export const floraUniforms = {
  uLeafAtlas: { value: null },
  uLeafTone: { value: 0 },               // global tone offset of the leaf ramp (−0.2 darker … +0.2 lighter)
  uLeafGlow: { value: 0.55 },            // back-light translucency strength
  uLeafFlutter: { value: 1 },            // card flutter / cluster bob amount
  uShaftAmt: { value: 0.19 },            // light shaft brightness
};

const ATLAS_COLS = 4, ATLAS_ROWS = 2, DENSE_TILES = 6;    // tiles 0..5 dense clumps, 6..7 loose sprigs

// ---- tiny vector helpers ----------------------------------------------------------------------------------
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vnorm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const bez = (a, b, c, t) => { const u = 1 - t; return [u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], u * u * a[1] + 2 * u * t * b[1] + t * t * c[1], u * u * a[2] + 2 * u * t * b[2] + t * t * c[2]]; };
const randUnit = (rng) => { const y = rng.range(-1, 1), a = rng() * 6.2832, r = Math.sqrt(Math.max(0, 1 - y * y)); return [Math.cos(a) * r, y, Math.sin(a) * r]; };

// ---- leaf clump atlas -------------------------------------------------------------------------------------
// White on black, crisp shapes; a hair of blur gives the 0.5 contour a clean slope for the cut-out test.
function makeLeafAtlas() {
  const T = 256;
  const cv = document.createElement('canvas');
  cv.width = T * ATLAS_COLS; cv.height = T * ATLAS_ROWS;
  const g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < ATLAS_COLS * ATLAS_ROWS; i++) {
    const rng = makeRng(911 + i * 53);
    const cx = ((i % ATLAS_COLS) + 0.5) * T, cy = (Math.floor(i / ATLAS_COLS) + 0.5) * T, R = T / 2;
    // one pointed, chunky leaf: base (bx,by), direction ang, length len, half width hw (all in tile units)
    const leaf = (bx, by, ang, len, hw) => {
      const c = Math.cos(ang), s = Math.sin(ang);
      const P = (u, v) => [cx + (bx + u * c - v * s) * R, cy + (by + u * s + v * c) * R];
      const p0 = P(-len * 0.04, 0), q1 = P(len * 0.28, -hw * 2.1), tip = P(len, 0), q2 = P(len * 0.28, hw * 2.1);
      g.beginPath(); g.moveTo(p0[0], p0[1]);
      g.quadraticCurveTo(q1[0], q1[1], tip[0], tip[1]);
      g.quadraticCurveTo(q2[0], q2[1], p0[0], p0[1]);
      g.fill();
    };
    const fit = (bx, by, ang, len) => {       // keep the tip inside the tile so no quad edge ever shows
      for (let k = 0; k < 8; k++) { if (Math.hypot(bx + Math.cos(ang) * len, by + Math.sin(ang) * len) <= 0.9) break; len *= 0.9; }
      return len;
    };
    g.fillStyle = '#fff';
    if (i < DENSE_TILES) {
      // core: a faceted blob
      const nv = 9, r0 = rng.range(0.38, 0.46);
      g.beginPath();
      for (let k = 0; k < nv; k++) {
        const a = (k / nv) * 6.2832 + rng.range(-0.2, 0.2), r = r0 * rng.range(0.82, 1.15);
        const x = cx + Math.cos(a) * r * R, y = cy + Math.sin(a) * r * R;
        if (k) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.closePath(); g.fill();
      // a fan of leaves around it
      const n = 7 + Math.floor(rng() * 3), a0 = rng() * 6.2832;
      for (let k = 0; k < n; k++) {
        const a = a0 + (k / n) * 6.2832 + rng.range(-0.22, 0.22), rb = rng.range(0.18, 0.34);
        const bx = Math.cos(a) * rb, by = Math.sin(a) * rb, dir = a + rng.range(-0.5, 0.5);
        const len = fit(bx, by, dir, rng.range(0.5, 0.68));
        leaf(bx, by, dir, len, len * rng.range(0.21, 0.28));
      }
      // two notches of sky cut back into the clump
      g.fillStyle = '#000';
      for (let k = 0; k < 2; k++) {
        const a = rng() * 6.2832;
        leaf(Math.cos(a) * 0.8, Math.sin(a) * 0.8, a + Math.PI + rng.range(-0.35, 0.35), rng.range(0.32, 0.48), 0.085);
      }
    } else {
      // loose sprig: three twigs with 2–3 leaves each, used on the crown rim
      const a0 = rng() * 6.2832;
      g.beginPath(); g.arc(cx, cy, 0.2 * R, 0, 6.2832); g.fill();
      for (let k = 0; k < 3; k++) {
        const a = a0 + (k / 3) * 6.2832 + rng.range(-0.4, 0.4), rb = rng.range(0.08, 0.22);
        const bx = Math.cos(a) * rb, by = Math.sin(a) * rb, m = 2 + Math.floor(rng() * 2);
        for (let j = 0; j < m; j++) {
          const dir = a + (j - (m - 1) / 2) * 0.8 + rng.range(-0.2, 0.2);
          const len = fit(bx, by, dir, rng.range(0.55, 0.74));
          leaf(bx, by, dir, len, len * rng.range(0.2, 0.26));
        }
      }
    }
  }
  const out = document.createElement('canvas');
  out.width = cv.width; out.height = cv.height;
  const g2 = out.getContext('2d');
  g2.fillStyle = '#000'; g2.fillRect(0, 0, out.width, out.height);
  g2.filter = 'blur(1.6px)';
  g2.drawImage(cv, 0, 0);
  const tex = new THREE.CanvasTexture(out);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ---- GLSL -------------------------------------------------------------------------------------------------
// Whole-tree sway, shared by bark and leaves so the crown stays on its branches. f = height fraction.
const SWAY_GLSL = /* glsl */ `
vec3 treeSway(vec3 org, float f, float scl){
  float ph = org.x * .13 + org.z * .17;
  float g = gustAt(org.xz);
  float s = sin(uTime * 1.1 + ph) * .6 + sin(uTime * 2.4 + ph * 1.9) * .3;
  float amp = (.05 + .28 * g + .07 * s * (.4 + g)) * uWind.z * scl;
  float ff = f * f;
  return vec3(uWind.x * amp * ff, -amp * ff * f * .12, uWind.y * amp * ff);
}
`;

function makeLeafMaterial() {
  const mat = paintMaterial({
    name: 'leaves', side: THREE.DoubleSide, a2c: true,
    uniforms: floraUniforms,
    vertexPars: /* glsl */ `
      attribute vec4 aCard;    // half size (m), roll, atlas tile (+8 = mirrored), tone jitter
      attribute vec4 aCard2;   // flutter phase, crown radius 0..1, height fraction (sway), cluster phase
      uniform float uLeafTone, uLeafGlow, uLeafFlutter;
      varying vec2 vUv; varying vec3 vCol; varying vec3 vCtr;
      ${SWAY_GLSL}
      #ifndef DEPTH_PASS
      float leafShadowTap(vec3 p){
        vec4 sc = uShadowMatrix * vec4(p, 1.);
        vec3 q = sc.xyz * .5 + .5;
        if (q.x <= .002 || q.x >= .998 || q.y <= .002 || q.y >= .998 || q.z >= 1.) return 1.;
        float d = texture2D(uShadowMap, q.xy).r;
        vec2 e = min(q.xy, 1. - q.xy);
        float fade = smoothstep(0., .06, min(e.x, e.y));
        return mix(1., step(q.z - uShadowParams.y, d), fade * uShadowParams.z);
      }
      #endif
    `,
    vertexWorld: /* glsl */ `
      vec3 org = M[3].xyz;
      float scl = length(M[0].xyz);
      float th = hash12(org.xz * .37 + 3.1);
      float gst = gustAt(org.xz);
      // sway with the tree, bob with the cluster, flutter on the spot
      wp.xyz += treeSway(org, aCard2.z, scl);
      float cph = aCard2.w * 6.2832 + th * 40.;
      wp.xyz += vec3(uWind.x, .35, uWind.y) * (sin(uTime * 1.7 + cph) * (.025 + .09 * gst) * scl * aCard2.z * uLeafFlutter);
      float roll = aCard.y + sin(uTime * (3.2 + 2.6 * aCard2.x) + aCard2.x * 37.) * (.035 + .16 * gst) * uLeafFlutter;
      vec3 ctr = wp.xyz;
      // billboard around the card centre: faces the eye of whatever camera renders (the sun in the shadow pass)
      vec3 toCam = normalize(cameraPosition - ctr);
      vec3 cUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      vec3 rgt = normalize(cross(cUp, toCam));
      vec3 upv = cross(toCam, rgt);
      float cr = cos(roll), sr = sin(roll);
      vec2 q = vec2(uv.x * cr - uv.y * sr, uv.x * sr + uv.y * cr);
      float hs = aCard.x * scl;
      wp.xyz = ctr + (rgt * q.x + upv * q.y) * hs;
      float tile = floor(aCard.z + .5);
      float flip = step(7.5, tile); tile -= 8. * flip;
      vec2 tcell = vec2(mod(tile, ${ATLAS_COLS}.), floor(tile / ${ATLAS_COLS}.));
      vec2 cuv = vec2(uv.x * (1. - 2. * flip), uv.y) * .5 + .5;
      vUv = (tcell + cuv) / vec2(${ATLAS_COLS}., ${ATLAS_ROWS}.);
      vCtr = ctr;
      #ifdef DEPTH_PASS
        vCol = vec3(0.);
      #else
        // one flat tone per card
        vec3 L = normalize(mix(vec3(-.5, .8, .15), uSunDir, uSunAmt));
        float ndl = dot(wn, L);
        float sh = 1.;
        if (uSunAmt > .001){
          vec3 sp = ctr + uSunDir * (hs * 1.5 + .3) + wn * .3;
          vec3 t1 = normalize(cross(uSunDir, vec3(0., 1., .02)));
          vec3 t2 = cross(uSunDir, t1);
          float o = hs * .6;
          sh = (leafShadowTap(sp) * 2. + leafShadowTap(sp + t1 * o) + leafShadowTap(sp - t1 * o)
              + leafShadowTap(sp + t2 * o) + leafShadowTap(sp - t2 * o)) / 6.;
        }
        float nz = vnoise3(pos * .42 + th * 31.);              // tone blotches that belong to the tree
        float jit = aCard.w * .3 + smoothstep(.22, .78, nz) * .7;
        float jt = (jit - .5) * .3 + (th - .5) * .06 + uLeafTone;
        float inner = (1. - smoothstep(.45, 1., aCard2.y)) * .22;   // the inside of the crown stays dark
        float tL = .47 + .41 * ndl + jt - inner;                     // in the sun
        float tA = .27 + .08 * wn.y + jt * 1.3 - inner * .4;         // in shade: two tones in big blotches
        float tone = mix(tA, max(tL, tA), sh);
        tone = mix(tone * .82 + .04, tone, uSunAmt);
        // looking into the sun: lit leaves and the rim of the crown glow
        float back = max(dot(-toCam, uSunDir), 0.);
        float rim = 1. - abs(dot(wn, toCam));
        float glow = back * back * uSunAmt * (.25 + .75 * smoothstep(.3, .9, rim)) * max(sh, .35 * smoothstep(.8, 1., aCard2.y));
        tone += glow * uLeafGlow;
        float e = .028;
        vec3 c = mix(uLeafDark, uLeafMid, smoothstep(.33 - e, .33 + e, tone));
        c = mix(c, uLeafLight, smoothstep(.56 - e, .56 + e, tone));
        c = mix(c, uLeafHi, smoothstep(.85 - e, .85 + e, tone));
        vCol = c;
      #endif
    `,
    fragmentPars: /* glsl */ `uniform sampler2D uLeafAtlas; varying vec2 vUv; varying vec3 vCol; varying vec3 vCtr;`,
    fragmentMain: /* glsl */ `
      float a = texture2D(uLeafAtlas, vUv).r;
      float ca = cutAlpha(a);
      paintOut(applyHaze(vCol, vCtr), ca, 1.);
    `,
    depthMain: /* glsl */ `float a = texture2D(uLeafAtlas, vUv).r; if (a < .5) discard;`,
  });
  // the shadow twin must not read the shadow map it is being rendered into
  const dm = mat.userData.depthMat;
  dm.defines = { ...dm.defines, DEPTH_PASS: 1 };
  return mat;
}

function makeBarkMaterial() {
  return paintMaterial({
    name: 'bark',
    vertexPars: /* glsl */ `attribute float aF; varying float vSeed; ${SWAY_GLSL}`,
    vertexWorld: /* glsl */ `
      vec3 org = M[3].xyz;
      wp.xyz += treeSway(org, aF, length(M[0].xyz));
      vSeed = hash12(org.xz * .37 + 3.1);
    `,
    fragmentPars: /* glsl */ `varying float vSeed;`,
    fragmentMain: /* glsl */ `
      vec3 N = normalize(vN);
      vec3 L = normalize(mix(vec3(-.5, .8, .15), uSunDir, uSunAmt));
      // long chunky strokes running up the trunk cut the terminator
      float n1 = vnoise3(vec3(N.x * 2.4, vW.y * .38, N.z * 2.4) + vSeed * 17.);
      float n2 = vnoise3(vec3(N.x * 5., vW.y * .9, N.z * 5.) + 3.7);
      float lit = paintBand(dot(N, L) + (n1 - .5) * .4 + (n2 - .5) * .1, .12, .03);
      float sh = getShadow(vW + N * .1, vec2(n1 - .5, n2 - .5) * .14);
      float l = lit * sh;
      vec3 base = mix(vec3(.60, .35, .37), vec3(.56, .43, .33), l);      // violet-brown shade, warm brown light
      vec3 col = paintLight(base, l * .82, 0.);
      col *= 1. + .12 * (paintBand(n2, .6, .03) - .45);
      paintOut(applyHaze(col, vW), 1., 1.);
    `,
  });
}

function makeShaftMaterial() {
  return paintMaterial({
    name: 'shafts', side: THREE.DoubleSide, blend: 'add',
    uniforms: floraUniforms,
    vertexPars: /* glsl */ `attribute vec4 aShaft; varying vec2 vS; varying float vPh;`,   // half width, canopy height, phase, gain
    vertexWorld: /* glsl */ `
      float len = min(aShaft.y / max(uSunDir.y, .2), 27.);
      vec3 p = wp.xyz + uSunDir * (len * uv.y);
      vec3 side = normalize(cross(uSunDir, normalize(cameraPosition - p)));
      wp.xyz = p + side * (uv.x * aShaft.x * mix(1., .5, uv.y));
      vS = uv; vPh = aShaft.z + aShaft.w * 10.;
    `,
    fragmentPars: /* glsl */ `varying vec2 vS; varying float vPh; uniform float uShaftAmt;`,
    fragmentMain: /* glsl */ `
      float x = abs(vS.x);
      float ew = max(fwidth(vS.x) * 1.5, .012);
      // two flat layers with cut edges: a wide wedge and a brighter core
      float a = smoothstep(1., 1. - ew * 2., x) * .55 + smoothstep(.5 + ew, .5 - ew, x) * .45;
      float fade = smoothstep(0., .2, vS.y) * smoothstep(1., .45, vS.y);
      float ph = fract(vPh) * 6.2832;
      float breathe = .8 + .2 * sin(uTime * .55 + ph) + .06 * sin(uTime * 1.3 + ph * 2.7);
      float k = uSunAmt * smoothstep(.1, .3, uSunDir.y) * mix(.8, 1., smoothstep(.3, .8, uSunDir.y)) * uShaftAmt * (.7 + .6 * fract(vPh * .1));
      paintOutAdd(vec3(1., .94, .66) * uSunTint * (a * fade * breathe * k));
    `,
  });
}

// ---- geometry builders ------------------------------------------------------------------------------------
class CardBuf {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.a = []; this.b = []; this.idx = []; this.n = 0; this.maxHalf = 0; }
  add(p, n, half, roll, tile, jit, phase, crownR, f, clPhase) {
    const base = this.n * 4;
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      this.pos.push(p[0], p[1], p[2]); this.nrm.push(n[0], n[1], n[2]); this.uv.push(u, v);
      this.a.push(half, roll, tile, jit); this.b.push(phase, crownR, f, clPhase);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.maxHalf = Math.max(this.maxHalf, half);
    this.n++;
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aCard', new THREE.Float32BufferAttribute(this.a, 4));
    g.setAttribute('aCard2', new THREE.Float32BufferAttribute(this.b, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere(); g.boundingSphere.radius += this.maxHalf * 1.5 + 0.8;
    g.computeBoundingBox(); g.boundingBox.expandByScalar(this.maxHalf * 1.5 + 0.8);
    return g;
  }
}

class TubeBuf {
  constructor() { this.pos = []; this.nrm = []; this.f = []; this.idx = []; }
  // tapered tube along a polyline; f = height fraction for the sway
  add(pts, radii, radial, H) {
    const n = pts.length, base = this.pos.length / 3;
    const d = vsub(pts[n - 1], pts[0]);
    const ref = Math.abs(d[1]) > Math.hypot(d[0], d[2]) ? [1, 0, 0] : [0, 1, 0];
    for (let i = 0; i < n; i++) {
      const t = vnorm(vsub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]));
      const u = vnorm(vcross(t, ref)), v = vcross(t, u);
      for (let j = 0; j < radial; j++) {
        const a = (j / radial) * 6.2832, c = Math.cos(a), s = Math.sin(a);
        const nx = u[0] * c + v[0] * s, ny = u[1] * c + v[1] * s, nz = u[2] * c + v[2] * s;
        this.pos.push(pts[i][0] + nx * radii[i], pts[i][1] + ny * radii[i], pts[i][2] + nz * radii[i]);
        this.nrm.push(nx, ny, nz);
        this.f.push(clamp(pts[i][1] / H, 0, 1.1));
      }
    }
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < radial; j++) {
      const a = base + i * radial + j, b = base + i * radial + ((j + 1) % radial), c = a + radial, e = b + radial;
      this.idx.push(a, b, c, b, e, c);
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aF', new THREE.Float32BufferAttribute(this.f, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere(); g.boundingSphere.radius += 0.8;
    g.computeBoundingBox(); g.boundingBox.expandByScalar(0.8);
    return g;
  }
}

// Species. Lengths in metres at instance scale 1.
const SPECIES = {
  lone: {
    H: 13, crownY: 0.66, crownR: [5.7, 4.3, 5.2], lean: [2.3, 0], windLean: true,
    clusters: 20, yMin: -0.45, q: [0.5, 0.82], clusterR: [1.35, 2.0], flatten: 0.8, cards: 52, half: [0.78, 1.0], core: 2.2,
    trunkR: 0.52, trunkTop: -0.2, bend: 0.0, branches: 7, branchT: [0.3, 0.9], trunkSeg: 12, radial: 10, radialB: 6, twigR: 0.09,
    clusterN: 0.55, swayK: 1, tone: 0.03,
  },
  meadow: {
    H: 12, crownY: 0.64, crownR: [4.9, 3.9, 4.9], lean: [0.5, 0.3],
    clusters: 15, yMin: -0.4, q: [0.55, 0.7], clusterR: [1.5, 2.0], flatten: 0.8, cards: 44, half: [0.8, 1.0], core: 2.3,
    trunkR: 0.45, trunkTop: -0.2, bend: 0.035, branches: 5, branchT: [0.3, 0.9], trunkSeg: 9, radial: 8, radialB: 5, twigR: 0.09,
    clusterN: 0.55, swayK: 1, tone: 0.02,
  },
  forest: {
    H: 19.5, crownY: 0.72, crownR: [5.6, 4.6, 5.6], lean: [0.6, 0.6],
    clusters: 9, yMin: -0.5, q: [0.5, 0.66], clusterR: [2.3, 3.0], flatten: 0.75, cards: 23, half: [1.05, 1.35], core: 2.4,
    trunkR: 0.42, trunkTop: 0.1, bend: 0.025, branches: 3, branchT: [0.6, 0.93], trunkSeg: 8, radial: 7, radialB: 5, twigR: 0.13,
    clusterN: 0.5, swayK: 1, tone: -0.04,
  },
  bush: {
    H: 1.7, crownY: 0.5, crownR: [1.25, 0.85, 1.25], lean: [0, 0],
    clusters: 4, yMin: 0.05, q: [0.35, 0.55], clusterR: [0.6, 0.85], flatten: 0.8, cards: 13, half: [0.34, 0.46], core: 0,
    trunkR: 0, clusterN: 0.45, swayK: 0.5, tone: 0.05,
  },
  far: {
    H: 13, crownY: 0.5, crownR: [5.6, 6.2, 5.6], lean: [0, 0],
    clusters: 5, yMin: -0.2, q: [0.3, 0.5], clusterR: [3.3, 4.3], flatten: 0.9, cards: 4, half: [2.8, 3.6], core: 0,
    trunkR: 0, clusterN: 0.35, swayK: 0.3, tone: 0, fixedCards: true,
  },
};

function buildTree(S, seed, cardK) {
  const rng = makeRng(seed);
  const L = new CardBuf(), T = new TubeBuf();
  const H = S.H, R = S.crownR;
  const Cc = [S.windLean ? S.lean[0] : rng.range(-1, 1) * S.lean[0], S.crownY * H, S.windLean ? S.lean[1] : rng.range(-1, 1) * S.lean[1]];

  // clusters: evenly spread over the crown ellipsoid (golden-angle spiral from the top down)
  const clusters = [];
  const ph0 = rng() * 6.2832;
  for (let k = 0; k < S.clusters; k++) {
    const y = 1 - ((k + 0.5) / S.clusters) * (1 - S.yMin);
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = ph0 + k * 2.39996 + rng.range(-0.25, 0.25);
    const d = [Math.cos(phi) * rad, y, Math.sin(phi) * rad];
    let q = rng.range(S.q[0], S.q[1]), rc = rng.range(S.clusterR[0], S.clusterR[1]);
    if (S.windLean) { q *= 1 + 0.3 * d[0]; rc *= 1 + 0.14 * d[0]; }      // the lee side reaches further
    clusters.push({ c: [Cc[0] + d[0] * R[0] * q, Cc[1] + d[1] * R[1] * q, Cc[2] + d[2] * R[2] * q], rc, d, core: false, ph: rng() });
  }
  if (S.core) clusters.push({ c: [Cc[0], Cc[1] + R[1] * 0.05, Cc[2]], rc: S.core, d: [0, 1, 0], core: true, ph: rng() });

  // leaf cards
  const rcMean = (S.clusterR[0] + S.clusterR[1]) / 2;
  const kk = S.fixedCards ? 1 : cardK, sizeK = 1 / Math.sqrt(kk);
  for (const cl of clusters) {
    const n = Math.max(3, Math.round(S.cards * (cl.rc / rcMean) ** 2 * kk * (cl.core ? 0.45 : 1)));
    const ry = cl.rc * S.flatten;
    for (let i = 0; i < n; i++) {
      let e = randUnit(rng);
      if (!cl.core) e = vnorm([e[0] + cl.d[0] * 0.6, e[1] + cl.d[1] * 0.6 + 0.12, e[2] + cl.d[2] * 0.6]);
      const rho = 0.6 + 0.4 * Math.pow(rng(), 0.6);
      const p = [cl.c[0] + e[0] * cl.rc * rho, cl.c[1] + e[1] * ry * rho, cl.c[2] + e[2] * cl.rc * rho];
      let half = rng.range(S.half[0], S.half[1]) * sizeK;
      if (!S.trunkR) p[1] = Math.max(p[1], half * 0.7);                    // bushes sit on the ground
      const nC = vnorm([e[0], e[1] / S.flatten, e[2]]);
      const k3 = [(p[0] - Cc[0]) / R[0], (p[1] - Cc[1]) / R[1], (p[2] - Cc[2]) / R[2]];
      const cr = Math.hypot(k3[0], k3[1], k3[2]);
      const nK = vnorm([k3[0] / R[0], k3[1] / R[1], k3[2] / R[2]]);
      const w = cl.core ? 0.15 : S.clusterN;
      const nn = vnorm([nC[0] * w + nK[0] * (1 - w), nC[1] * w + nK[1] * (1 - w), nC[2] * w + nK[2] * (1 - w)]);
      const rimCard = !cl.core && cr > 0.9 && rho > 0.85 && rng() < 0.55;
      let tile = rimCard ? DENSE_TILES + Math.floor(rng() * 2) : Math.floor(rng() * DENSE_TILES);
      if (rimCard) half *= 1.12;
      if (rng() < 0.5) tile += 8;
      L.add(p, nn, half, rng.range(-0.9, 0.9), tile, clamp(rng() + S.tone * 2, 0, 1), rng(), Math.min(cr, 1), clamp(p[1] / H, 0, 1.1) * S.swayK, cl.ph);
    }
  }

  // trunk and main limbs
  if (S.trunkR) {
    const P0 = [0, -0.5, 0];
    const top = [Cc[0] * 0.85, Cc[1] + R[1] * S.trunkTop, Cc[2] * 0.85];
    const ctrl = S.windLean
      ? [top[0] * 0.05 - 0.3, top[1] * 0.52, 0]
      : [top[0] * 0.5 + rng.range(-1, 1) * H * S.bend, top[1] * 0.55, top[2] * 0.5 + rng.range(-1, 1) * H * S.bend];
    const rAt = (t) => S.trunkR * (1 - 0.68 * t) * (1 + 0.55 * Math.exp(-t * 16));
    const pts = [], radii = [];
    for (let i = 0; i <= S.trunkSeg; i++) { const t = i / S.trunkSeg; pts.push(bez(P0, ctrl, top, t)); radii.push(rAt(t)); }
    T.add(pts, radii, S.radial, H);
    const limbs = clusters.filter((c) => !c.core).sort((a, b) => a.c[1] - b.c[1]).slice(0, S.branches);
    for (const cl of limbs) {
      const e = [cl.c[0] - cl.d[0] * cl.rc * 0.3, cl.c[1] - cl.rc * 0.25, cl.c[2] - cl.d[2] * cl.rc * 0.3];
      const t = clamp((e[1] - Math.hypot(e[0], e[2]) * 0.75) / top[1], S.branchT[0], S.branchT[1]);
      const s = bez(P0, ctrl, top, t);
      const dv = vsub(e, s), dist = Math.hypot(dv[0], dv[1], dv[2]);
      if (dist < 1.2) continue;
      const mid = [s[0] + dv[0] * 0.6, s[1] + dv[1] * 0.28, s[2] + dv[2] * 0.6];     // out first, then up
      const bp = [], br = [], segB = 4;
      for (let i = 0; i <= segB; i++) { const u = i / segB; bp.push(bez(s, mid, e, u)); br.push(lerp(rAt(t) * 0.62, S.twigR, Math.pow(u, 0.8))); }
      T.add(bp, br, S.radialB, H);
    }
  }
  return { leaves: L.geometry(), trunk: S.trunkR ? T.geometry() : null, cards: L.n, tris: L.n * 2 + T.idx.length / 3 };
}

function instanced(geo, mat, list, name) {
  const m = new THREE.InstancedMesh(geo, mat, list.length);
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  list.forEach((it, i) => { q.setFromAxisAngle(up, it.rot); p.set(it.x, it.y, it.z); s.setScalar(it.s); mtx.compose(p, q, s); m.setMatrixAt(i, mtx); });
  m.instanceMatrix.needsUpdate = true;
  m.computeBoundingSphere(); m.computeBoundingBox();
  m.name = name;
  return m;
}

// ---- placement --------------------------------------------------------------------------------------------
const jettyZone = (x, z, m) => z > 4 - m && z < 12 + m && x > -m && x < 60 + m;
const groundOK = (x, z, shore, path) => shoreDist(x, z) > shore && pathDist(x, z) > path && !jettyZone(x, z, 3);
// the open view from the east shore (60, 8) across the pond to the wheel, the hill and the sunset
const inWestView = (x, z) => { if (x >= 60) return false; const b = (Math.atan2(z - 8, 60 - x) * 180) / Math.PI; return b > -40 && b < 22; };

function placeAll(dens) {
  const G = FLORA.glade;
  const P = { lone: [], meadow: [[], [], []], forest: [[], [], [], []], bush: [[], [], []], far: [[], [], []], shafts: [] };
  const inst = (x, z, s, rot, sink = 0.15) => ({ x, y: heightAt(x, z) - sink, z, s, rot });

  // the lone tree on the kite hill
  P.lone.push(inst(HILL.x, HILL.z, 1, FLORA.loneLean, 0.1));

  // forest: dart throwing with a minimum trunk distance; the glade (stretched towards the noon sun) stays open
  {
    const rng = makeRng(4021);
    const g2x = G.x - 0.47 * FLORA.gladeSunShift, g2z = G.z + 0.88 * FLORA.gladeSunShift;
    const open = (x, z) => Math.hypot(x - G.x, z - G.z) < G.r + 0.3 || Math.hypot(x - g2x, z - g2z) < G.r - 0.8;
    const pts = [[72.3, -109.7], [77.6, -112.0]];              // two trunks framing the look into the glade
    const target = Math.round(FLORA.forestTrees * Math.min(1, 0.88 + 0.12 * dens));
    for (let i = 0; i < 24000 && pts.length < target; i++) {
      const x = FOREST.x + rng.range(-96, 96), z = FOREST.z + rng.range(-96, 96);
      if (forestAmount(x, z) <= 0.5 || open(x, z) || !groundOK(x, z, 6, 5)) continue;
      let ok = true;
      for (const p of pts) if (Math.hypot(p[0] - x, p[1] - z) < FLORA.forestSpacing) { ok = false; break; }
      if (ok) pts.push([x, z]);
    }
    for (const [x, z] of pts) {
      const edge = forestAmount(x, z) < 0.8 ? 0.9 : 1;
      P.forest[Math.floor(rng() * 4)].push(inst(x, z, rng.range(0.85, 1.2) * edge, rng() * 6.2832, 0.2));
    }
  }

  // meadow copses and single trees (clear of the westward view)
  const copseAnchors = [];
  {
    const rng = makeRng(7703);
    const spots = [
      [-28, -88], [-40, -96], [-22, -100],      // north shore copse
      [-62, 78], [-74, 88], [-58, 92],          // south-west copse
      [112, 40], [122, 28], [104, 58],          // behind the east shore
      [20, 100], [35, 112],                     // south
      [-150, 120], [-165, 105],                 // far south-west
      [-60, -150], [-75, -160],                 // north-west, beyond the hill
      [150, -10], [140, 90], [-100, 130],       // singles
    ];
    spots.forEach(([x, z], i) => {
      const s = rng.range(0.8, 1.15), rot = rng() * 6.2832, v = Math.floor(rng() * 3);
      if (!groundOK(x, z, 8, 6) || forestAmount(x, z) > 0.2 || inWestView(x, z) || Math.hypot(x - HILL.x, z - HILL.z) < 45) return;
      P.meadow[v].push(inst(x, z, s, rot));
      if ([0, 3, 6, 9, 11, 13, 15, 16].includes(i)) copseAnchors.push([x, z]);
    });
  }

  // bushes: pond shore, forest edge, glade rim, copses
  {
    const rng = makeRng(9917);
    const all = [];
    const tryBush = (x, z, sMin, sMax, minD = 2.2) => {
      if (shoreDist(x, z) < 3.3 || pathDist(x, z) < 4.5 || jettyZone(x, z, 3)) return false;
      if (x > 36 && z > -10 && z < 26) return false;                       // keep the east shore outlook open
      for (const b of all) if (Math.hypot(b[0] - x, b[1] - z) < minD) return false;
      all.push([x, z]);
      P.bush[Math.floor(rng() * 3)].push(inst(x, z, rng.range(sMin, sMax), rng() * 6.2832, 0.05));
      return true;
    };
    let n = 0;
    for (let i = 0; i < 300 && n < FLORA.shoreBushes; i++) {
      const th = rng() * 6.2832, r = pondRadius(th) + rng.range(4, 8.5);
      const x = Math.cos(th) * r, z = Math.sin(th) * r, m = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < m && n < FLORA.shoreBushes; k++) if (tryBush(x + (k ? rng.range(-2.8, 2.8) : 0), z + (k ? rng.range(-2.8, 2.8) : 0), 0.65, 1.3)) n++;
    }
    n = 0;
    for (let i = 0; i < 4000 && n < FLORA.edgeBushes; i++) {
      const x = FOREST.x + rng.range(-105, 105), z = FOREST.z + rng.range(-105, 105), fa = forestAmount(x, z);
      if (fa < 0.12 || fa > 0.5) continue;
      if (tryBush(x, z, 0.8, 1.45, 3.2)) n++;
    }
    for (let i = 0; i < FLORA.gladeBushes; i++) {
      const a = 2.2 + (i / FLORA.gladeBushes) * 4.3 + rng.range(-0.25, 0.25), r = G.r + rng.range(-0.2, 1.4);     // not in front of the look-dev camera
      tryBush(G.x + Math.cos(a) * r, G.z + Math.sin(a) * r, 0.75, 1.3);
    }
    for (const [x, z] of copseAnchors) { const a = rng() * 6.2832, r = rng.range(4, 6); tryBush(x + Math.cos(a) * r, z + Math.sin(a) * r, 0.8, 1.4); }
  }

  // far tree line: clumps on a ring near the horizon, with gaps
  {
    const rng = makeRng(733), N = FLORA.farClumps;
    for (let i = 0; i < N; i++) {
      const a = ((i + rng.range(-0.4, 0.4)) / N) * 6.2832, r = rng.range(258, 350);
      const m = valueNoise2(Math.cos(a) * 6.5 + 11.3, Math.sin(a) * 6.5 + 4.7);
      const s = rng.range(0.85, 1.45) * (0.75 + m * 0.5), rot = rng() * 6.2832, v = Math.floor(rng() * 3), comp = rng(), ca = rng() * 6.2832;
      if (m < 0.3) continue;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      P.far[v].push(inst(x, z, s, rot, 0.5));
      if (comp < 0.65) P.far[(v + 1) % 3].push(inst(x + Math.cos(ca) * 6.5 * s, z + Math.sin(ca) * 6.5 * s, s * 0.74, rot + 1.3, 0.5));
    }
  }

  // light shafts: ground points in the glade
  {
    const rng = makeRng(5521);
    for (let i = 0; i < 400 && P.shafts.length < FLORA.shafts; i++) {
      const a = rng() * 6.2832, r = Math.sqrt(rng()) * (G.r - 2.3);
      const x = G.x + Math.cos(a) * r, z = G.z + Math.sin(a) * r;
      if (P.shafts.some((s) => Math.hypot(s.x - x, s.z - z) < 2.4)) continue;
      P.shafts.push({ x, y: heightAt(x, z), z, w: rng.range(0.8, 1.8), h: rng.range(11, 16), ph: rng(), gain: rng() });
    }
  }
  return P;
}

function buildShafts(list, mat) {
  const SEG = 8, pos = [], uv = [], sh = [], idx = [];
  list.forEach((s, k) => {
    const base = k * (SEG + 1) * 2;
    for (let i = 0; i <= SEG; i++) for (const u of [-1, 1]) {
      pos.push(s.x, s.y, s.z); uv.push(u, i / SEG); sh.push(s.w, s.h, s.ph, s.gain);
    }
    for (let i = 0; i < SEG; i++) { const a = base + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((v, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aShaft', new THREE.Float32BufferAttribute(sh, 4));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(FLORA.glade.x, heightAt(FLORA.glade.x, FLORA.glade.z) + 8, FLORA.glade.z), 42);
  const m = new THREE.Mesh(g, mat);
  m.name = 'glade-shafts';
  m.renderOrder = 20;
  return m;
}

// ---- the part ---------------------------------------------------------------------------------------------
export default async function create(world) {
  const group = new THREE.Group();
  group.name = 'flora';
  const dens = world.quality?.density ?? 1;
  const cardK = clamp(0.6 + 0.4 * dens, 0.5, 1.3);      // fewer, larger cards at low density (0.72 live, 1 film)

  floraUniforms.uLeafAtlas.value = makeLeafAtlas();
  const leafMat = makeLeafMaterial(), barkMat = makeBarkMaterial(), shaftMat = makeShaftMaterial();
  const P = placeAll(dens);
  const counts = { trees: 0, bushes: 0, far: 0, cards: 0, tris: 0 };

  const addSpecies = (name, S, lists, seed, { cast = true, kind = 'trees', chunk = 0 } = {}) => {
    lists.forEach((all, v) => {
      if (!all.length) return;
      const a = buildTree(S, seed + v * 101, cardK);
      const cells = new Map();
      for (const it of all) {
        const key = chunk ? Math.floor(it.x / chunk) + ':' + Math.floor(it.z / chunk) : 'all';
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(it);
      }
      for (const [key, list] of cells) {
        const lm = instanced(a.leaves, leafMat, list, `${name}-leaves-${v}-${key}`);
        register(world.pipeline, lm, { cast, reflect: true });
        group.add(lm);
        if (a.trunk) {
          const tm = instanced(a.trunk, barkMat, list, `${name}-trunk-${v}-${key}`);
          register(world.pipeline, tm, { cast, reflect: true });
          group.add(tm);
        }
      }
      counts[kind] += all.length; counts.cards += a.cards * all.length; counts.tris += a.tris * all.length;
    });
  };
  addSpecies('lone', SPECIES.lone, [P.lone], 1201);
  addSpecies('meadow', SPECIES.meadow, P.meadow, 2301);
  addSpecies('forest', SPECIES.forest, P.forest, 3401, { chunk: FLORA.forestChunk });
  addSpecies('bush', SPECIES.bush, P.bush, 4501, { kind: 'bushes' });
  addSpecies('far', SPECIES.far, P.far, 5601, { cast: false, kind: 'far', chunk: 260 });

  const shafts = buildShafts(P.shafts, shaftMat);
  group.add(shafts);

  return {
    group, counts, config: FLORA, uniforms: floraUniforms, glade: FLORA.glade,
    update() { /* everything animates in the shaders from uTime / uWind */ },
  };
}
