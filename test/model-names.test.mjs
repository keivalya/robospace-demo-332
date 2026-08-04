// Name decoding against the real ur5e model.
//
//   npm run test:names
//
// This exists because three call sites were decoding names wrongly for a long time and
// nothing noticed. `model.names` is one packed buffer of NUL-terminated strings and
// each `name_*adr` entry is a **byte offset** into it; the broken code did
// `decode(names).split('\0')[addr]`, treating that offset as an index into the split
// array. It is almost always out of range, so the fallback fired every time and
// `get_sensor_names()` returned ["sensor_0", "sensor_1", ...] instead of the real
// names — which quietly made the sensor path unusable.
//
// A unit test with a hand-built buffer would not have caught it (the bug is in the
// relationship between the buffer and the address table), so this compiles the real
// bundled robot and asserts against names that are visible in its XML.

import fs from 'node:fs';
import path from 'node:path';
import load_mujoco from '../dist/mujoco_wasm.js';
import { mujocoLogHooks } from '../examples/utils/mujocoLog.js';
import { compileModel, readNames, readModelNames } from '../examples/mujocoUtils.js';

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));
const eq = (got, want, m) => check(
  JSON.stringify(got) === JSON.stringify(want),
  JSON.stringify(got) === JSON.stringify(want) ? m : `${m} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
);

const mujoco = await load_mujoco(mujocoLogHooks);
mujoco.FS.mkdir('/working');
mujoco.FS.mount(mujoco.MEMFS, { root: '.' }, '/working');

// Copy the bundled ur5e in, the way the browser's boot does.
const src = path.join(import.meta.dirname, '..', 'examples', 'scenes', 'universal_robots_ur5e');
mujoco.FS.mkdir('/working/universal_robots_ur5e');
mujoco.FS.mkdir('/working/universal_robots_ur5e/assets');
for (const f of fs.readdirSync(src)) {
  const abs = path.join(src, f);
  if (!fs.statSync(abs).isDirectory()) {
    mujoco.FS.writeFile(`/working/universal_robots_ur5e/${f}`, new Uint8Array(fs.readFileSync(abs)));
  }
}
for (const f of fs.readdirSync(path.join(src, 'assets'))) {
  mujoco.FS.writeFile(`/working/universal_robots_ur5e/assets/${f}`,
    new Uint8Array(fs.readFileSync(path.join(src, 'assets', f))));
}

const model = compileModel(mujoco, '/working/universal_robots_ur5e/scene.xml');
console.log(`ur5e: nq=${model.nq} nu=${model.nu} njnt=${model.njnt} nbody=${model.nbody} ngeom=${model.ngeom}`);

console.log('\nreadNames decodes real names');
{
  const joints = readNames(model, model.name_jntadr, model.njnt, 'joint');
  eq(joints, ['shoulder_pan_joint', 'shoulder_lift_joint', 'elbow_joint',
    'wrist_1_joint', 'wrist_2_joint', 'wrist_3_joint'], 'joint names');

  const actuators = readNames(model, model.name_actuatoradr, model.nu, 'actuator');
  eq(actuators, ['shoulder_pan', 'shoulder_lift', 'elbow', 'wrist_1', 'wrist_2', 'wrist_3'],
    'actuator names');

  const bodies = readNames(model, model.name_bodyadr, model.nbody, 'body');
  eq(bodies[0], 'world', 'body 0 is world');
  check(bodies.includes('wrist_3_link'), 'body names include wrist_3_link');

  // The regression itself: not a single name may be a fallback. That is exactly what
  // the broken decoder produced for every object.
  const allFellBack = (names, prefix) => names.every((n, i) => n === `${prefix}_${i}`);
  check(!allFellBack(joints, 'joint'), 'joint names are not all fallbacks');
  check(!allFellBack(actuators, 'actuator'), 'actuator names are not all fallbacks');
  check(!allFellBack(bodies, 'body'), 'body names are not all fallbacks');
}

console.log('\nunnamed objects fall back rather than reading garbage');
{
  // ur5e's visual geoms are unnamed. mj_id2name returns NULL for these and the WASM
  // binding does std::string(NULL), which reads from wasm address 0 and yields the
  // literal string "emsc" — so id->name must never go through id2name. readNames
  // reads a real empty string and substitutes an honest placeholder.
  const geoms = readNames(model, model.name_geomadr, model.ngeom, 'geom');
  eq(geoms.length, model.ngeom, 'one entry per geom');
  check(geoms.includes('floor'), 'the named floor geom is decoded');
  check(!geoms.some((n) => n === 'emsc'), 'no name decodes to the "emsc" garbage string');
  const fallbacks = geoms.filter((n) => /^geom_\d+$/.test(n));
  check(fallbacks.length > 0, `${fallbacks.length} unnamed geoms got placeholders`);
}

console.log('\nreadModelNames keeps its shape');
{
  // Asserted in three other suites and sent over postMessage, so the refactor must not
  // change it.
  const r = readModelNames(model);
  eq(Object.keys(r).sort(), ['actuatorNames', 'jointNames'], 'same two keys');
  eq(r.actuatorNames.length, model.nu, 'one actuator name per nu');
  eq(r.jointNames.length, model.njnt, 'one joint name per njnt');
  eq(r.actuatorNames[0], 'shoulder_pan', 'first actuator unchanged');
}

console.log('\nreadNames is defensive about its inputs');
{
  eq(readNames(null, null, 0, 'x'), [], 'null model returns empty');
  eq(readNames(model, model.name_jntadr, 0, 'x'), [], 'zero count returns empty');
  // An out-of-range address must not read past the buffer or throw.
  const bogus = new Int32Array([1 << 30, -5]);
  eq(readNames(model, bogus, 2, 'thing'), ['thing_0', 'thing_1'],
    'out-of-range and negative addresses fall back');
}

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
