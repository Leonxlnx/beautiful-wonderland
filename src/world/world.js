import { createTerrain } from './terrain.js';

// Every file in ./parts is a world part: `export default async function create(world)` returning
// { group?, update?(t, camera, state), ...api }. `?parts=a,b` loads only the named ones (look-dev).
const PART_MODULES = import.meta.glob('./parts/*.js');

export async function buildWorld({ scene, pipeline, quality, renderer, only = null }) {
  const parts = [];
  const terrain = createTerrain(pipeline);
  scene.add(terrain.group);

  const world = {
    scene, pipeline, quality, renderer, terrain, parts, byName: {},
    add(part) { parts.push(part); if (part.group) scene.add(part.group); return part; },
    update(t, camera, state) { for (const p of parts) p.update?.(t, camera, state); },
  };
  const names = Object.keys(PART_MODULES).map((p) => [p.match(/\/([^/]+)\.js$/)[1], PART_MODULES[p]]).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [name, load] of names) {
    if (only && !only.includes(name)) continue;
    try {
      const mod = await load();
      const part = await mod.default(world);
      part.name ??= name;
      world.byName[name] = world.add(part);
    } catch (e) {
      console.error(`part "${name}" failed: ${e?.stack || e}`);
    }
  }
  return world;
}
