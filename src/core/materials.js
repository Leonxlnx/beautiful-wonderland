import * as THREE from 'three';
import { U } from './env.js';
import { NOISE, ENV_PARS, ATMOS, SHADOW, TOON, PAINT_OUT } from './glsl.js';
import { LAYER_SHADOW, LAYER_REFLECT } from './pipeline.js';

// Builds a scene material + its matching shadow-depth material from GLSL snippets.
//   vertexPars / fragmentPars : declarations
//   vertexMain  : may change 'pos' and 'nrm' (object space) before the model transform
//   vertexWorld : may change 'wp' (world space position, vec4) — wind sway etc.
//   fragmentMain: must end with paintOut(...) / paintOutBlend(...) / paintOutAdd(...)
//   depthMain   : optional fragment code for the depth pass (discard for cut-outs)
export function paintMaterial({
  vertexPars = '', vertexMain = '', vertexWorld = '', fragmentPars = '', fragmentMain, depthMain = '',
  uniforms = {}, defines = {}, side = THREE.FrontSide, a2c = false, blend = null, depthWrite = true, depthTest = true, name = 'paint',
}) {
  const vertexShader = /* glsl */ `
${NOISE}${ENV_PARS}
varying vec3 vW; varying vec3 vN;
${vertexPars}
void main(){
  vec3 pos = position; vec3 nrm = normal;
  mat4 M = modelMatrix;
  #ifdef USE_INSTANCING
    M = modelMatrix * instanceMatrix;
  #endif
  ${vertexMain}
  vec4 wp = M * vec4(pos, 1.);
  vec3 wn = normalize(mat3(M) * nrm);
  ${vertexWorld}
  vW = wp.xyz; vN = wn;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
  const fragHead = /* glsl */ `
precision highp float;
${NOISE}${ENV_PARS}${ATMOS}${SHADOW}${TOON}${PAINT_OUT}
varying vec3 vW; varying vec3 vN;
${fragmentPars}`;
  const allU = { ...U, ...uniforms };
  const mat = new THREE.ShaderMaterial({
    name, uniforms: allU, defines, vertexShader, side, depthWrite, depthTest,
    fragmentShader: `${fragHead}\nvoid main(){\n${fragmentMain}\n}`,
  });
  if (a2c) mat.alphaToCoverage = true;
  if (blend === 'over') {
    mat.transparent = true; mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    mat.blendSrcAlpha = THREE.OneFactor; mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  } else if (blend === 'add') {
    mat.transparent = true; mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneFactor;
    mat.blendSrcAlpha = THREE.ZeroFactor; mat.blendDstAlpha = THREE.OneFactor;
    mat.depthWrite = false;
  }
  const depthMat = new THREE.ShaderMaterial({
    name: name + '-depth', uniforms: allU, defines, vertexShader, side: THREE.DoubleSide,
    fragmentShader: `${fragHead}\nvoid main(){\n${depthMain}\ngl_FragColor = vec4(1.);\n}`,
  });
  mat.userData.depthMat = depthMat;
  return mat;
}

// Register a mesh with the pipeline: shadow caster and/or visible in the water mirror.
export function register(pipeline, mesh, { cast = true, reflect = true } = {}) {
  if (cast && mesh.material?.userData?.depthMat) {
    mesh.layers.enable(LAYER_SHADOW);
    pipeline.casters.push({ mesh, depthMat: mesh.material.userData.depthMat });
  }
  if (reflect) mesh.layers.enable(LAYER_REFLECT);
  return mesh;
}

// General painted surface for built things (metal, wood, concrete, cloth).
// Base paint comes from the 'color' vertex attribute. Nature creeps in from above: moss on upward faces,
// rust and grime break up the flat colour.
export function propMaterial({ moss = 0.5, rust = 0.4, mask = 1, wobble = 0.12, emissive = false, side = THREE.FrontSide, flat = false, sway = 0 } = {}) {
  return paintMaterial({
    name: 'prop', side,
    uniforms: { uMoss: { value: moss }, uRust: { value: rust }, uMaskVal: { value: mask }, uWobble: { value: wobble }, uGlow: { value: 0 }, uSway: { value: sway } },
    defines: { ...(emissive ? { EMISSIVE: 1 } : {}), ...(flat ? { FLATN: 1 } : {}) },
    vertexPars: `attribute vec3 color; varying vec3 vCol; varying vec3 vO; uniform float uSway;`,
    vertexMain: `vCol = color; vO = position;`,
    vertexWorld: `
      if (uSway > 0.){
        float ph = wp.x * .11 + wp.z * .13;
        wp.xz += uWind.xy * uSway * (sin(uTime * 1.3 + ph) * .6 + sin(uTime * 2.9 + ph * 1.7) * .25) * (.4 + gustAt(wp.xz));
      }`,
    fragmentPars: `varying vec3 vCol; varying vec3 vO; uniform float uMoss, uRust, uMaskVal, uWobble, uGlow;`,
    fragmentMain: `
      #ifdef FLATN
        vec3 N = normalize(cross(dFdx(vW), dFdy(vW)));
      #else
        vec3 N = normalize(vN);
        if (!gl_FrontFacing) N = -N;
      #endif
      vec3 base = vCol;
      float n1 = vnoise3(vW * 1.7), n2 = vnoise3(vW * 6.3), n3 = fbm3lo(vW * .55);
      // grime and rust: blotches that follow the surface, stronger low down and in crevices
      float rust = smoothstep(.52, .78, n3 * .7 + n1 * .3) * uRust;
      base = mix(base, base * vec3(.78, .56, .42) + vec3(.1, .03, 0.), rust);
      base *= .93 + .14 * n2;
      // moss creeping over upward faces
      float up = smoothstep(.25, .85, N.y);
      float mossy = smoothstep(.5, .72, up * (.45 + .55 * n3) + (n1 - .5) * .35) * uMoss;
      base = mix(base, mix(uGrassB, uGrassA, n2) * .92, mossy);
      float ndl = dot(N, uSunDir);
      float wob = (n1 - .5) * uWobble + (n2 - .5) * uWobble * .5;
      float lit = paintBand(ndl + wob, .1, .035);
      float hi = paintBand(ndl + wob, .78, .05) * .5;
      float sh = getShadow(vW + N * .09, vec2(n1 - .5, n2 - .5) * .12);
      vec3 col = paintLight(base, lit * sh, hi * sh);
      // bounce from the ground on downward faces
      col += uGrassB * uSunTint * .07 * smoothstep(0., -.8, N.y) * uSunAmt;
      #ifdef EMISSIVE
        col = mix(col, vCol * 1.6 + .25, uGlow);
      #endif
      paintOut(applyHaze(col, vW), 1., uMaskVal);
    `,
  });
}
