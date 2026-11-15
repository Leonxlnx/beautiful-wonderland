import * as THREE from 'three';
import { U } from './env.js';
import { NOISE } from './glsl.js';
import { SKY_GLSL, skyUniforms } from '../world/sky.js';

// Frame pipeline. One frame =
//   shadow depth pass → (optional) mirrored reflection pass → for every tile:
//   scene (MSAA, colour + coverage/mask) → pack → structure tensor → anisotropic Kuwahara → composite with painted sky.
// Tiles keep every draw call short (integrated GPUs get reset by Windows if one call runs for seconds)
// and bound memory at 4K. With one tile and toScreen it is the real-time path.

export const LAYER_SHADOW = 1;
export const LAYER_REFLECT = 2;

const QUAD_VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;

const PACK_FRAG = /* glsl */ `
precision highp float; varying vec2 vUv; uniform sampler2D tColor; uniform sampler2D tAux;
void main(){ gl_FragColor = vec4(texture2D(tColor, vUv).rgb, texture2D(tAux, vUv).r); }`;

const TENSOR_FRAG = /* glsl */ `
precision highp float; varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uTexel;
void main(){
  vec2 d = uTexel;
  vec4 tl = textureLod(tSrc, vUv + vec2(-d.x, d.y), 1.), tc = textureLod(tSrc, vUv + vec2(0., d.y), 1.), tr = textureLod(tSrc, vUv + vec2(d.x, d.y), 1.);
  vec4 ml = textureLod(tSrc, vUv + vec2(-d.x, 0.), 1.), mr = textureLod(tSrc, vUv + vec2(d.x, 0.), 1.);
  vec4 bl = textureLod(tSrc, vUv + vec2(-d.x, -d.y), 1.), bc = textureLod(tSrc, vUv + vec2(0., -d.y), 1.), br = textureLod(tSrc, vUv + vec2(d.x, -d.y), 1.);
  vec4 sx = (tr + 2. * mr + br - tl - 2. * ml - bl) * .25;
  vec4 sy = (tl + 2. * tc + tr - bl - 2. * bc - br) * .25;
  gl_FragColor = vec4(dot(sx, sx), dot(sy, sy), dot(sx, sy), 1.);
}`;

const BLUR_FRAG = /* glsl */ `
precision highp float; varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uDir;
void main(){
  vec4 s = texture2D(tSrc, vUv) * .2270270270;
  s += (texture2D(tSrc, vUv + uDir * 1.3846153846) + texture2D(tSrc, vUv - uDir * 1.3846153846)) * .3162162162;
  s += (texture2D(tSrc, vUv + uDir * 3.2307692308) + texture2D(tSrc, vUv - uDir * 3.2307692308)) * .0702702703;
  gl_FragColor = s;
}`;

// Anisotropic Kuwahara (Kyprianidis et al.) with polynomial sector weights. Works on premultiplied RGBA
// so silhouettes against the (later composited) sky stay crisp and correctly filtered.
const KUWAHARA_FRAG = /* glsl */ `
precision highp float; varying vec2 vUv;
uniform sampler2D tSrc; uniform sampler2D tTensor; uniform sampler2D tAux;
uniform vec2 uTexel; uniform float uRadius; uniform float uStride; uniform float uHardness; uniform float uSharp;
void main(){
  float mask = texture2D(tAux, vUv).g;
  float radius = uRadius * mix(.3, 1., clamp(mask, 0., 1.));
  vec4 c0 = textureLod(tSrc, vUv, 0.);
  if (radius < 1.25){ gl_FragColor = c0; return; }
  vec3 g = texture2D(tTensor, vUv).xyz;
  float lambda1 = .5 * (g.y + g.x + sqrt(g.y * g.y - 2. * g.x * g.y + g.x * g.x + 4. * g.z * g.z));
  float lambda2 = .5 * (g.y + g.x - sqrt(g.y * g.y - 2. * g.x * g.y + g.x * g.x + 4. * g.z * g.z));
  vec2 v = vec2(lambda1 - g.x, -g.z);
  vec2 t = length(v) > 0. ? normalize(v) : vec2(0., 1.);
  float phi = -atan(t.y, t.x);
  float A = (lambda1 + lambda2 > 0.) ? (lambda1 - lambda2) / (lambda1 + lambda2) : 0.;
  float alpha = 1.;
  float a = radius * clamp((alpha + A) / alpha, .1, 2.);
  float b = radius * clamp(alpha / (alpha + A), .1, 2.);
  float cp = cos(phi), sp = sin(phi);
  mat2 R = mat2(cp, -sp, sp, cp);
  mat2 S = mat2(.5 / a, 0., 0., .5 / b);
  mat2 SR = S * R;
  float mx = floor(sqrt(a * a * cp * cp + b * b * sp * sp));
  float my = floor(sqrt(a * a * sp * sp + b * b * cp * cp));
  float zeta = 2. / radius;
  float zc = .58;
  float szc = sin(zc);
  float eta = (zeta + cos(zc)) / (szc * szc);
  vec4 m[8]; vec4 s[8];
  for (int k = 0; k < 8; k++){ m[k] = vec4(0.); s[k] = vec4(0.); }
  float mw[8];
  for (int k = 0; k < 8; k++) mw[k] = 0.;
  float lod = log2(uStride);
  for (float y = -my; y <= my; y += uStride){
    for (float x = -mx; x <= mx; x += uStride){
      vec2 p = SR * vec2(x, y);
      if (dot(p, p) <= .25){
        vec4 c = textureLod(tSrc, vUv + vec2(x, y) * uTexel, lod);
        float sum = 0.; float w[8]; float z, vxx, vyy;
        vxx = zeta - eta * p.x * p.x; vyy = zeta - eta * p.y * p.y;
        z = max(0., p.y + vxx); w[0] = z * z; sum += w[0];
        z = max(0., -p.x + vyy); w[2] = z * z; sum += w[2];
        z = max(0., -p.y + vxx); w[4] = z * z; sum += w[4];
        z = max(0., p.x + vyy); w[6] = z * z; sum += w[6];
        vec2 pr = .70710678 * vec2(p.x - p.y, p.x + p.y);
        vxx = zeta - eta * pr.x * pr.x; vyy = zeta - eta * pr.y * pr.y;
        z = max(0., pr.y + vxx); w[1] = z * z; sum += w[1];
        z = max(0., -pr.x + vyy); w[3] = z * z; sum += w[3];
        z = max(0., -pr.y + vxx); w[5] = z * z; sum += w[5];
        z = max(0., pr.x + vyy); w[7] = z * z; sum += w[7];
        float gg = exp(-3.125 * dot(pr, pr)) / sum;
        for (int k = 0; k < 8; k++){ float wk = w[k] * gg; m[k] += c * wk; s[k] += c * c * wk; mw[k] += wk; }
      }
    }
  }
  vec4 o = vec4(0.); float ow = 0.;
  for (int k = 0; k < 8; k++){
    if (mw[k] <= 0.) continue;
    vec4 mean = m[k] / mw[k];
    vec4 var = abs(s[k] / mw[k] - mean * mean);
    float sigma2 = var.r + var.g + var.b + var.a;
    float w = 1. / (1. + pow(uHardness * 1000. * sigma2, .5 * uSharp));
    o += mean * w; ow += w;
  }
  gl_FragColor = ow > 0. ? o / ow : c0;
}`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform vec2 uFullSize; uniform vec2 uTileOrigin; uniform vec2 uPad; uniform vec2 uPadSize;
uniform mat3 uCamRot; uniform float uTanHalfFov; uniform float uAspect; uniform float uPxAngle;
uniform vec3 uLift, uGain; uniform float uSat, uContrast; uniform float uFrameSeed; uniform float uFade; uniform float uCanvasAmt; uniform float uNight;
${NOISE}
${SKY_GLSL}
void main(){
  vec2 gpx = gl_FragCoord.xy + uTileOrigin;
  vec2 guv = gpx / uFullSize;
  vec2 tuv = (gl_FragCoord.xy + uPad) / uPadSize;
  vec4 sc = texture2D(tScene, tuv);
  vec3 col = sc.rgb;
  float cov = clamp(sc.a, 0., 1.);
  if (cov < .999){
    vec2 ndc = guv * 2. - 1.;
    vec3 dv = normalize(vec3(ndc.x * uTanHalfFov * uAspect, ndc.y * uTanHalfFov, -1.));
    col += skyPaint(uCamRot * dv, uPxAngle) * (1. - cov);
  }
  // grade
  col = (col - .5) * uContrast + .5;
  float lum = dot(col, vec3(.299, .587, .114));
  col = mix(vec3(lum), col, uSat);
  col = col * uGain + uLift;
  // lamplight: at dusk the brightest paint turns warm
  float hl = smoothstep(.6, .95, dot(col, vec3(.299, .587, .114)));
  col = mix(col, col * vec3(1.14, 1., .74) + vec3(.05, .02, 0.), hl * uNight * .85);
  // canvas: woven tooth + soft mottling, scaled so it looks the same at any output size
  vec2 cp = gpx * (1080. / uFullSize.y);
  float weave = (vnoise(cp * vec2(.95, .16)) + vnoise(cp * vec2(.16, .95) + 31.7) - 1.) * .5;
  float mott = vnoise(cp * .035 + 5.) - .5;
  col *= 1. + (weave * .034 + mott * .022) * uCanvasAmt;
  // vignette
  vec2 vq = guv - .5;
  col *= 1. - dot(vq, vq) * .16;
  col *= uFade;
  col += (hash12(gpx + uFrameSeed) - .5) / 255.;
  gl_FragColor = vec4(clamp(col, 0., 1.), 1.);
}`;

export class Pipeline {
  constructor(renderer, quality) {
    this.r = renderer;
    this.q = quality;
    this.fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.fsQuad.frustumCulled = false;
    this.fsScene = new THREE.Scene(); this.fsScene.add(this.fsQuad);

    const ss = quality.shadowSize;
    this.shadowRT = new THREE.WebGLRenderTarget(ss, ss, { depthBuffer: true });
    this.shadowRT.depthTexture = new THREE.DepthTexture(ss, ss, THREE.UnsignedIntType);
    this.shadowRT.depthTexture.minFilter = this.shadowRT.depthTexture.magFilter = THREE.NearestFilter;
    this.shadowCam = new THREE.OrthographicCamera(-50, 50, 50, -50, 1, 900);
    this.shadowCam.layers.set(LAYER_SHADOW);
    U.uShadowMap.value = this.shadowRT.depthTexture;

    this.reflCam = new THREE.PerspectiveCamera();
    this.reflCam.layers.set(LAYER_REFLECT);
    this.reflRT = null;
    this.reflMatrix = new THREE.Matrix4();

    const mk = (frag, uniforms) => new THREE.ShaderMaterial({ uniforms, vertexShader: QUAD_VERT, fragmentShader: frag, depthTest: false, depthWrite: false });
    this.packMat = mk(PACK_FRAG, { tColor: { value: null }, tAux: { value: null } });
    this.tensorMat = mk(TENSOR_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.blurMat = mk(BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.kuwMat = mk(KUWAHARA_FRAG, {
      tSrc: { value: null }, tTensor: { value: null }, tAux: { value: null }, uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 6 }, uStride: { value: 1 }, uHardness: { value: 8 }, uSharp: { value: 8 },
    });
    this.compMat = new THREE.ShaderMaterial({
      defines: { SKY_LAYERS: quality.skyLayers },
      uniforms: {
        tScene: { value: null }, uFullSize: { value: new THREE.Vector2() }, uTileOrigin: { value: new THREE.Vector2() },
        uPad: { value: new THREE.Vector2() }, uPadSize: { value: new THREE.Vector2() },
        uCamRot: { value: new THREE.Matrix3() }, uTanHalfFov: { value: 1 }, uAspect: { value: 1 }, uPxAngle: { value: 0.001 },
        uLift: U.uLift, uGain: U.uGain, uSat: U.uSat, uContrast: U.uContrast, uFrameSeed: { value: 0 }, uFade: { value: 1 }, uCanvasAmt: { value: 1 },
        uSkyField: skyUniforms.uSkyField, uSkyAux: skyUniforms.uSkyAux, uSkyDrift: skyUniforms.uSkyDrift, uSkyDebug: skyUniforms.uSkyDebug,
        uImpasto: U.uImpasto, uJitter: U.uJitter, uStars: U.uStars, uNight: U.uNight,
      },
      vertexShader: QUAD_VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false,
    });
    this.tsize = null;
    this.casters = [];      // { mesh, depthMat }
    this.fade = 1;
    this._v = new THREE.Vector3(); this._m = new THREE.Matrix4();
  }

  pass(mat, target) {
    this.fsQuad.material = mat;
    this.r.setRenderTarget(target);
    this.r.render(this.fsScene, this.fsCam);
  }

  ensureTargets(wp, hp, w, h) {
    const key = `${wp}x${hp}x${w}x${h}`;
    if (this.tsize === key) return;
    for (const k of ['sceneRT', 'packRT', 'tenA', 'tenB', 'kuwRT', 'outRT']) this[k]?.dispose();
    const hf = THREE.HalfFloatType;
    this.sceneRT = new THREE.WebGLRenderTarget(wp, hp, { count: 2, samples: this.q.msaa, type: hf, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.packRT = new THREE.WebGLRenderTarget(wp, hp, { type: hf, depthBuffer: false, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true });
    const tw = Math.ceil(wp / 2), th = Math.ceil(hp / 2);
    this.tenA = new THREE.WebGLRenderTarget(tw, th, { type: hf, depthBuffer: false });
    this.tenB = new THREE.WebGLRenderTarget(tw, th, { type: hf, depthBuffer: false });
    this.kuwRT = new THREE.WebGLRenderTarget(wp, hp, { type: hf, depthBuffer: false });
    this.outRT = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
    this.tileBuf = new Uint8Array(w * h * 4);
    this.tsize = key;
  }

  renderShadows(scene, focus, size) {
    if (U.uSunAmt.value <= 0.001) return;
    const cam = this.shadowCam, res = this.q.shadowSize, half = size / 2, dist = 420;
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half; cam.near = 1; cam.far = dist * 2;
    cam.updateProjectionMatrix();
    const sd = U.uSunDir.value;
    cam.up.set(0, 1, 0);
    cam.position.copy(focus).addScaledVector(sd, dist);
    cam.lookAt(focus);
    cam.updateMatrixWorld(true);
    // snap to shadow texels so the map does not crawl as the focus moves
    const texel = size / res;
    const p = this._v.copy(focus).applyMatrix4(cam.matrixWorldInverse);
    const dx = p.x - Math.round(p.x / texel) * texel, dy = p.y - Math.round(p.y / texel) * texel;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    cam.position.addScaledVector(right, dx).addScaledVector(up, dy);
    cam.updateMatrixWorld(true);
    U.uShadowMatrix.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    U.uShadowParams.value.set(1 / res, 0.14 / (cam.far - cam.near), 1, size);
    const saved = [];
    for (const c of this.casters) { saved.push(c.mesh.material); c.mesh.material = c.depthMat; }
    const a2c = U.uA2C.value; U.uA2C.value = 0;
    this.r.setRenderTarget(this.shadowRT);
    this.r.setClearColor(0xffffff, 1);
    this.r.clear();
    this.r.render(scene, cam);
    this.casters.forEach((c, i) => { c.mesh.material = saved[i]; });
    U.uA2C.value = a2c;
  }

  renderReflection(scene, camera, fullW, fullH) {
    const w = Math.round(fullW * this.q.reflScale), h = Math.round(fullH * this.q.reflScale);
    if (!this.reflRT || this.reflRT.width !== w || this.reflRT.height !== h) {
      this.reflRT?.dispose();
      this.reflRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    }
    const v = this.reflCam;
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const rot = new THREE.Matrix4().extractRotation(camera.matrixWorld);
    const fwd = new THREE.Vector3(0, 0, -1).applyMatrix4(rot), up = new THREE.Vector3(0, 1, 0).applyMatrix4(rot);
    const target = camPos.clone().add(fwd);
    v.position.set(camPos.x, -camPos.y, camPos.z);
    v.up.set(up.x, -up.y, up.z);
    v.lookAt(target.x, -target.y, target.z);
    v.fov = camera.fov; v.aspect = fullW / fullH; v.near = camera.near; v.far = camera.far;
    v.updateProjectionMatrix();
    v.updateMatrixWorld(true);
    this.reflMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.reflMatrix.multiply(v.projectionMatrix).multiply(v.matrixWorldInverse);
    // oblique near plane = water plane, so nothing below the surface leaks into the mirror image
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.02).applyMatrix4(v.matrixWorldInverse);
    const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = v.projectionMatrix, q = new THREE.Vector4();
    q.x = (Math.sign(clip.x) + pm.elements[8]) / pm.elements[0];
    q.y = (Math.sign(clip.y) + pm.elements[9]) / pm.elements[5];
    q.z = -1.0;
    q.w = (1.0 + pm.elements[10]) / pm.elements[14];
    clip.multiplyScalar(2.0 / clip.dot(q));
    pm.elements[2] = clip.x; pm.elements[6] = clip.y; pm.elements[10] = clip.z + 1.0; pm.elements[14] = clip.w;
    const a2c = U.uA2C.value; U.uA2C.value = 0;
    this.r.setRenderTarget(this.reflRT);
    this.r.setClearColor(0x000000, 0);
    this.r.clear();
    this.r.render(scene, v);
    U.uA2C.value = a2c;
  }

  // Renders one frame. Returns a top-down RGBA Uint8Array unless toScreen is set.
  async render({ scene, camera, width, height, tilesX = 1, tilesY = 1, toScreen = false, focus, shadowSize = 110, reflect = false, frameSeed = 0, onTile }) {
    const r = this.r, q = this.q;
    camera.clearViewOffset?.();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    U.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    U.uPxAngle.value = (2 * tanHalf) / height;

    this.renderShadows(scene, focus ?? U.uCamPos.value, shadowSize);
    if (reflect) this.renderReflection(scene, camera, width, height);

    const pad = tilesX * tilesY > 1 ? q.pad : 0;
    const tw = Math.ceil(width / tilesX), th = Math.ceil(height / tilesY);
    const wp = tw + 2 * pad, hp = th + 2 * pad;
    this.ensureTargets(wp, hp, tw, th);
    const out = toScreen ? null : new Uint8Array(width * height * 4);

    const cu = this.compMat.uniforms;
    cu.uFullSize.value.set(width, height);
    cu.uPad.value.set(pad, pad); cu.uPadSize.value.set(wp, hp);
    cu.uCamRot.value.setFromMatrix4(camera.matrixWorld);
    cu.uTanHalfFov.value = tanHalf; cu.uAspect.value = width / height; cu.uPxAngle.value = (2 * tanHalf) / height;
    cu.uFrameSeed.value = frameSeed; cu.uFade.value = this.fade;
    const radius = q.kuwahara * (height / 1080);
    const stride = radius > 7 ? 2 : 1;

    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const x0 = tx * tw, y0 = ty * th;
        if (tilesX * tilesY > 1) camera.setViewOffset(width, height, x0 - pad, y0 - pad, wp, hp);
        U.uA2C.value = q.msaa > 0 ? 1 : 0;
        r.setRenderTarget(this.sceneRT);
        r.setClearColor(0x000000, 0);
        r.clear();
        r.render(scene, camera);

        this.packMat.uniforms.tColor.value = this.sceneRT.textures[0];
        this.packMat.uniforms.tAux.value = this.sceneRT.textures[1];
        this.pass(this.packMat, this.packRT);
        let src = this.packRT.texture;
        if (q.kuwahara > 0) {
          this.tensorMat.uniforms.tSrc.value = this.packRT.texture;
          this.tensorMat.uniforms.uTexel.value.set(2 / wp, 2 / hp);
          this.pass(this.tensorMat, this.tenA);
          this.blurMat.uniforms.tSrc.value = this.tenA.texture;
          this.blurMat.uniforms.uDir.value.set(1 / this.tenA.width, 0);
          this.pass(this.blurMat, this.tenB);
          this.blurMat.uniforms.tSrc.value = this.tenB.texture;
          this.blurMat.uniforms.uDir.value.set(0, 1 / this.tenA.height);
          this.pass(this.blurMat, this.tenA);
          const ku = this.kuwMat.uniforms;
          ku.tSrc.value = this.packRT.texture; ku.tTensor.value = this.tenA.texture; ku.tAux.value = this.sceneRT.textures[1];
          ku.uTexel.value.set(1 / wp, 1 / hp); ku.uRadius.value = radius; ku.uStride.value = stride;
          this.pass(this.kuwMat, this.kuwRT);
          src = this.kuwRT.texture;
        }
        cu.tScene.value = src;
        cu.uTileOrigin.value.set(x0, height - y0 - th);
        if (toScreen) {
          this.pass(this.compMat, null);
        } else {
          this.pass(this.compMat, this.outRT);
          r.readRenderTargetPixels(this.outRT, 0, 0, tw, th, this.tileBuf);
          const cw = Math.min(tw, width - x0), chh = Math.min(th, height - y0);
          for (let row = 0; row < chh; row++) {
            const srcRow = th - 1 - row;      // GL rows are bottom-up
            out.set(this.tileBuf.subarray(srcRow * tw * 4, srcRow * tw * 4 + cw * 4), ((y0 + row) * width + x0) * 4);
          }
          if (onTile) await onTile(tx, ty);
        }
      }
    }
    camera.clearViewOffset();
    r.setRenderTarget(null);
    return out;
  }
}
