import * as THREE from 'three';
import { paintMaterial, register } from '../core/materials.js';
import { strokeLayer } from '../core/glsl.js';
import { TERRAIN_SIZE, heightAt, normalAt, shoreDist, pathDist, forestAmount } from './layout.js';
import { hex } from '../core/env.js';
import { valueNoise2, fbm2, smoothstep } from '../core/rng.js';

// Ground: a height field painted with world-anchored brush strokes. Strokes keep a constant size on
// the canvas (they get bigger in the world with distance), follow the wind, and take their paint from a
// colour study of the land — meadow greens, dry patches, the old path, the wet shore.

const TEX = 512;

function bakeInfo() {
  // r = height, g = path, b = signed shore distance, a = forest floor
  const data = new Uint16Array(TEX * TEX * 4);
  const toH = THREE.DataUtils.toHalfFloat;
  for (let j = 0; j < TEX; j++) for (let i = 0; i < TEX; i++) {
    const x = ((i + 0.5) / TEX - 0.5) * TERRAIN_SIZE, z = ((j + 0.5) / TEX - 0.5) * TERRAIN_SIZE;
    const pd = pathDist(x, z) + (valueNoise2(x * 0.35, z * 0.35) - 0.5) * 1.6;
    const o = (j * TEX + i) * 4;
    data[o] = toH(heightAt(x, z));
    data[o + 1] = toH(smoothstep(3.1, 1.5, pd));
    data[o + 2] = toH(Math.max(-8, Math.min(30, shoreDist(x, z))));
    data[o + 3] = toH(forestAmount(x, z));
  }
  const tex = new THREE.DataTexture(data, TEX, TEX, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export const terrainUniforms = { uTerrainTex: { value: null }, uTerrainSize: { value: TERRAIN_SIZE } };

// GLSL shared with grass / water: terrain info lookups and the ground colour study.
export const GROUND_GLSL = /* glsl */ `
uniform sampler2D uTerrainTex; uniform float uTerrainSize;
vec4 terrainInfo(vec2 xz){ return textureLod(uTerrainTex, xz / uTerrainSize + .5, 0.); }
vec3 groundStudy(vec2 xz){
  vec4 ti = terrainInfo(xz);
  float n1 = fbm(xz * .028);
  float n2 = vnoise(xz * .0085 + 7.3);
  float n3 = vnoise(xz * .11 + 2.1);
  vec3 c = mix(uGrassA, uGrassB, smoothstep(.36, .64, n1));
  c = mix(c, uGrassC, smoothstep(.5, .78, n2) * .6);
  c *= .95 + .1 * n3;
  c = mix(c, uGrassB * vec3(.62, .74, .76), ti.a * .8);                 // forest floor
  vec3 dirt = mix(vec3(.78, .72, .58), vec3(.66, .64, .56), n3);
  c = mix(c, dirt, ti.g * (.55 + .45 * smoothstep(.35, .6, n1 + n3 * .3)));   // cracked old path, grass breaking through
  float sd = ti.b;
  c = mix(c, vec3(.5, .52, .36), smoothstep(2.4, .3, sd) * .7);          // muddy shore
  c = mix(c, uWaterDeep * .9 + vec3(.02, .05, .04), smoothstep(.3, -1.6, sd));   // pond bed
  return c;
}
`;

export function createTerrain(pipeline) {
  const seg = 320, size = TERRAIN_SIZE;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, heightAt(x, z));
    const n = normalAt(x, z, 1.2);
    nor.setXYZ(i, n[0], n[1], n[2]);
  }
  geo.computeBoundingSphere(); geo.computeBoundingBox();
  terrainUniforms.uTerrainTex.value = bakeInfo();

  const mat = paintMaterial({
    name: 'ground',
    uniforms: { ...terrainUniforms, uGroundQ: { value: 1 } },
    fragmentPars: /* glsl */ `
      ${GROUND_GLSL}
      float groundAngle(vec2 c){ return atan(uWind.y, uWind.x) + (vnoise(c * .04) - .5) * 2.6; }
      float gExist = 1.;
      ${strokeLayer('gStroke', { angleExpr: 'groundAngle(c)', existExpr: 'gExist', wrapN: '0.' })}
    `,
    fragmentMain: /* glsl */ `
      vec3 N = normalize(vN);
      vec3 V = uCamPos - vW; float dist = length(V); V /= dist;
      float px = dist * uPxAngle / max(dot(V, N), .22);
      // constant on-canvas stroke size: world cell grows with distance in octaves, fine strokes thin out
      float lodf = log2(max(dist, 1.5) * .034 / .25);
      float l0 = floor(lodf), f = lodf - l0;
      float sFine = .25 * exp2(l0), sCoarse = sFine * 2.;
      vec2 q = vW.xz;
      vec3 col = groundStudy(q);
      float seed = .5;
      vec4 best = vec4(0., 0., 0., -1.), bestL = vec4(0.), second = vec4(0., 0., 0., -1.); vec2 bc = vec2(0.);
      gExist = 1.;
      gStroke(q, sCoarse, px, 3., 1.2, .46, best, bestL, bc, second);
      if (second.w >= 0.){ vec3 c2 = groundStudy(second.xy) * (1. + (second.w - .5) * .1); col = mix(col, c2, second.z); }
      if (best.w >= 0.){ vec3 c1 = groundStudy(best.xy) * (1. + (best.w - .5) * .1); col = mix(col, c1, best.z); seed = best.w; }
      best = vec4(0., 0., 0., -1.); second = vec4(0., 0., 0., -1.);
      gExist = 1. - f;
      gStroke(q, sFine, px, 7., 1.2, .44, best, bestL, bc, second);
      if (second.w >= 0.){ vec3 c2 = groundStudy(second.xy) * (1. + (second.w - .5) * .12); col = mix(col, c2, second.z); }
      if (best.w >= 0.){
        vec3 c1 = groundStudy(best.xy) * (1. + (best.w - .5) * .12);
        col = mix(col, c1, best.z); seed = mix(seed, best.w, best.z);
      }
      // light: crisp terminator with per-stroke jitter, tree shadows with wobbling edges, drifting cloud shade
      float n1 = vnoise(q * .7), n2 = vnoise(q * 2.3 + 5.);
      float ndl = dot(N, uSunDir);
      float lit = paintBand(ndl + (seed - .5) * .12 + (n1 - .5) * .1, .1, .03);
      float sh = getShadow(vW + N * .12, vec2(n1 - .5, n2 - .5) * .22);
      vec2 cq = q + uWind.xy * uTime * 2.2;
      float cloud = smoothstep(.5, .62, fbm(cq * .0075 + 4.) + (seed - .5) * .05);
      float light = lit * sh * (1. - cloud * .62);
      vec3 c = paintLight(col, light, 0.);
      float gust = gustAt(q);
      c = mix(c, c * 1.1 + vec3(.03, .035, .0) * uSunAmt, gust * .55 * (1. - terrainInfo(q).g));
      paintOut(applyHaze(c, vW), 1., 1.);
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  register(pipeline, mesh, { cast: true, reflect: true });

  // Far ridges: flat hazy silhouettes in rings, pure aerial perspective.
  const group = new THREE.Group();
  group.add(mesh);
  const ridgeMat = paintMaterial({
    name: 'ridge',
    vertexPars: `attribute vec3 color; varying vec3 vCol;`,
    vertexMain: `vCol = color;`,
    fragmentPars: `varying vec3 vCol;`,
    fragmentMain: `
      float n = vnoise(vW.xz * .02 + vW.y * .05);
      float lit = paintBand(dot(normalize(vN), uSunDir) + (n - .5) * .5, .05, .05);
      vec3 c = paintLight(vCol * (.92 + .16 * n), lit, 0.);
      paintOut(applyHaze(c, vW), 1., 1.);
    `,
  });
  const rings = [
    { r: 395, h: 26, base: hex(0x7fae52), seed: 1.3, f: 5 },
    { r: 560, h: 52, base: hex(0x6a9d58), seed: 4.1, f: 4 },
    { r: 820, h: 95, base: hex(0x5d8f66), seed: 8.7, f: 3 },
    { r: 1250, h: 170, base: hex(0x577f76), seed: 12.9, f: 2.4 },
  ];
  for (const ring of rings) {
    const N = 360, pts = [], cols = [], nrm = [], idx = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const nx = Math.cos(a), nz = Math.sin(a);
      // periodic profile: sample noise on a circle
      const prof = fbm2(Math.cos(a) * ring.f + ring.seed, Math.sin(a) * ring.f + ring.seed * 1.7, 5);
      const hTop = ring.h * (0.25 + 1.5 * Math.max(0, prof - 0.22));
      const rr = ring.r * (1 + 0.06 * Math.sin(a * 3 + ring.seed));
      pts.push(nx * rr, -6, nz * rr, nx * (rr + 30), hTop, nz * (rr + 30));
      nrm.push(-nx * 0.5, 0.86, -nz * 0.5, -nx * 0.5, 0.86, -nz * 0.5);
      for (let k = 0; k < 2; k++) cols.push(ring.base.x, ring.base.y, ring.base.z);
      if (i < N) { const b = i * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, ridgeMat);
    m.material.side = THREE.DoubleSide;
    m.frustumCulled = false;
    register(pipeline, m, { cast: false, reflect: true });
    group.add(m);
  }
  return { group, mesh, material: mat };
}
