// Shared GLSL chunks. Everything is written in "paint space": colours are display-referred sRGB
// values that are mixed directly, the way a painter mixes pigments by eye.

export const NOISE = /* glsl */ `
float hash11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash32(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
vec4 hash42(vec2 p){ vec4 p4 = fract(vec4(p.xyxy) * vec4(.1031, .1030, .0973, .1099)); p4 += dot(p4, p4.wzxy + 33.33); return fract((p4.xxyz + p4.yzzw) * p4.zywx); }
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }

float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6. - 15.) + 10.);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float vnoise3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3. - 2. * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
float fbm(vec2 p){
  float a = .5, s = 0.;
  for (int i = 0; i < 5; i++){ s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= .5; }
  return s;
}
float fbm3(vec3 p){
  float a = .5, s = 0.;
  for (int i = 0; i < 5; i++){ s += a * vnoise3(p); p = p * 2.02 + vec3(11.3, 7.7, 5.1); a *= .5; }
  return s;
}
float fbm3lo(vec3 p){
  float a = .5, s = 0.;
  for (int i = 0; i < 3; i++){ s += a * vnoise3(p); p = p * 2.02 + vec3(11.3, 7.7, 5.1); a *= .5; }
  return s;
}
`;

// Global environment uniforms shared by every material (declared once, bound by reference).
export const ENV_PARS = /* glsl */ `
uniform vec3 uSunDir;        // towards the sun
uniform vec3 uSunTint;       // multiplier for sunlit paint
uniform vec3 uShadowTint;    // multiplier for shadowed paint (cool, hue shifted)
uniform vec3 uAmbientAdd;    // sky light added into shadows
uniform float uSunAmt;       // 1 = sun up, 0 = no direct light (dusk)
uniform vec3 uHazeNear;
uniform vec3 uHazeFar;
uniform vec3 uHazeSun;       // haze colour when looking into the sun
uniform float uFogDensity;
uniform float uFogMax;
uniform float uTime;
uniform vec3 uWind;          // xy = direction on xz plane, z = strength
uniform vec3 uCamPos;        // main camera (stable across shadow / reflection passes)
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform vec4 uShadowParams;  // x = texel, y = bias, z = strength, w = world size
uniform float uNight;        // 0 day … 1 dusk (lamps on)
uniform float uGust;         // global gust energy
uniform float uPxAngle;      // radians per output pixel
uniform float uA2C;          // 1 while rendering into the multisampled scene target
uniform vec3 uGrassA, uGrassB, uGrassC, uGrassTip;
uniform vec3 uLeafHi, uLeafLight, uLeafMid, uLeafDark;
uniform vec3 uWaterDeep, uWaterTint, uGlint;

// Travelling wind fronts across the land, 0..1. Grass bends and brightens where a gust passes.
float gustAt(vec2 xz){
  vec2 w = uWind.xy;
  float along = dot(xz, w), across = dot(xz, vec2(-w.y, w.x));
  float g = vnoise(vec2(along * .042 - uTime * .5, across * .019 + 3.7));
  g = smoothstep(.42, .82, g);
  float fine = vnoise(vec2(along * .21 - uTime * 1.4, across * .11));
  return clamp(g * (.75 + .5 * fine), 0., 1.) * uWind.z;
}
`;

// Every scene material writes colour to target 0 and (coverage, paint-mask) to target 1.
export const PAINT_OUT = /* glsl */ `
layout(location = 1) out highp vec4 oAux;
void paintOut(vec3 col, float a, float mask){ gl_FragColor = vec4(col, a); oAux = vec4(1., mask, 0., 1.); }
void paintOutBlend(vec3 col, float a, float mask){ gl_FragColor = vec4(col * a, a); oAux = vec4(a, mask * a, 0., a); }
void paintOutAdd(vec3 col){ gl_FragColor = vec4(col, 0.); oAux = vec4(0.); }
// crisp cut-out alpha: anti-aliased by alpha-to-coverage in the MSAA pass, hard test elsewhere
float cutAlpha(float a){
  float s = clamp((a - .5) / max(fwidth(a), 1e-4) + .5, 0., 1.);
  if (s < mix(.5, .02, uA2C)) discard;
  return s;
}
`;

export const ATMOS = /* glsl */ `
vec3 applyHaze(vec3 col, vec3 wpos){
  vec3 dv = wpos - uCamPos;
  float d = length(dv);
  float f = 1. - exp(-pow(d * uFogDensity, 1.25));
  f *= mix(1., .55, smoothstep(0., 60., wpos.y));
  f = min(f, uFogMax);
  vec3 vd = dv / max(d, 1e-3);
  float s = pow(max(dot(normalize(vec3(vd.x, 0., vd.z)), normalize(vec3(uSunDir.x, 0., uSunDir.z))), 0.), 3.);
  vec3 hc = mix(uHazeNear, uHazeFar, smoothstep(40., 420., d));
  hc = mix(hc, uHazeSun, s * .75);
  return mix(col, hc, f);
}
`;

export const SHADOW = /* glsl */ `
float shadowTap(vec2 uv, float ref){
  float d = texture2D(uShadowMap, uv).r;
  return step(ref, d);
}
// Returns 1 = lit, 0 = in shadow. 'wob' pushes the lookup around so edges look hand painted.
float getShadow(vec3 wpos, vec2 wob){
  if (uSunAmt <= 0.001) return 1.;
  vec4 sc = uShadowMatrix * vec4(wpos + vec3(wob.x, 0., wob.y), 1.);
  vec3 p = sc.xyz * .5 + .5;
  if (p.x <= 0.002 || p.x >= .998 || p.y <= 0.002 || p.y >= .998 || p.z >= 1.) return 1.;
  float ref = p.z - uShadowParams.y;
  float t = uShadowParams.x;
  vec2 f = fract(p.xy / t - .5);
  vec2 b = (floor(p.xy / t - .5) + .5) * t;
  float s00 = shadowTap(b, ref), s10 = shadowTap(b + vec2(t, 0.), ref);
  float s01 = shadowTap(b + vec2(0., t), ref), s11 = shadowTap(b + vec2(t, t), ref);
  float s = mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
  s = smoothstep(.35, .65, s);
  vec2 e = min(p.xy, 1. - p.xy);
  float fade = smoothstep(0., .06, min(e.x, e.y));
  return mix(1., s, fade * uShadowParams.z);
}
`;

// Painterly two-band light: a crisp terminator with a noisy, hand-cut edge.
export const TOON = /* glsl */ `
float paintBand(float x, float edge, float soft){ return smoothstep(edge - soft, edge + soft, x); }
vec3 paintLight(vec3 base, float lit, float hi){
  vec3 sh = base * uShadowTint + uAmbientAdd * (.35 + .65 * dot(base, vec3(.3333)));
  vec3 li = base * uSunTint;
  vec3 c = mix(sh, li, lit * uSunAmt);
  c = mix(c, min(li * 1.12 + vec3(.05, .045, .0), vec3(1.)), hi * uSunAmt);
  return c;
}
`;

// Brush-stroke layer generator. Lays one layer of opaque, oriented dabs on a 2D canvas and reports the
// two top-most strokes covering a point (so their edges can be anti-aliased).
//   angleExpr: GLSL expression for stroke direction at centre 'c' (may use r = per-cell randoms)
//   existExpr: GLSL expression (0..1 probability) that the cell at 'c' carries a stroke
//   wrapN:     GLSL expression for the number of cells in x after which the canvas repeats (0 = no wrap)
export function strokeLayer(name, { angleExpr = '0.', existExpr = '1.', wrapN = '0.' } = {}) {
  return /* glsl */ `
vec4 ${name}_local(vec2 q, vec2 cell, float s, float px, float seedL, float lenK, float widK, out vec2 cOut, out float priOut){
  float wn = ${wrapN};
  vec2 cw = wn > 0. ? vec2(mod(cell.x, wn), cell.y) : cell;
  vec3 r = hash32(cw + seedL * 17.31);
  vec2 c = (cell + .5 + (r.xy - .5) * .86) * s;
  cOut = c; priOut = -1.;
  float ex = ${existExpr};
  if (r.z > ex) return vec4(0.);
  float exFade = ex >= 1. ? 1. : smoothstep(ex, ex - .12, r.z);     // strokes dissolve in, they never pop
  vec4 r2 = hash42(cw + 5.7 + seedL * 3.1);
  float th = ${angleExpr} + (r2.z - .5) * .42;
  vec2 d = q - c; float cs = cos(th), sn = sin(th);
  vec2 l = vec2(cs * d.x + sn * d.y, -sn * d.x + cs * d.y);
  float a = s * lenK * (.72 + .62 * r2.x), b = s * widK * (.74 + .5 * r2.y);
  l.y -= (r.z - .5) * .5 * l.x * l.x / a;
  float br = vnoise(vec2(l.y / b * 5. + r2.w * 61., r2.x * 9.));
  float ae = a * (1. - .3 * br);
  float rr = b * .55;
  vec2 dd = abs(l) - vec2(ae, b) + rr;
  float sd = length(max(dd, 0.)) + min(max(dd.x, dd.y), 0.) - rr;
  float al = clamp(.5 - sd / px, 0., 1.) * exFade;
  priOut = r2.w;
  return vec4(l.x / a, l.y / b, al, sd / b);
}
void ${name}(vec2 q, float s, float px, float seedL, float lenK, float widK,
    inout vec4 best, inout vec4 bestL, inout vec2 bestCell, inout vec4 second){
  // best = (centre.xy, alpha, priority), bestL = (u, v, seed, sd/b), second = (centre.xy, alpha, priority)
  vec2 ci = floor(q / s);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
    vec2 cell = ci + vec2(float(i), float(j));
    vec2 c; float pri;
    vec4 L = ${name}_local(q, cell, s, px, seedL, lenK, widK, c, pri);
    if (L.z <= 0.) continue;
    if (pri > best.w){ second = best; best = vec4(c, L.z, pri); bestL = vec4(L.x, L.y, pri, L.w); bestCell = cell; }
    else if (pri > second.w){ second = vec4(c, L.z, pri); }
  }
}
`;
}

// Thickness of paint inside a stroke: bristle streaks, a ridge pushed to the sides, a blob at the tail.
export const STROKE_RELIEF = /* glsl */ `
float strokeRelief(vec4 L, float seed){
  // L = (u, v, alpha, sd/b)
  float bristle = vnoise(vec2(L.y * 9. + seed * 71., L.x * 1.7 + seed * 13.));
  float fine = vnoise(vec2(L.y * 23. + seed * 37., L.x * 3.1));
  float ridge = smoothstep(.45, 1., abs(L.y));
  float tail = smoothstep(.2, 1., L.x) * .6;
  float bevel = smoothstep(0., -.45, L.w);
  return bevel * (.35 + .5 * bristle + .22 * fine + .3 * ridge + tail * .35);
}
`;
