import * as THREE from 'three';
import { U } from '../core/env.js';
import { NOISE, strokeLayer, STROKE_RELIEF } from '../core/glsl.js';

// The sky is a painting on a canvas wrapped around the viewer: x = azimuth, y = elevation (radians).
// 1) a "field" pass paints the smooth colour study (gradient + lit cloud masses) into a strip texture,
// 2) the composite pass lays layered impasto brush strokes that take their paint from that study.
// Strokes are anchored to the canvas, so the camera can move across a stable, living painting.

const EL0 = -0.2, EL1 = 1.5;

const FIELD_COMMON = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 uSunDir; uniform float uTime; uniform float uSkyDrift;
uniform vec3 uSkyZen, uSkyMid, uSkyLow, uSkyHor, uSkyHorSun, uSunDisc; uniform float uSunDiscAmt;
uniform vec3 uCloudLit, uCloudMid, uCloudSh, uCloudDeep, uHazeFar;
uniform float uCloudCover, uCloudBase, uCloudSeed, uNight, uCirrus;
uniform sampler2D tDens; uniform vec2 uDensTexel;
${NOISE}
const float PI = 3.14159265, TAU = 6.2831853;
const float EL0 = ${EL0.toFixed(2)}, EL1 = ${EL1.toFixed(2)};
float wrapA(float a){ return mod(a + PI, TAU) - PI; }
vec2 canvasOf(vec2 uv){ return vec2((uv.x - .5) * TAU, mix(EL0, EL1, uv.y)); }   // (cloud-frame azimuth, elevation)
vec2 sunCanvas(){ return vec2(atan(uSunDir.z, uSunDir.x) + uSkyDrift, asin(clamp(uSunDir.y, -1., 1.))); }
// gradient of the cloud relief, in units per radian
vec2 reliefGrad(vec2 uv){
  vec2 e = uDensTexel * 1.5;
  float hx = texture2D(tDens, uv + vec2(e.x, 0.)).g - texture2D(tDens, uv - vec2(e.x, 0.)).g;
  float hy = texture2D(tDens, uv + vec2(0., e.y)).g - texture2D(tDens, uv - vec2(0., e.y)).g;
  return vec2(hx / (2. * e.x * TAU), hy / (2. * e.y * (EL1 - EL0)));
}
`;

// Pass 1: where the clouds are. r = signed density, g = puffy relief (for shading), b = cirrus veil.
const DENS_FRAG = /* glsl */ `
${FIELD_COMMON}
// One rank of cumulus: flat bases at a common level, towers billowing up from them.
float cumulusRow(vec2 c, float baseE, float hgt, float freq, float seed, float cover, out float relief){
  relief = 0.;
  float y = (c.y - baseE) / hgt;
  if (y < -.25 || y > 1.75) return -1.;
  float R = 2.4 * freq;
  vec3 Pc = vec3(cos(c.x) * R, sin(c.x) * R, seed * 3.7);
  float colN = fbm3lo(Pc * .62 + uCloudSeed) / .875;
  float thr = mix(.74, .3, cover);
  float tower = smoothstep(thr, thr + .2, colN);
  vec3 P = vec3(cos(c.x) * R, sin(c.x) * R, y * 1.25 + seed);
  float t = uTime * .008;
  float bil = fbm3(P * 1.5 + vec3(0., 0., t) + 3.1);
  float top = tower * (.28 + 1.3 * bil);
  float v = (top - y) * .5;
  v = min(v, y * 2. + .012);
  v = min(v, tower * 2.5 - .05);
  float puff = fbm3(P * 3.4 + 9.7 + vec3(0., 0., t * 1.7));
  relief = sqrt(clamp(v * 3.2, 0., 1.)) * .75 + puff * .36 * smoothstep(0., .05, v);
  return v;
}
void main(){
  vec2 c = canvasOf(vUv);
  float cv = uCloudCover;
  float r, rel = 0., v = -1., a;
  // nearest rank first: it hides the ranks behind it
  a = cumulusRow(c, .40, .50, .55, 1.3, cv, r); v = a; rel = r;
  if (v <= 0.){ a = cumulusRow(c, .22, .30, .9, 4.7, cv, r); if (a > v){ v = a; rel = r; } }
  if (v <= 0.){ a = cumulusRow(c, .11, .16, 1.6, 8.1, cv + .05, r); if (a > v){ v = a; rel = r; } }
  if (v <= 0.){ a = cumulusRow(c, uCloudBase, .085, 2.8, 12.4, cv + .1, r); if (a > v){ v = a; rel = r; } }
  // high streaks of cirrus that catch the last light
  float R = 2.4;
  vec3 P = vec3(cos(c.x) * R, sin(c.x) * R, c.y * 11. + sin(c.x) * 1.4);
  float n = fbm3(P * 1.1 + 31. + uCloudSeed);
  float band = smoothstep(.1, .3, c.y) * (1. - smoothstep(.85, 1.35, c.y));
  float ci = smoothstep(.5, .7, n) * band * uCirrus;
  gl_FragColor = vec4(v, rel, ci, 1.);
}
`;

const SKY_GRADIENT = /* glsl */ `
vec3 skyGradient(float az, float el, vec3 dir){
  float sunAz = atan(uSunDir.z, uSunDir.x);
  float e = max(el, 0.);
  vec3 c = mix(uSkyHor, uSkyLow, smoothstep(0., .21, e));
  c = mix(c, uSkyMid, smoothstep(.12, .52, e));
  c = mix(c, uSkyZen, smoothstep(.34, 1.12, e));
  float dAz = wrapA(az - sunAz);
  float g = exp(-(dAz * dAz) / 1.1) * exp(-e / .27);
  c = mix(c, uSkyHorSun, g * .9);
  // the side of the sky opposite the sun cools down a little
  float anti = exp(-pow(wrapA(az - sunAz - PI), 2.) / 1.6) * exp(-e / .35);
  c = mix(c, mix(uSkyLow, uSkyMid, .5), anti * .35);
  // broad tonal breathing so open sky still reads as paint
  float n = fbm3(vec3(cos(az), sin(az), el) * 2.6 + 7.) - .5;
  c *= 1. + n * .06;
  float ang = acos(clamp(dot(dir, uSunDir), -1., 1.));
  float disc = smoothstep(.036, .026, ang);
  float glow = exp(-ang * ang / .02) * .55 + exp(-ang / .16) * .25;
  c = mix(c, uSunDisc, clamp(disc + glow, 0., 1.) * uSunDiscAmt);
  c = mix(c, uHazeFar, smoothstep(0., -.06, el));
  return c;
}
`;

// Pass 2: the colour study.
const FIELD_FRAG = /* glsl */ `
${FIELD_COMMON}
${SKY_GRADIENT}
void main(){
  vec2 c = canvasOf(vUv);
  float el = c.y, az = c.x - uSkyDrift;
  vec3 dir = vec3(cos(az) * cos(el), sin(el), sin(az) * cos(el));
  vec3 col = skyGradient(az, el, dir);
  vec4 D = texture2D(tDens, vUv);
  vec2 sc = sunCanvas();
  vec2 ts = vec2(wrapA(sc.x - c.x), sc.y - el);
  float near = exp(-length(ts) / .9);
  col = mix(col, mix(uCloudMid, uCloudLit, near), D.b * .8);
  vec2 g = reliefGrad(vUv);
  vec3 n = normalize(vec3(-g * .34, 1.));
  vec3 L = normalize(vec3(normalize(ts + 1e-4) * .95, .42));
  float lit = smoothstep(-.25, .95, dot(n, L));
  float thick = smoothstep(0., .22, D.r);
  lit = clamp(lit + near * .2, 0., 1.);
  vec3 cc = mix(uCloudSh, uCloudMid, smoothstep(.24, .56, lit));
  cc = mix(cc, uCloudLit, smoothstep(.58, .9, lit));
  cc = mix(cc, uCloudDeep, smoothstep(.4, 1., thick) * (1. - smoothstep(.1, .6, lit)) * .9);
  cc = mix(cc, uCloudLit, (1. - thick) * near * .75);          // glowing rims towards the sun
  cc = mix(cc, col, smoothstep(.15, 0., el) * .5);               // far clouds sink into the horizon haze
  float alpha = smoothstep(0., .018, D.r);
  col = mix(col, cc, alpha);
  gl_FragColor = vec4(col, alpha);
}
`;

// Pass 3: guidance for the brush — stroke direction (doubled angle), where detail is needed, cloud mask.
const AUX_FRAG = /* glsl */ `
${FIELD_COMMON}
void main(){
  vec2 c = canvasOf(vUv);
  float el = c.y;
  vec4 D = texture2D(tDens, vUv);
  float alpha = smoothstep(0., .018, D.r);
  vec2 g = reliefGrad(vUv);
  float gm = length(g);
  vec2 tang = gm > 1e-4 ? vec2(-g.y, g.x) / gm : vec2(1., 0.);
  vec2 sc = sunCanvas();
  vec2 rad = normalize(vec2(wrapA(c.x - sc.x), el - sc.y) + 1e-4);
  float sw = (fbm3(vec3(cos(c.x), sin(c.x), el) * 1.5 + 21.) - .5) * 1.5 + .12;
  float fan = .5 * smoothstep(.55, 0., uSunDir.y);
  vec2 open = normalize(mix(vec2(cos(sw), sin(sw)), rad * sign(rad.x + 1e-4), fan));
  float w = smoothstep(.6, 4., gm) * alpha;
  float a1 = atan(tang.y, tang.x), a2 = atan(open.y, open.x);
  vec2 dbl = mix(vec2(cos(2. * a2), sin(2. * a2)), vec2(cos(2. * a1), sin(2. * a1)), w);
  float edge = clamp(gm * .07, 0., 1.) * alpha + D.b * .35;
  gl_FragColor = vec4(dbl, clamp(edge, 0., 1.), alpha);
}
`;

const QUAD_VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;

export const skyUniforms = {
  uSkyField: { value: null }, uSkyAux: { value: null }, uSkyDrift: { value: 0 }, uCloudSeed: { value: 3.7 }, uSkyDebug: { value: 0 },
};

// GLSL for the composite pass: vec3 skyPaint(vec3 dir, float px)
export const SKY_GLSL = /* glsl */ `
uniform sampler2D uSkyField; uniform sampler2D uSkyAux; uniform float uSkyDrift; uniform float uSkyDebug;
uniform float uImpasto, uJitter, uStars;
const float SKY_EL0 = ${EL0.toFixed(2)}, SKY_EL1 = ${EL1.toFixed(2)};
vec2 skyUV(vec2 c){ return vec2(c.x / 6.2831853 + .5, (c.y - SKY_EL0) / (SKY_EL1 - SKY_EL0)); }
float skyAngle(vec2 c){ vec4 a = textureLod(uSkyAux, skyUV(c), 0.); return .5 * atan(a.y, a.x); }
float skyExist(vec2 c, float seedL){
  if (seedL < 1.5) return 1.;
  vec4 ax = textureLod(uSkyAux, skyUV(c), 0.);
  return seedL < 2.5 ? max(.2 + .8 * ax.z, ax.w * .9) : ax.z * .9 + .03 + ax.w * .3;
}
${strokeLayer('skyStroke', { angleExpr: 'skyAngle(c)', existExpr: 'skyExist(c, seedL)', wrapN: 'floor(6.2831853 / s + .5)' })}
${STROKE_RELIEF}
// every per-stroke random comes from the stroke's own seed, so strokes match across the azimuth seam
vec3 skyStrokeColor(vec2 c, float seed, float s){
  vec3 r = hash32(vec2(seed * 917.3, seed * 371.7 + s * 100.));
  vec2 j = (r.xy - .5) * s * .95 * uJitter;
  vec3 col = textureLod(uSkyField, skyUV(c + j), 0.).rgb;
  col *= 1. + (r.z - .5) * .1 * (.15 + uJitter);
  col += (hash32(vec2(seed * 173.1, seed * 59.3 + 1.7)) - .5) * vec3(.05, .035, .06) * uJitter;
  return col;
}
vec3 skyPaint(vec3 dir, float px){
  float az = atan(dir.z, dir.x) + uSkyDrift;
  float el = asin(clamp(dir.y, -1., 1.));
  vec2 q = vec2(az, el);
  vec3 col = textureLod(uSkyField, skyUV(q), 0.).rgb;
  if (el < -.19 || uSkyDebug > .5) return col;
  float relK = .05 + .95 * uImpasto;
  for (int L = 0; L < SKY_LAYERS; L++){
    float N = L == 0 ? 56. : (L == 1 ? 96. : (L == 2 ? 168. : 290.));
    float lenK = L == 0 ? 1.7 : (L == 1 ? 1.5 : 1.3), widK = L == 0 ? .52 : .42;
    float s = 6.2831853 / N;
    vec4 best = vec4(0., 0., 0., -1.), bestL = vec4(0.), second = vec4(0., 0., 0., -1.); vec2 bestCell = vec2(0.);
    skyStroke(q, s, px, float(L), lenK, widK, best, bestL, bestCell, second);
    if (second.w >= 0.) col = mix(col, skyStrokeColor(second.xy, second.w, s), second.z);
    if (best.w >= 0.){
      vec3 c1 = skyStrokeColor(best.xy, best.w, s);
      c1 *= 1. + (vnoise(vec2(bestL.y * 7. + best.w * 50., bestL.x * .8)) - .5) * .09 * (.1 + uJitter);
      vec2 cd; float pd;
      vec4 L0 = vec4(bestL.x, bestL.y, best.z, bestL.w);
      vec4 Lx = skyStroke_local(q + vec2(px, 0.), bestCell, s, px, float(L), lenK, widK, cd, pd);
      vec4 Ly = skyStroke_local(q + vec2(0., px), bestCell, s, px, float(L), lenK, widK, cd, pd);
      float h0 = strokeRelief(L0, best.w);
      vec2 g = vec2(strokeRelief(Lx, best.w) - h0, strokeRelief(Ly, best.w) - h0) * (s / px) * .035;
      float sh = clamp(-(g.x * -.6 + g.y * .8), -.3, .3);
      c1 *= 1. + sh * relK * .62;
      c1 += max(sh - .12, 0.) * .5 * uImpasto;
      col = mix(col, c1, best.z);
    }
  }
  if (uStars > .001){
    float ss = 6.2831853 / 186.;
    vec2 si = floor(q / ss);
    vec3 r = hash32(vec2(mod(si.x, 186.), si.y) + 3.3);
    vec2 sc = (si + .2 + r.xy * .6) * ss;
    float tw = .6 + .4 * sin(r.z * 60. + uSkyDrift * 900.);
    float d = length((q - sc) * vec2(1., 1.25));
    float star = smoothstep(.0038 * (.5 + r.z), .0012, d) * step(.88, r.x * .5 + r.y * .5 + r.z * .08);
    float cloudA = textureLod(uSkyAux, skyUV(q), 0.).w;
    col = mix(col, vec3(1., .96, .82), star * tw * uStars * smoothstep(.1, .45, el) * (1. - cloudA));
  }
  return col;
}
`;

export class Sky {
  constructor(renderer, { width = 2048, height = 512 } = {}) {
    this.renderer = renderer;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping };
    this.fieldRT = new THREE.WebGLRenderTarget(width, height, opts);
    this.auxRT = new THREE.WebGLRenderTarget(width, height, opts);
    this.densRT = new THREE.WebGLRenderTarget(width, height, opts);
    const uniforms = {
      uSunDir: U.uSunDir, uTime: U.uTime, uSkyDrift: skyUniforms.uSkyDrift,
      uSkyZen: U.uSkyZen, uSkyMid: U.uSkyMid, uSkyLow: U.uSkyLow, uSkyHor: U.uSkyHor, uSkyHorSun: U.uSkyHorSun,
      uSunDisc: U.uSunDisc, uSunDiscAmt: U.uSunDiscAmt,
      uCloudLit: U.uCloudLit, uCloudMid: U.uCloudMid, uCloudSh: U.uCloudSh, uCloudDeep: U.uCloudDeep, uHazeFar: U.uHazeFar,
      uCloudCover: U.uCloudCover, uCloudBase: U.uCloudBase, uCloudSeed: skyUniforms.uCloudSeed, uNight: U.uNight, uCirrus: U.uCirrus,
      tDens: { value: this.densRT.texture }, uDensTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
    };
    this.fieldMat = new THREE.ShaderMaterial({ uniforms, vertexShader: QUAD_VERT, fragmentShader: FIELD_FRAG, depthTest: false, depthWrite: false });
    this.auxMat = new THREE.ShaderMaterial({ uniforms, vertexShader: QUAD_VERT, fragmentShader: AUX_FRAG, depthTest: false, depthWrite: false });
    this.densMat = new THREE.ShaderMaterial({ uniforms, vertexShader: QUAD_VERT, fragmentShader: DENS_FRAG, depthTest: false, depthWrite: false });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.fieldMat);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.quad);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    skyUniforms.uSkyField.value = this.fieldRT.texture;
    skyUniforms.uSkyAux.value = this.auxRT.texture;
    this.driftSpeed = 0.0032;
  }
  update(time) {
    skyUniforms.uSkyDrift.value = time * this.driftSpeed;
    const r = this.renderer;
    this.quad.material = this.densMat; r.setRenderTarget(this.densRT); r.render(this.scene, this.cam);
    this.quad.material = this.fieldMat; r.setRenderTarget(this.fieldRT); r.render(this.scene, this.cam);
    this.quad.material = this.auxMat; r.setRenderTarget(this.auxRT); r.render(this.scene, this.cam);
    r.setRenderTarget(null);
  }
}
