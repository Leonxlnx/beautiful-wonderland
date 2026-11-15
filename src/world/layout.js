// World layout and the terrain height function. Units are metres, Y is up.
// West (sunset) is -X, south is +Z. The pond sits at the origin.
import { makeRng, valueNoise2, fbm2 } from '../core/rng.js';

export const TERRAIN_SIZE = 760;
export const POND = { x: 0, z: 0, r: 50 };
export const WHEEL = { x: -20, z: 8, radius: 19, sink: 2.6 };
export const HILL = { x: -112, z: -74, h: 20, s: 36 };
export const FOREST = { x: 62, z: -132, r: 80 };
// old promenade: from the forest edge down to the east shore
export const PATH = [[118, -92], [92, -66], [74, -40], [62, -18], [56, 2], [52, 8]];
// jetty from the east shore out to the wheel's boarding platform
export const JETTY = { x0: 53, x1: 6, z: 8, y: 0.55 };

export function pondRadius(theta) {
  return POND.r + 8 * Math.sin(2 * theta + 1.0) + 5.5 * Math.sin(3 * theta + 0.3) + 3.5 * Math.sin(5 * theta + 2.1);
}
// signed distance to the shoreline (negative = in the pond), approximate
export function shoreDist(x, z) {
  const dx = x - POND.x, dz = z - POND.z;
  const d = Math.hypot(dx, dz);
  return d - pondRadius(Math.atan2(dz, dx));
}
function segDist(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az, wx = px - ax, wz = pz - az;
  const t = Math.max(0, Math.min(1, (wx * vx + wz * vz) / (vx * vx + vz * vz)));
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}
export function pathDist(x, z) {
  let d = 1e9;
  for (let i = 0; i < PATH.length - 1; i++) d = Math.min(d, segDist(x, z, PATH[i][0], PATH[i][1], PATH[i + 1][0], PATH[i + 1][1]));
  return d;
}
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function heightAt(x, z) {
  let h = 2.4 + (fbm2(x * 0.0075 + 3.1, z * 0.0075 + 1.7) - 0.5) * 13 + (fbm2(x * 0.031 + 9, z * 0.031) - 0.5) * 2.2;
  // kite hill
  const hx = x - HILL.x, hz = z - HILL.z;
  h += HILL.h * Math.exp(-(hx * hx + hz * hz) / (2 * HILL.s * HILL.s));
  // low western ridge that the sun sets behind
  h += 13 * sstep(-190, -330, x) * (0.55 + 0.45 * valueNoise2(z * 0.012 + 4, 2.2));
  // rising ground under the forest
  const fx = x - FOREST.x, fz = z - FOREST.z;
  h += 4 * Math.exp(-(fx * fx + fz * fz) / (2 * 70 * 70));
  // flatten the promenade a little
  const pd = pathDist(x, z);
  h = h + (2.1 - h) * 0.55 * sstep(9, 1.5, pd);
  // pond basin with a gentle shore
  const sd = shoreDist(x, z);
  const bed = Math.max(-1.7, -0.22 + sd * 0.13);
  h = bed + (h - bed) * sstep(-2, 13, sd);
  return h;
}

export function normalAt(x, z, e = 0.6) {
  const hx = heightAt(x + e, z) - heightAt(x - e, z), hz = heightAt(x, z + e) - heightAt(x, z - e);
  const nx = -hx, ny = 2 * e, nz = -hz, l = Math.hypot(nx, ny, nz);
  return [nx / l, ny / l, nz / l];
}
export function forestAmount(x, z) {
  const d = Math.hypot(x - FOREST.x, z - FOREST.z);
  return sstep(FOREST.r + 12, FOREST.r - 14, d + (valueNoise2(x * 0.04, z * 0.04) - 0.5) * 26);
}
export { makeRng };
