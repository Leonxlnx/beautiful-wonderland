import * as THREE from 'three';

// Paint-space colour helpers: hex is taken as the final on-screen colour.
export const hex = (h) => new THREE.Vector3(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255);
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const dirFrom = (azDeg, elDeg) => {
  const a = (azDeg * Math.PI) / 180, e = (elDeg * Math.PI) / 180;
  return v3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e));
};

// West (where the sun sets) is -X, south is +Z. Azimuth is measured as atan2(z, x).
// Four keys: 0 noon · 1 golden hour · 2 sunset · 3 dusk
export const KEYS = [
  {
    name: 'noon',
    sunDir: dirFrom(118, 56),
    sunTint: v3(1.04, 1.0, 0.92), shadowTint: v3(0.34, 0.5, 0.66), ambientAdd: v3(0.015, 0.05, 0.085), sunAmt: 1,
    skyZen: hex(0x2a84ee), skyMid: hex(0x3d9bf4), skyLow: hex(0x70b7f6), skyHor: hex(0xb4dbf7), skyHorSun: hex(0xd8edfb),
    sunDisc: hex(0xfffbe6), sunDiscAmt: 0.0,
    cloudLit: hex(0xffffff), cloudMid: hex(0xe6effb), cloudSh: hex(0xa4bfe9), cloudDeep: hex(0x7c9dd6),
    hazeNear: hex(0xcfe6f7), hazeFar: hex(0xb2d5f4), hazeSun: hex(0xe4f2fb), fogDensity: 0.00135, fogMax: 0.92,
    impasto: 0.18, jitter: 0.2, cloudCover: 0.5, cloudBase: 0.07, cirrus: 0.12, stars: 0, night: 0,
    leafHi: hex(0xe6f07c), leafLight: hex(0x9fd052), leafMid: hex(0x4f9d4b), leafDark: hex(0x1f5046),
    grassA: hex(0xb4dd52), grassB: hex(0x74b947), grassC: hex(0xd7df66), grassTip: hex(0xe9f58e),
    waterDeep: hex(0x1f5f86), waterTint: hex(0x4aa6e8), glint: hex(0xffffff),
    grade: { lift: v3(0, 0, 0), gain: v3(1, 1, 1), sat: 1.06, contrast: 1.04 },
  },
  {
    name: 'golden',
    sunDir: dirFrom(158, 23),
    sunTint: v3(1.1, 0.985, 0.8), shadowTint: v3(0.38, 0.44, 0.7), ambientAdd: v3(0.03, 0.04, 0.09), sunAmt: 1,
    skyZen: hex(0x3d8ee6), skyMid: hex(0x66a9f0), skyLow: hex(0xb7d5ee), skyHor: hex(0xffe7b2), skyHorSun: hex(0xfff2c4),
    sunDisc: hex(0xfff6d0), sunDiscAmt: 0.5,
    cloudLit: hex(0xfff4dc), cloudMid: hex(0xf8dccb), cloudSh: hex(0xa3a9de), cloudDeep: hex(0x7e88cb),
    hazeNear: hex(0xf1e5c9), hazeFar: hex(0xddd8d8), hazeSun: hex(0xffe8ae), fogDensity: 0.0019, fogMax: 0.93,
    impasto: 0.5, jitter: 0.5, cloudCover: 0.56, cloudBase: 0.065, cirrus: 0.4, stars: 0, night: 0,
    leafHi: hex(0xf6ee7c), leafLight: hex(0xb7cf52), leafMid: hex(0x5c9a4a), leafDark: hex(0x25484d),
    grassA: hex(0xc7dd55), grassB: hex(0x86b84a), grassC: hex(0xe6d766), grassTip: hex(0xf9f094),
    waterDeep: hex(0x2a5c8a), waterTint: hex(0x6aaee6), glint: hex(0xfff6d6),
    grade: { lift: v3(0.004, 0, 0), gain: v3(1.02, 1, 0.98), sat: 1.06, contrast: 1.04 },
  },
  {
    name: 'sunset',
    sunDir: dirFrom(176, 6.5),
    sunTint: v3(1.17, 0.8, 0.6), shadowTint: v3(0.43, 0.35, 0.68), ambientAdd: v3(0.06, 0.03, 0.1), sunAmt: 1,
    skyZen: hex(0x4f68d8), skyMid: hex(0x9a86e2), skyLow: hex(0xff8fa6), skyHor: hex(0xff9d52), skyHorSun: hex(0xffd75e),
    sunDisc: hex(0xfff1b8), sunDiscAmt: 1.0,
    cloudLit: hex(0xffcc72), cloudMid: hex(0xff7f93), cloudSh: hex(0x7b53c2), cloudDeep: hex(0x46389a),
    hazeNear: hex(0xe5a7c0), hazeFar: hex(0xd398c8), hazeSun: hex(0xffbe76), fogDensity: 0.0023, fogMax: 0.94,
    impasto: 1.0, jitter: 1.0, cloudCover: 0.68, cloudBase: 0.06, cirrus: 0.85, stars: 0, night: 0.15,
    leafHi: hex(0xffc46c), leafLight: hex(0xa3a552), leafMid: hex(0x4f6e55), leafDark: hex(0x2a3760),
    grassA: hex(0xd6c658), grassB: hex(0x86a04f), grassC: hex(0xf0c060), grassTip: hex(0xffe08a),
    waterDeep: hex(0x4a3f8e), waterTint: hex(0xd58fc4), glint: hex(0xffe9b0),
    grade: { lift: v3(0.006, 0, 0.004), gain: v3(1.03, 1, 1.0), sat: 1.1, contrast: 1.05 },
  },
  {
    name: 'dusk',
    sunDir: dirFrom(180, -7.5),
    sunTint: v3(0.6, 0.58, 0.86), shadowTint: v3(0.3, 0.29, 0.57), ambientAdd: v3(0.05, 0.04, 0.12), sunAmt: 0,
    skyZen: hex(0x1d2266), skyMid: hex(0x43378d), skyLow: hex(0x9853a6), skyHor: hex(0xf2785c), skyHorSun: hex(0xffae64),
    sunDisc: hex(0xffb070), sunDiscAmt: 0.0,
    cloudLit: hex(0xea8a8c), cloudMid: hex(0x7458a8), cloudSh: hex(0x34306f), cloudDeep: hex(0x212150),
    hazeNear: hex(0x58488c), hazeFar: hex(0x6a4e96), hazeSun: hex(0xc2687a), fogDensity: 0.0021, fogMax: 0.92,
    impasto: 1.0, jitter: 0.9, cloudCover: 0.62, cloudBase: 0.06, cirrus: 0.6, stars: 1, night: 1,
    leafHi: hex(0x8d86a8), leafLight: hex(0x596a86), leafMid: hex(0x364a6e), leafDark: hex(0x20264f),
    grassA: hex(0x9a9fb0), grassB: hex(0x66799a), grassC: hex(0xb09ab0), grassTip: hex(0xc4bfe0),
    waterDeep: hex(0x241f5c), waterTint: hex(0x8a5aa6), glint: hex(0xffc890),
    grade: { lift: v3(0.004, 0, 0.012), gain: v3(1.0, 0.99, 1.03), sat: 1.1, contrast: 1.06 },
  },
];

// Uniform objects shared (by reference) by every material in the world.
export const U = {
  uSunDir: { value: v3(0, 1, 0) }, uSunTint: { value: v3(1, 1, 1) }, uShadowTint: { value: v3(0.4, 0.5, 0.7) },
  uAmbientAdd: { value: v3(0, 0, 0) }, uSunAmt: { value: 1 },
  uHazeNear: { value: v3(1, 1, 1) }, uHazeFar: { value: v3(1, 1, 1) }, uHazeSun: { value: v3(1, 1, 1) },
  uFogDensity: { value: 0.0015 }, uFogMax: { value: 0.9 },
  uTime: { value: 0 }, uWind: { value: v3(0.92, 0.39, 1) }, uCamPos: { value: v3(0, 0, 0) },
  uShadowMap: { value: null }, uShadowMatrix: { value: new THREE.Matrix4() }, uShadowParams: { value: new THREE.Vector4(1 / 4096, 0.00012, 1, 100) },
  uNight: { value: 0 }, uGust: { value: 0 }, uA2C: { value: 1 }, uPxAngle: { value: 0.0005 },
  // sky
  uSkyZen: { value: v3(0, 0, 0) }, uSkyMid: { value: v3(0, 0, 0) }, uSkyLow: { value: v3(0, 0, 0) }, uSkyHor: { value: v3(0, 0, 0) },
  uSkyHorSun: { value: v3(0, 0, 0) }, uSunDisc: { value: v3(1, 1, 1) }, uSunDiscAmt: { value: 0 },
  uCloudLit: { value: v3(1, 1, 1) }, uCloudMid: { value: v3(1, 1, 1) }, uCloudSh: { value: v3(1, 1, 1) }, uCloudDeep: { value: v3(1, 1, 1) },
  uImpasto: { value: 0.3 }, uJitter: { value: 0.3 }, uCloudCover: { value: 0.5 }, uCloudBase: { value: 0.07 }, uStars: { value: 0 }, uCirrus: { value: 0.2 },
  // foliage / grass / water palettes
  uLeafHi: { value: v3(0, 0, 0) }, uLeafLight: { value: v3(0, 0, 0) }, uLeafMid: { value: v3(0, 0, 0) }, uLeafDark: { value: v3(0, 0, 0) },
  uGrassA: { value: v3(0, 0, 0) }, uGrassB: { value: v3(0, 0, 0) }, uGrassC: { value: v3(0, 0, 0) }, uGrassTip: { value: v3(0, 0, 0) },
  uWaterDeep: { value: v3(0, 0, 0) }, uWaterTint: { value: v3(0, 0, 0) }, uGlint: { value: v3(1, 1, 1) },
  // grade
  uLift: { value: v3(0, 0, 0) }, uGain: { value: v3(1, 1, 1) }, uSat: { value: 1 }, uContrast: { value: 1 },
};

const VEC_KEYS = [
  ['sunTint', 'uSunTint'], ['shadowTint', 'uShadowTint'], ['ambientAdd', 'uAmbientAdd'],
  ['skyZen', 'uSkyZen'], ['skyMid', 'uSkyMid'], ['skyLow', 'uSkyLow'], ['skyHor', 'uSkyHor'], ['skyHorSun', 'uSkyHorSun'], ['sunDisc', 'uSunDisc'],
  ['cloudLit', 'uCloudLit'], ['cloudMid', 'uCloudMid'], ['cloudSh', 'uCloudSh'], ['cloudDeep', 'uCloudDeep'],
  ['hazeNear', 'uHazeNear'], ['hazeFar', 'uHazeFar'], ['hazeSun', 'uHazeSun'],
  ['leafHi', 'uLeafHi'], ['leafLight', 'uLeafLight'], ['leafMid', 'uLeafMid'], ['leafDark', 'uLeafDark'],
  ['grassA', 'uGrassA'], ['grassB', 'uGrassB'], ['grassC', 'uGrassC'], ['grassTip', 'uGrassTip'],
  ['waterDeep', 'uWaterDeep'], ['waterTint', 'uWaterTint'], ['glint', 'uGlint'],
];
const NUM_KEYS = [
  ['sunAmt', 'uSunAmt'], ['fogDensity', 'uFogDensity'], ['fogMax', 'uFogMax'], ['impasto', 'uImpasto'], ['jitter', 'uJitter'],
  ['cloudCover', 'uCloudCover'], ['cloudBase', 'uCloudBase'], ['stars', 'uStars'], ['cirrus', 'uCirrus'], ['night', 'uNight'], ['sunDiscAmt', 'uSunDiscAmt'],
];

const smooth = (x) => x * x * (3 - 2 * x);

// tod: 0..3 (fractional = blend between neighbouring keys)
export function setEnv(tod, time) {
  const k = Math.min(Math.max(tod, 0), KEYS.length - 1 - 1e-6);
  const i = Math.floor(k), f = smooth(k - i);
  const A = KEYS[i], B = KEYS[i + 1];
  for (const [a, u] of VEC_KEYS) U[u].value.copy(A[a]).lerp(B[a], f);
  for (const [a, u] of NUM_KEYS) U[u].value = A[a] + (B[a] - A[a]) * f;
  // sun moves along a great-circle arc between the keys
  const qa = A.sunDir, qb = B.sunDir;
  const ang = Math.acos(Math.min(1, qa.dot(qb)));
  if (ang < 1e-4) U.uSunDir.value.copy(qa);
  else {
    const s = Math.sin(ang), lf = k - i;
    U.uSunDir.value.copy(qa).multiplyScalar(Math.sin((1 - lf) * ang) / s).addScaledVector(qb, Math.sin(lf * ang) / s).normalize();
  }
  U.uLift.value.copy(A.grade.lift).lerp(B.grade.lift, f);
  U.uGain.value.copy(A.grade.gain).lerp(B.grade.gain, f);
  U.uSat.value = A.grade.sat + (B.grade.sat - A.grade.sat) * f;
  U.uContrast.value = A.grade.contrast + (B.grade.contrast - A.grade.contrast) * f;
  U.uTime.value = time;
}
