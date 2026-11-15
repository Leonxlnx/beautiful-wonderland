import * as THREE from 'three';
import { paintMaterial, register } from '../../core/materials.js';
import { makeRng, valueNoise2, smoothstep } from '../../core/rng.js';
import { TERRAIN_SIZE, heightAt, shoreDist, pondRadius, WHEEL, JETTY } from '../layout.js';
import { GROUND_GLSL, terrainUniforms } from '../terrain.js';
import { skyUniforms } from '../sky.js';

// The pond: a painted mirror. The reflection (sky colour study + the mirrored world) is cut into flat,
// sideways-stretched slices by a quantised ripple field, toned in a few depth bands, and dotted with crisp
// glint squiggles. Lily pads drift on it and reeds stand along the shore.
// All patterns live in world space but pick their cell size per octave from the on-canvas footprint, so
// marks keep a constant painted size at any distance and stay anchored to the water.

const TERRAIN_SEG = 320;      // must match the terrain grid: the surface reuses its vertices so the
                              // interpolated bed height (and with it the waterline) is exact

// ───────────────────────────────────────────────────────────── surface ──
function buildSurfaceGeometry() {
  const cell = TERRAIN_SIZE / TERRAIN_SEG, half = TERRAIN_SIZE / 2;
  const i0 = Math.floor((half - 84) / cell), i1 = Math.ceil((half + 84) / cell);
  const ids = new Map(), pos = [], bed = [], idx = [];
  const vert = (i, j) => {
    const key = i * 4096 + j;
    let id = ids.get(key);
    if (id === undefined) {
      const x = i * cell - half, z = j * cell - half;
      id = pos.length / 3; ids.set(key, id);
      pos.push(x, 0, z); bed.push(heightAt(x, z));
    }
    return id;
  };
  for (let j = i0; j < i1; j++) for (let i = i0; i < i1; i++) {
    const x = (i + 0.5) * cell - half, z = (j + 0.5) * cell - half;
    if (shoreDist(x, z) > 7) continue;
    const a = vert(i, j), b = vert(i, j + 1), c = vert(i + 1, j + 1), d = vert(i + 1, j);
    if (Math.min(bed[a], bed[b], bed[c], bed[d]) > 0.02) continue;
    idx.push(a, b, d, b, c, d);       // same diagonal as THREE.PlaneGeometry (the terrain)
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('bed', new THREE.Float32BufferAttribute(bed, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

const WATER_PARS = /* glsl */ `
${GROUND_GLSL}
uniform sampler2D uSkyField; uniform float uSkyDrift;
uniform sampler2D uMirror; uniform mat4 uReflMatrix; uniform float uHasMirror;
uniform vec2 uRight; uniform float uRefPx; uniform vec2 uReflScale;
uniform vec3 uSkyHorSun;
uniform float uRippleAmp, uRippleSpeed, uSlice, uSliceH, uGlintAmt, uSunPath, uSunGlow, uDeepMin, uMirrorAmt;
varying float vBed;

vec3 skyStudyAE(float az, float el){
  return textureLod(uSkyField, vec2((az + uSkyDrift) / 6.2831853 + .5, (max(el, .02) + .2) / 1.7), 0.).rgb;
}
// Shadow on the water as one flat shape: six lookups spread across the streak direction, then a cut,
// so thin reeds and lattices give a chunky patch instead of a dither. 1 = lit.
float waterShadow(vec3 wpos, vec2 wob){
  if (uSunAmt <= 0.001) return 1.;
  vec2 across = normalize(vec2(-uSunDir.z, uSunDir.x) + 1e-5);
  float s = 0., fade = 1., jit = hash12(gl_FragCoord.xy) - .5;      // jittered comb: no moiré against the blades
  for (int i = 0; i < 6; i++){
    float o = (float(i) - 2.5 + jit) * .13;
    vec4 sc = uShadowMatrix * vec4(wpos + vec3(wob.x + across.x * o, 0., wob.y + across.y * o), 1.);
    vec3 p = sc.xyz * .5 + .5;
    vec2 e = min(p.xy, 1. - p.xy);
    float m = min(e.x, e.y);
    fade = min(fade, smoothstep(0., .06, m));
    s += (m <= .002 || p.z >= 1.) ? 1. : shadowTap(p.xy, p.z - uShadowParams.y);
  }
  return mix(1., smoothstep(.55, .9, s / 6.), fade * uShadowParams.z);
}
// staircase with one-pixel anti-aliased risers (steps at k + .5)
float stepAA(float x){
  float a = clamp(fwidth(x) * .8, .002, .5);
  return floor(x) + smoothstep(.5 - a, .5 + a, fract(x));
}
// Noise with cells of a wanted size s (metres along camera-right / depth). Sizes snap to octaves per axis
// and cross-fade (variance preserving), so marks keep their size on the canvas but belong to the water.
float bandNoise(vec2 q, vec2 s, float seed, vec2 scroll, float wig){
  vec2 l = log2(s), i0 = floor(l), f = l - i0;
  float acc = 0.;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++){
    vec2 L = i0 + vec2(float(i), float(j));
    vec2 p = q * exp2(-L) + L * vec2(7.31, 3.77) + seed + scroll;
    p.y += wig * sin(p.x * 5.3 + 1.7 * sin(p.x * 1.9 + L.x * 2.1));
    acc += vnoise(p) * (i == 0 ? 1. - f.x : f.x) * (j == 0 ? 1. - f.y : f.y);
  }
  vec2 w2 = (1. - f) * (1. - f) + f * f;
  return .5 + (acc - .5) * inversesqrt(w2.x * w2.y);
}
`;

const WATER_MAIN = /* glsl */ `
  vec3 dv = vW - uCamPos; float dist = length(dv); vec3 Vd = dv / dist;
  float vy = clamp(-Vd.y, .002, 1.);
  float depth = -vBed;
  vec2 xz = vW.xz;

  // canvas footprint of a reference pixel on the water: sideways and (foreshortened) in depth
  float pxS = dist * uRefPx, pxD = pxS / vy;
  vec2 fwd2 = vec2(-uRight.y, uRight.x);
  vec2 perpW = vec2(-uWind.y, uWind.x);
  vec2 wa = xz - uWind.xy * (uTime * uRippleSpeed);
  vec2 wb = xz - (uWind.xy * .55 + perpW * .6) * (uTime * uRippleSpeed * 1.3);
  vec2 qa = vec2(dot(wa, uRight), dot(wa, fwd2));
  vec2 qb = vec2(dot(wb, uRight), dot(wb, fwd2));

  // ripple field: long sideways, short in depth
  float nA = bandNoise(qa, max(vec2(pxS * 170., pxD * 26.), vec2(.5, .12)), 3.1, vec2(0.), 0.);
  float nB = bandNoise(qb, max(vec2(pxS * 85., pxD * 13.), vec2(.25, .06)), 8.7, vec2(0., uTime * .05), 0.);
  float n = nA * .7 + nB * .3;

  float gust = gustAt(xz);
  float gq = smoothstep(.26, .4, gust + (n - .5) * .5);          // gust patches with rippled edges
  float calm = mix(1., .3, smoothstep(10., 110., dist));         // far water lies flatter

  // quantised offset: the mirror breaks into flat slices
  float xr = (n - .5) * (4.6 + 2.4 * gq);
  float lvl = stepAA(xr);
  float amp = uRefPx * uRippleAmp * calm * (1. + .9 * gq);
  // sideways shift grows level by level (a wobbling ribbon, not confetti); its sense turns slowly across the pond
  float gB = bandNoise(qa, max(vec2(pxS * 300., pxD * 46.), vec2(.9, .2)), 33.9, vec2(uTime * .03, uTime * .11), 0.);
  vec2 off = vec2(lvl * .7 * clamp((gB - .5) * 5., -1., 1.), lvl * .65) * amp;

  float az = atan(Vd.z, Vd.x), el = asin(vy);
  float qEl = uRefPx * uSliceH;
  float elO = el + off.y;
  float elS = stepAA(elO / qEl + (nB - .5) * 6. + (nA - .5) * 4.) * qEl;     // reflection drawn in ragged horizontal slabs
  float elR = mix(elO, elS, uSlice * mix(.5, 1., calm));
  vec3 sky = skyStudyAE(az + off.x / max(cos(el), .35), elR);
  vec4 mp = uReflMatrix * vec4(vW, 1.);
  vec2 muv = mp.xy / mp.w - vec2(off.x, elR - el) * uReflScale;
  // the mirrored world, smeared a little (mostly down the picture) so thin things read as soft strokes
  vec2 mtx = 1. / vec2(textureSize(uMirror, 0));
  vec4 mir = textureLod(uMirror, muv, 0.) * .3
    + (textureLod(uMirror, muv + vec2(0., mtx.y * 1.4), 0.) + textureLod(uMirror, muv - vec2(0., mtx.y * 1.4), 0.)) * .2
    + (textureLod(uMirror, muv + vec2(mtx.x * .8, 0.), 0.) + textureLod(uMirror, muv - vec2(mtx.x * .8, 0.), 0.)) * .15;
  mir *= uHasMirror * uMirrorAmt;
  vec3 refl = mir.rgb + sky * (1. - mir.a);
  refl = mix(refl, uWaterTint, .14);

  // depth tone: a few flat bands from deep (looking down / near) to pure mirror (grazing)
  float F = pow(1. - vy, 3.);
  float Fq = clamp(stepAA(F * 3. + (n - .5) * 1.3) / 3., 0., 1.);
  vec3 col = mix(uWaterDeep, refl, mix(uDeepMin, 1., Fq));
  col = mix(col, mix(col, uWaterTint, .3), gq * .65);

  // towards the low sun the water glows: a warm column in two flat steps
  float sunAz = atan(uSunDir.z, uSunDir.x), sunEl = asin(clamp(uSunDir.y, -1., 1.));
  float dAz = abs(mod(az - sunAz + 3.14159265, 6.2831853) - 3.14159265);
  float low = smoothstep(.8, .42, uSunDir.y) * uSunAmt * uSunPath;
  float pw = .05 + .3 * vy;
  float fall = exp(-max(el - sunEl, 0.) / .4) * exp(-max(sunEl - el, 0.) / .55);
  float path = exp(-dAz * dAz / (pw * pw)) * fall * low;
  float glow = exp(-dAz * dAz / (pw * pw * 7.)) * fall * low;
  float glowQ = clamp(stepAA(glow * 2.7 + (n - .5) * 1.5) * .5, 0., 1.);
  col = mix(col, mix(uSkyHorSun, uHazeSun, .5), glowQ * uSunGlow);

  // shadows of things standing in / over the water: darker, cooler, cut by the same ripples
  float sh = waterShadow(vW, uRight * (lvl * .22) + fwd2 * ((n - .5) * .3));

  // shallows: the bed shows through in two steps
  float shal = 1. - smoothstep(.03, .4, depth);
  if (shal > .001){
    vec3 bedC = paintLight(groundStudy(xz), sh, 0.) * vec3(.84, .93, .96);
    float sq = clamp(stepAA(shal * 2.2 + (n - .5) * .7) * .5, 0., 1.);
    col = mix(col, mix(bedC, col, .22), sq * .85);
  }
  col *= mix(uShadowTint * 1.2 + vec3(.1, .12, .16), vec3(1.), sh);

  // glints: flat hard-edged squiggles, sparse everywhere, dense along the sun's path
  vec2 wg = xz - uWind.xy * (uTime * uRippleSpeed * 1.5);
  vec2 qg = vec2(dot(wg, uRight), dot(wg, fwd2));
  float gA = bandNoise(qg, max(vec2(pxS * 64., pxD * 11.), vec2(.3, .05)), 21.3, vec2(uTime * .05, uTime * .3), .28);   // dashes
  float kpx = uRefPx / uPxAngle;                                  // output pixels per reference pixel
  // squiggles ride the crests of the ripple field (the cut between two reflection slices)
  float fx = max(fwidth(xr), 1e-4), lw2 = 1.25 * kpx;
  float crest = (1. - smoothstep(lw2 - .7, lw2 + .7, abs(xr - .5) / fx)) * step(abs(xr - .5), .3);
  float crest2 = (1. - smoothstep(lw2 - .7, lw2 + .7, abs(xr + 1.5) / fx)) * step(abs(xr + 1.5), .3);
  float dens = clamp(uGlintAmt * (.5 + .3 * gq), 0., 1.);
  float catchL = smoothstep(0., .05, gB - mix(.74, .45, dens));
  float white = crest * catchL * smoothstep(.4, .47, gA);
  // the sun's path: stacked flat dashes, warm at the rim and white in the core
  float ga = clamp(fwidth(gA) * .8, .003, .2);
  float Tp = mix(1.12, .63, path) - (gB - .5) * .3;
  float spark = smoothstep(Tp - ga, Tp + ga, gA);
  float warm = smoothstep(Tp - .14 - ga, Tp - .14 + ga, gA) * smoothstep(.02, .1, path);
  white = max(white, max(spark, max(crest, crest2) * smoothstep(.25, .5, path)));
  white *= (.3 + .7 * sh) * (1. - .35 * uNight);
  col = mix(col, mix(uSkyHorSun, uGlint, .3), warm * .75);
  col = mix(col, mix(uGlint, vec3(1.), .45 * smoothstep(.2, .6, path)), white);

  // wet edge: a thin broken light line that laps along the waterline
  float dw = fwidth(depth);
  float lw = clamp(1.3 * kpx * dw, .007, .5);
  float lap = .012 + .03 * (.5 + .5 * sin(uTime * .85 + vnoise(xz * .11) * 14.));
  float lineD = abs(depth - lap - lw) - lw;
  float line = 1. - smoothstep(-dw * .6, dw * .6, lineD);
  line *= smoothstep(.36, .44, vnoise(xz * .55 + 9.1) + .12 * sin(uTime * .6 + xz.x * .7));
  col = mix(col, mix(refl, uGlint, .8), line * (.9 - .3 * uNight));

  paintOut(applyHaze(col, vW), 1., mix(1., .2, max(white, line * .6)));
`;

// ─────────────────────────────────────────────────────────── lily pads ──
function padGeometry() {
  const seg = 14, wedge = 0.62, pos = [0, 0, 0], idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = wedge / 2 + (i / seg) * (Math.PI * 2 - wedge);
    const rr = 1 + 0.045 * Math.sin(a * 3 + 0.7);
    pos.push(Math.cos(a) * rr, 0, Math.sin(a) * rr);
  }
  for (let i = 0; i < seg; i++) idx.push(0, i + 2, i + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function blossomGeometry() {
  const pos = [], pc = [];
  const tri = (a, b, c, tone, tint) => { pos.push(...a, ...b, ...c); for (let k = 0; k < 3; k++) pc.push(tone, tint); };
  const ring = (n, r0, y0, rm, ym, hw, r1, y1, rot, toneLo, toneHi) => {
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const B = [ca * r0, y0, sa * r0], T = [ca * r1, y1, sa * r1];
      const L = [ca * rm - sa * hw, ym, sa * rm + ca * hw], R = [ca * rm + sa * hw, ym, sa * rm - ca * hw];
      tri(B, L, R, toneLo, 1); tri(L, T, R, toneHi, 1);
    }
  };
  ring(7, 0.12, 0.04, 0.74, 0.3, 0.32, 1.0, 0.6, 0, 0.8, 1.0);      // outer petals, open
  ring(5, 0.08, 0.1, 0.4, 0.55, 0.26, 0.5, 1.0, 0.4, 0.88, 1.06);   // inner petals, upright
  for (let i = 0; i < 6; i++) {                                      // yellow heart
    const a0 = (i / 6) * Math.PI * 2, a1 = ((i + 1) / 6) * Math.PI * 2;
    tri([0, 0.62, 0], [Math.cos(a1) * 0.24, 0.5, Math.sin(a1) * 0.24], [Math.cos(a0) * 0.24, 0.5, Math.sin(a0) * 0.24], 1, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('pc', new THREE.Float32BufferAttribute(pc, 2));
  g.computeVertexNormals();
  return g;
}

function placePads(density) {
  const rng = makeRng(90210);
  const target = Math.max(90, Math.round(430 * density));
  const pads = [];
  const ok = (x, z, r) => {
    if (shoreDist(x, z) > -1.1 - r) return false;
    if (x > JETTY.x1 - 2 && x < JETTY.x0 + 3 && Math.abs(z - JETTY.z) < 1.5 + r) return false;
    for (const p of pads) { const dx = p.x - x, dz = p.z - z, rr = (p.r + r) * 1.04; if (dx * dx + dz * dz < rr * rr) return false; }
    return true;
  };
  // drifts: mostly in the ring near the shore, some around the wheel, two by the jetty's foot
  const clusters = [{ cx: 53.5, cz: 14.6, s: 2.6, a: 0.5, e: 0.6, w: 1.5, bloom: 1 }, { cx: 49, cz: 2.4, s: 2.2, a: 2.2, e: 0.7, w: 1.1, bloom: 1 }];
  for (let c = 0; c < 30; c++) {
    let cx, cz;
    if (c % 10 < 7) {
      const th = rng.range(0, Math.PI * 2), R = pondRadius(th) - rng.range(2.5, 15.5);
      cx = Math.cos(th) * R; cz = Math.sin(th) * R;
    } else {
      const a = rng.range(0, Math.PI * 2), R = rng.range(4, 17);
      cx = WHEEL.x + Math.cos(a) * R; cz = WHEEL.z + Math.sin(a) * R;
    }
    clusters.push({ cx, cz, s: rng.range(1.4, 4.2), a: rng.range(0, Math.PI), e: rng.range(0.45, 1), w: rng.range(0.5, 1.6) });
  }
  const wsum = clusters.reduce((s, c) => s + c.w, 0);
  for (let guard = 0; pads.length < target && guard < target * 60; guard++) {
    let pick = rng() * wsum, c = clusters[0];
    for (const k of clusters) { pick -= k.w; if (pick <= 0) { c = k; break; } }
    const u = (rng() + rng() + rng() - 1.5) * 1.35, v = (rng() + rng() + rng() - 1.5) * 1.35 * c.e;
    const x = c.cx + (Math.cos(c.a) * u - Math.sin(c.a) * v) * c.s, z = c.cz + (Math.sin(c.a) * u + Math.cos(c.a) * v) * c.s;
    const r = 0.15 + 0.3 * Math.pow(rng(), 1.4), rot = rng.range(0, Math.PI * 2), flower = rng() * (c.bloom ? 0.55 : 1);
    if (!ok(x, z, r)) continue;
    pads.push({ x, z, r, rot, flower, squash: rng.range(0.88, 1) });
  }
  return pads;
}

function buildPads(world, group) {
  const pads = placePads(world.quality.density);
  const padMat = paintMaterial({
    name: 'lilypad',
    vertexPars: `varying vec2 vPad; varying vec2 vC; varying float vSeed;`,
    vertexMain: `vPad = position.xz;`,
    vertexWorld: /* glsl */ `
      vec3 o = M[3].xyz; float sd = hash12(o.xz * 7.31 + 1.7);
      vSeed = sd; vC = o.xz;
      wp.y += sin(uTime * 1.15 + sd * 43.) * .01 + sin(uTime * .7 + o.x * .31 + o.z * .23) * .006
            + dot(wp.xz - o.xz, vec2(cos(sd * 31.), sin(sd * 31.))) * .02 * sin(uTime * .9 + sd * 17.);
    `,
    fragmentPars: `varying vec2 vPad; varying vec2 vC; varying float vSeed;`,
    fragmentMain: /* glsl */ `
      float r = length(vPad);
      vec3 base = vSeed < .38 ? uLeafLight : (vSeed < .74 ? mix(uLeafMid, uGrassB, .55) : mix(uLeafMid, uLeafDark, .22));
      float rim = paintBand(r, .8, .03);
      base *= 1. - .17 * rim;
      vec2 dirW = normalize(vW.xz - vC + 1e-5);
      float hi = paintBand(dot(dirW, normalize(uSunDir.xz + 1e-4)) * r, .3, .04) * (1. - rim);
      float sh = getShadow(vW + vec3(0., .06, 0.), vec2(0.));
      vec3 col = paintLight(base, sh, hi * .8);
      paintOut(applyHaze(col, vW), 1., .6);
    `,
  });
  const mesh = new THREE.InstancedMesh(padGeometry(), padMat, pads.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), s = new THREE.Vector3(), p = new THREE.Vector3();
  pads.forEach((pad, i) => {
    q.setFromAxisAngle(up, pad.rot);
    m.compose(p.set(pad.x, 0.035, pad.z), q, s.set(pad.r, 1, pad.r * pad.squash));
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false; mesh.name = 'lilypads';
  register(world.pipeline, mesh, { cast: false, reflect: true });
  group.add(mesh);

  // blossoms: a cup of upright petal dabs on a few of the larger pads
  const flowers = pads.filter((pad) => pad.r > 0.25 && pad.flower < 0.24);
  if (flowers.length) {
    const tints = new Float32Array(flowers.length * 3);
    const bMat = paintMaterial({
      name: 'lilyblossom', side: THREE.DoubleSide,
      vertexPars: `attribute vec2 pc; attribute vec3 aTint; varying vec3 vBase;`,
      vertexMain: `vBase = mix(vec3(1., .8, .22), aTint * pc.x, pc.y);`,
      vertexWorld: /* glsl */ `
        vec3 o = M[3].xyz; float sd = hash12(o.xz * 7.31 + 1.7);
        wp.y += sin(uTime * 1.15 + sd * 43.) * .01 + sin(uTime * .7 + o.x * .31 + o.z * .23) * .006;
      `,
      fragmentPars: `varying vec3 vBase;`,
      fragmentMain: /* glsl */ `
        float sh = getShadow(vW + vec3(0., .1, 0.), vec2(0.));
        paintOut(applyHaze(paintLight(vBase, sh, 0.), vW), 1., .35);
      `,
    });
    const geo = blossomGeometry();
    const bm = new THREE.InstancedMesh(geo, bMat, flowers.length);
    flowers.forEach((pad, i) => {
      const sc = 0.13 + pad.r * 0.2;
      q.setFromAxisAngle(up, pad.rot * 1.7);
      m.compose(p.set(pad.x, 0.05, pad.z), q, s.set(sc, sc * 0.95, sc));
      bm.setMatrixAt(i, m);
      const pink = pad.flower < 0.14;
      tints.set(pink ? [1.0, 0.55, 0.72] : [1.0, 0.97, 0.93], i * 3);
    });
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints, 3));
    bm.instanceMatrix.needsUpdate = true;
    bm.frustumCulled = false; bm.name = 'lilyblossoms';
    register(world.pipeline, bm, { cast: false, reflect: true });
    group.add(bm);
  }
  return pads.length;
}

// ─────────────────────────────────────────────────────────────── reeds ──
function bladeGeometry() {
  const ys = [0, 0.28, 0.56, 0.8, 1], hw = [0.5, 0.5, 0.44, 0.3, 0.02];
  const pos = [], kind = [], idx = [];
  ys.forEach((y, i) => { pos.push(-hw[i], y, 0, hw[i], y, 0); kind.push(0, 0); });
  for (let i = 0; i < ys.length - 1; i++) { const b = i * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('kind', new THREE.Float32BufferAttribute(kind, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
function headGeometry() {
  const n = 6, r = 0.62, y0 = 0.76, y1 = 0.9, pos = [], idx = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pos.push(Math.cos(a) * r, y0, Math.sin(a) * r, Math.cos(a) * r, y1, Math.sin(a) * r); }
  pos.push(0, y0 - 0.012, 0, 0, y1 + 0.012, 0);
  const lo = n * 2, hi = n * 2 + 1;
  for (let i = 0; i < n; i++) {
    const a = i * 2, b = ((i + 1) % n) * 2;
    idx.push(a, a + 1, b, a + 1, b + 1, b, lo, a, b, hi, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('kind', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3).fill(1), 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function placeReeds(density) {
  const rng = makeRng(7719);
  const blades = [];
  const N = 260;
  for (let i = 0; i < N; i++) {
    const th = ((i + rng()) / N) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
    // irregular stands with gaps: presence follows a noise along the shore
    const pres = valueNoise2(c * 3.2 + 11.3, s * 3.2 + 4.1) * 0.6 + valueNoise2(c * 9 + 2, s * 9 + 7) * 0.4;
    const strength = smoothstep(0.47, 0.64, pres);
    const hS = rng.range(1.3, 2.0), cattails = rng() < 0.5, sd0 = rng.range(-0.45, 1.2), nB = rng.range(9, 20);
    if (strength <= 0) continue;
    const R = pondRadius(th) + sd0, cx = c * R, cz = s * R;
    const count = Math.round(nB * (0.4 + 0.8 * strength) * (0.35 + 0.65 * density));
    for (let k = 0; k < count; k++) {
      const al = rng.range(-1, 1) * 1.5, ra = rng.range(-1, 1) * 0.6;
      const x = cx - s * al + c * ra, z = cz + c * al + s * ra;
      const h = Math.min(2.2, Math.max(1.2, hS * rng.range(0.78, 1.14)));
      const w = rng.range(0.04, 0.06), seed = rng(), lean = rng.range(0.03, 0.24), la = rng.range(0, Math.PI * 2), head = cattails && rng() < 0.26;
      const sd = shoreDist(x, z);
      if (sd < -0.6 || sd > 1.5) continue;
      if (x > 38 && z > 2.2 && z < 15.5) continue;            // the jetty and the old path meet the shore here
      const y0 = heightAt(x, z) - 0.04;
      const hTot = h + Math.max(0, -y0);
      // lean away from the middle of the stand, cattail stalks stand straighter
      let lx = (x - cx) * 0.25 + Math.cos(la) * 0.5, lz = (z - cz) * 0.25 + Math.sin(la) * 0.5;
      const ll = Math.hypot(lx, lz) || 1, lm = (head ? 0.25 : 1) * lean * h;
      blades.push({ x, y: y0, z, w, h: hTot, lx: (lx / ll) * lm, lz: (lz / ll) * lm, seed, head });
    }
  }
  return blades;
}

function buildReeds(world, group, shared) {
  const blades = placeReeds(world.quality.density);
  const mat = paintMaterial({
    name: 'reed', side: THREE.DoubleSide,
    uniforms: { uRefPx: shared.uRefPx },
    vertexPars: `uniform float uRefPx; attribute vec3 aLean; attribute float kind; varying float vH; varying float vSeed; varying float vKind;`,
    // blades turn to face the viewer (flat chunky strokes) and never get thinner than a brush mark
    vertexMain: /* glsl */ `
      float hh = pos.y;
      vec3 root = M[3].xyz;
      float bw = length(M[0].xyz), bh = length(M[1].xyz);
      float kfar = max(1., 1.25 * distance(root, uCamPos) * uRefPx / bw);
      vec3 lp = vec3(pos.x * kfar, pos.y, pos.z * kfar);
      vH = hh; vSeed = aLean.z; vKind = kind;
    `,
    vertexWorld: /* glsl */ `
      vec2 toC = uCamPos.xz - root.xz; toC /= max(length(toC), 1e-3);
      vec2 sd2 = vec2(-toC.y, toC.x);
      wp = vec4(root + vec3(sd2.x, 0., sd2.y) * (lp.x * bw) + vec3(0., lp.y * bh, 0.) + vec3(toC.x, 0., toC.y) * (lp.z * bw), 1.);
      wp.xz += aLean.xy * hh * hh;
      float g = gustAt(root.xz);
      float ph = aLean.z * 6.2831853;
      float flut = sin(uTime * 1.9 + ph) * .03 + sin(uTime * 3.1 + ph * 2.3) * .015;
      float bend = (.04 + .24 * g + flut * (.7 + g)) * hh * hh * bh;
      wp.xz += uWind.xy * bend + vec2(-uWind.y, uWind.x) * (sin(uTime * 1.3 + ph * 1.9) * .018 * hh * bh);
      wp.y -= bend * bend * .4 / max(bh, .2);
      wn = normalize(vec3(toC.x, .6, toC.y));
    `,
    fragmentPars: `varying float vH; varying float vSeed; varying float vKind;`,
    fragmentMain: /* glsl */ `
      vec3 lo = mix(uLeafMid, uGrassB, .2 + .5 * vSeed);
      vec3 up = mix(uGrassB, uGrassA, .35 + .5 * fract(vSeed * 7.3));
      vec3 base = mix(lo, up, paintBand(vH, .36 + .3 * fract(vSeed * 13.7), .02));
      base = mix(base, uGrassTip, paintBand(vH, .9, .03) * .55);
      base = mix(base, vec3(.8, .71, .42), step(.8, fract(vSeed * 29.1)) * .7);      // last year's dry blades
      base = mix(base, vec3(.43, .26, .15), vKind);                                   // cattail head
      base *= mix(.72, 1., smoothstep(0., .3, vW.y));                                 // wet foot
      float sh = getShadow(vW + uSunDir * .3, vec2(0.));
      float lit = mix(step(.3, fract(vSeed * 3.7)), 1., vKind);                       // part of each stand sits in its own shade
      vec3 col = paintLight(base, lit * sh, 0.);
      paintOut(applyHaze(col, vW), 1., .55);
    `,
  });
  const make = (geo, list, name) => {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const lean = new Float32Array(list.length * 3);
    const m = new THREE.Matrix4();
    list.forEach((b, i) => {
      m.makeScale(b.w, b.h, b.w).setPosition(b.x, b.y, b.z);
      mesh.setMatrixAt(i, m);
      lean.set([b.lx, b.lz, b.seed], i * 3);
    });
    geo.setAttribute('aLean', new THREE.InstancedBufferAttribute(lean, 3));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false; mesh.name = name;
    register(world.pipeline, mesh, { cast: true, reflect: true });
    group.add(mesh);
  };
  make(bladeGeometry(), blades, 'reeds');
  const heads = blades.filter((b) => b.head);
  if (heads.length) make(headGeometry(), heads, 'cattails');
  return blades.length;
}

// ──────────────────────────────────────────────────────────────── part ──
export default async function create(world) {
  const group = new THREE.Group();
  group.name = 'water';
  const pipeline = world.pipeline;

  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  blank.needsUpdate = true;

  // knobs
  const uniforms = {
    ...terrainUniforms,
    uSkyField: skyUniforms.uSkyField, uSkyDrift: skyUniforms.uSkyDrift,
    uMirror: { value: blank }, uReflMatrix: { value: pipeline.reflMatrix }, uHasMirror: { value: 0 },
    uRight: { value: new THREE.Vector2(1, 0) }, uRefPx: { value: 0.00115 }, uReflScale: { value: new THREE.Vector2(0.7, 1.2) },
    uRippleAmp: { value: 13 },      // slice offset, in 720p pixels
    uRippleSpeed: { value: 0.22 },  // drift with the wind, m/s
    uSlice: { value: 0.15 },         // 0 smooth mirror … 1 reflection fully cut into horizontal slabs
    uSliceH: { value: 11 },         // slab height, in 720p pixels
    uGlintAmt: { value: 1 },        // sparse scatter of white squiggles
    uSunPath: { value: 1 },         // dense sparkle towards the low sun
    uSunGlow: { value: 0.3 },       // warm glow column under the low sun
    uDeepMin: { value: 0.36 },      // how much reflection is left when looking straight down
    uMirrorAmt: { value: 1 },       // strength of the mirrored world image
  };
  const waterMat = paintMaterial({
    name: 'water', uniforms,
    vertexPars: `attribute float bed; varying float vBed;`,
    vertexMain: `vBed = bed;`,
    fragmentPars: WATER_PARS,
    fragmentMain: WATER_MAIN,
  });
  const surface = new THREE.Mesh(buildSurfaceGeometry(), waterMat);
  surface.name = 'pond';
  surface.frustumCulled = false;
  group.add(surface);       // not a shadow caster, not in the mirror layer

  let wantMirror = false;
  const syncMirror = () => {
    const tex = wantMirror ? pipeline.reflRT?.texture : null;
    uniforms.uMirror.value = tex || blank;
    uniforms.uHasMirror.value = tex ? 1 : 0;
    uniforms.uReflMatrix.value = pipeline.reflMatrix;
    waterMat.uniformsNeedUpdate = true;
  };
  surface.onBeforeRender = syncMirror;      // the mirror target is created lazily, after update()

  const padCount = buildPads(world, group);
  const reedCount = buildReeds(world, group, uniforms);

  const right = new THREE.Vector3();
  return {
    group, uniforms, material: waterMat, surface, padCount, reedCount,
    update(t, camera, state) {
      right.set(1, 0, 0).applyQuaternion(camera.quaternion);
      const l = Math.hypot(right.x, right.z) || 1;
      uniforms.uRight.value.set(right.x / l, right.z / l);
      const th = Math.tan((camera.fov * Math.PI) / 360);
      uniforms.uRefPx.value = (2 * th) / 720;
      uniforms.uReflScale.value.set(0.5 / (th * (camera.aspect || 16 / 9)), 0.5 / th);
      wantMirror = !!state?.reflect;
      syncMirror();
    },
  };
}
