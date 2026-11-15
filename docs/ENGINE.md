# beautiful wonderland — engine notes for part authors

A painted three.js world rendered offline to a 40 s 4K film (and playable live). Everything is custom
`ShaderMaterial`s in **paint space** (colours are final on-screen sRGB values, mixed directly; no three.js
colour management, no tone mapping, no PBR). The machine has only an integrated GPU (Radeon 780M): be frugal.

## Look (the brief)
Hand-painted anime-background feeling, "nature quietly took the world back": big confident **flat shapes with
crisp cut edges**, 3–4 values per material, **sunlit yellow-lime vs. cool teal/blue-violet shadows** (shadows
are hue-shifted, never grey/black), saturated azure sky, tiny accents (white, vermilion red, orange, pink,
purple flowers). Detail is suggested by a few chunky strokes, never by noise or realism. No gradients that
look airbrushed, no thin wiry geometry, no photoreal textures. Reference paintings (kept locally in `refs/`, not part of the repository; style only —
never copy their contents); look at 2–3 of them once (`refs/1.jpg`, `refs/9.jpg`, `refs/12.jpg`).
A Kuwahara "paint" filter runs over the frame afterwards and merges fine detail into dabs, so build shapes a
little chunkier and more contrasty than feels right. The film goes noon → golden hour → sunset → dusk, so
everything must look good under all four palettes (`tod` 0, 1, 2, 3).

## World
Units metres, Y up. West (sunset) is −X, south is +Z. `src/world/layout.js` exports `heightAt(x,z)`,
`normalAt(x,z)`, `shoreDist(x,z)` (<0 inside the pond; water surface is y = 0), `pathDist`, `forestAmount`,
and places: `POND` (origin, r≈50), `WHEEL {x:-20,z:8,radius:19,sink:2.6}`, `HILL {x:-112,z:-74}` (lone-tree
hill, the finale), `FOREST {x:62,z:-132,r:80}`, `PATH` (old promenade polyline), `JETTY {x0:53,x1:6,z:8,y:0.55}`.
Terrain is 760 m square. Wind blows along `uWind.xy` (xz direction (0.92, 0.39)).

## Parts
A part is one file in `src/world/parts/<name>.js`:
```js
export default async function create(world) {      // world = { scene, pipeline, quality, terrain, parts, byName }
  const group = new THREE.Group();
  // ... build meshes, register(world.pipeline, mesh, { cast: true, reflect: true }) ...
  return { group, update(t, camera, state) { /* pure function of film time t (seconds) */ }, /* + your API */ };
}
```
Parts are auto-loaded. Only touch your own files. Everything must be a **pure function of `t`** (frames are
rendered out of order): no `Math.random`, `Date`, `performance.now`, no accumulated state. Use
`makeRng(seed)` from `src/core/rng.js` (`rng()`, `rng.range(a,b)`, `rng.pick(arr)`), plus `valueNoise2`, `fbm2`.
`world.quality.density` is 1 for the film, 0.3 live — scale instance counts with it.

## Materials (`src/core/materials.js`)
`paintMaterial({ vertexPars, vertexMain, vertexWorld, fragmentPars, fragmentMain, depthMain, uniforms, defines,
side, a2c, blend })` builds a material **and** its shadow-depth twin from GLSL snippets:
- vertex: `pos`, `nrm` (object space, editable in `vertexMain`), then `wp` (world vec4) and `wn` (world normal)
  editable in `vertexWorld` (wind sway goes here). Instancing (`instanceMatrix`) is handled. Varyings `vW`
  (world pos) and `vN` (world normal) are provided.
- fragment must end with one of:
  `paintOut(col, 1., 1.)` opaque · `paintOut(col, cutAlpha(a), 1.)` cut-out (set `a2c: true`) ·
  `paintOutBlend(col, a, 1.)` translucent (set `blend: 'over'`) · `paintOutAdd(col)` glow (`blend: 'add'`).
  The last float is the paint-filter mask (1 = paint normally, 0 = keep crisp; use ~0.3 for tiny things).
- `depthMain`: fragment code for the shadow pass, e.g. `if (a < .5) discard;` for cut-outs (must compute `a`).
GLSL available in every material: noise `hash11/12/13/22/32/42`, `vnoise(vec2)`, `vnoise3(vec3)`, `fbm(vec2)`,
`fbm3(vec3)`; `gustAt(vec2 xz)` 0..1 travelling wind gusts; `getShadow(vec3 wpos, vec2 wobble)` 1 = lit;
`paintBand(x, edge, soft)` crisp step; `paintLight(vec3 base, float lit, float hi)` → sunlit/shadow paint for
the current time of day (always light your colours through this so they follow the palette);
`applyHaze(col, wpos)` aerial perspective (always apply last). Uniforms (all time-of-day aware): `uSunDir`,
`uSunTint`, `uShadowTint`, `uAmbientAdd`, `uSunAmt` (0 at dusk), `uTime`, `uWind` (xy dir, z strength),
`uCamPos`, `uNight` (0..1 lamps on), `uPxAngle` (radians per pixel), palette colours `uGrassA/B/C/Tip`,
`uLeafHi/Light/Mid/Dark`, `uWaterDeep/Tint`, `uGlint`, haze `uHazeNear/Far`.
`propMaterial({ moss, rust, mask, wobble, emissive, side, flat, sway })` is the ready-made material for built
things: base paint from a `color` vertex attribute (vec3, 0..1), moss on upward faces, rust blotches, toon
light + shadows. `emissive: true` adds uniform `uGlow` (0..1) that turns the vertex colour into light.
`hex(0xrrggbb)` in `src/core/env.js` → `THREE.Vector3` paint colour.
`register(pipeline, mesh, { cast, reflect })`: shadow caster / visible in the pond's mirror image.
Terrain helpers for shaders: `GROUND_GLSL` + `terrainUniforms` in `src/world/terrain.js` (`terrainInfo(xz)`:
r height, g path, b shore distance, a forest; `groundStudy(xz)`: the ground paint colour at a spot).
Look at `src/world/terrain.js` for a complete example of a part-style material.

## Testing your part
```
node tools/shot.mjs --name mypart --parts mypart --size 1280x720 --views out/mypart_views.json --sheet
```
`--parts a,b` loads only those parts (plus terrain + sky). Views file: `[{ "label": "...", "pos": [x,y,z],
"look": [x,y,z], "fov": 42, "tod": 0, "ground": true, "t": 3.5 }]` — `ground:true` makes pos.y a height above
the terrain; `tod` 0 noon, 1 golden, 2 sunset, 3 dusk; `t` is film time in seconds (animation phase). Output:
`out/shots/<name>_NN.png` and `<name>_sheet.jpg` (use the sheet; Read it to look). The tool prints page
errors (shader compile errors show up there) and per-frame ms / triangle counts. Only one GPU job runs at a
time (the tool queues automatically) and the first frame after a shader change takes 5–30 s to compile.
**Be thrifty**: each look costs time and tokens — batch 3–6 views into one sheet, read sheets not single
frames, and stop when it looks right. Budget: aim to be done within ~35 tool calls.
