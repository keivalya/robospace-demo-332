// test/camera-framing.test.mjs
//
// The Overhead and Front cameras were hardcoded to the Franka workbench, so for most
// Menagerie robots two of the three dropdown entries pointed at empty space. These
// assertions pin the replacement to the real ur5e model rather than a mock, because
// the whole failure was a set of constants that were plausible in isolation.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMujocoModule as load_mujoco } from '../examples/utils/mujocoModule.js';
import { mujocoLogHooks } from '../examples/utils/mujocoLog.js';
import { compileModel } from '../examples/mujocoUtils.js';
import { computeVisibleBounds, fitDistance, framingFor } from '../examples/utils/cameraFraming.js';

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

const mujoco = await load_mujoco(mujocoLogHooks);
mujoco.FS.mkdir('/working');
mujoco.FS.mount(mujoco.MEMFS, { root: '.' }, '/working');

const src = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', 'examples', 'scenes', 'universal_robots_ur5e');
mujoco.FS.mkdir('/working/universal_robots_ur5e');
mujoco.FS.mkdir('/working/universal_robots_ur5e/assets');
for (const f of fs.readdirSync(src)) {
  const abs = path.join(src, f);
  if (!fs.statSync(abs).isDirectory()) {
    mujoco.FS.writeFile(`/working/universal_robots_ur5e/${f}`, new Uint8Array(fs.readFileSync(abs)));
  }
}
for (const f of fs.readdirSync(path.join(src, 'assets'))) {
  mujoco.FS.writeFile(`/working/universal_robots_ur5e/assets/${f}`, new Uint8Array(fs.readFileSync(path.join(src, 'assets', f))));
}

const model = compileModel(mujoco, '/working/universal_robots_ur5e/scene.xml');
const state = new mujoco.State(model);
const sim = new mujoco.Simulation(model, state);
sim.forward();

console.log('bounds from the real ur5e');
const b = computeVisibleBounds(model, sim);
check(b !== null, 'bounds are produced for a real model');
console.log(`  center=[${b.center.map((v) => v.toFixed(3))}] half=[${b.half.map((v) => v.toFixed(3))}] radius=${b.radius.toFixed(3)}`);

// A ur5e standing on the floor is roughly a metre of reach. Anything far outside this
// means the ground plane leaked into the bounds, which is the specific mistake the
// GEOM_PLANE exclusion exists to prevent -- the renderer draws planes as a hardcoded
// 100x100 Reflector, so including one would blow the radius up by two orders.
check(b.radius > 0.2 && b.radius < 3, `radius ${b.radius.toFixed(3)} m is robot-scale, not plane-scale`);
check(Math.abs(b.center[2]) < 2, 'centre sits near the robot, not far above or below');
check(b.half.every((h) => Number.isFinite(h) && h >= 0), 'half-extents are finite and non-negative');

console.log('\nthe ground plane is excluded');
// Positive control first: the model really does contain a plane, so the assertion
// above is testing an exclusion that had something to exclude.
let planes = 0;
for (let i = 0; i < model.ngeom; i++) if (model.geom_type[i] === 0) planes++;
check(planes > 0, `positive control: the scene contains ${planes} plane geom(s)`);

console.log('\nfitDistance');
check(fitDistance(1, 60) > 1, 'a 1 m object needs more than 1 m of standoff at 60 deg');
check(fitDistance(2, 60) > fitDistance(1, 60), 'a bigger object is framed from further away');
check(fitDistance(1, 30) > fitDistance(1, 60), 'a narrower lens needs more distance');
check(Number.isFinite(fitDistance(1, 0)) && fitDistance(1, 0) > 0, 'a nonsense fov degrades to a usable default');
check(Number.isFinite(fitDistance(0, 60)) && fitDistance(0, 60) > 0, 'a zero radius still yields a positive distance');
check(Number.isFinite(fitDistance(NaN, NaN)) && fitDistance(NaN, NaN) > 0, 'NaN in, finite out');

console.log('\nplacement follows the model');
const over = framingFor('overhead', b, 60);
check(over.position[2] > b.center[2], 'overhead sits above the centre');
check(Math.abs(over.position[0] - b.center[0]) < 1e-9 && Math.abs(over.position[1] - b.center[1]) < 1e-9,
  'overhead is directly above the centre, not over a fixed table position');
check(over.target.every((v, i) => Math.abs(v - b.center[i]) < 1e-9), 'overhead looks at the centre');

const front = framingFor('front', b, 55);
check(front.position[0] > b.center[0], 'front stands off along +X');
check(front.position[2] > b.center[2], 'front is raised above the centre');
check(front.target.every((v, i) => Math.abs(v - b.center[i]) < 1e-9), 'front looks at the centre');

// The regression this whole change exists to prevent: placement must MOVE when the
// model does. With the old constants both cameras were identical for every model.
const shifted = { center: [b.center[0] + 5, b.center[1] - 3, b.center[2] + 1], half: b.half, radius: b.radius };
const overShifted = framingFor('overhead', shifted, 60);
check(Math.abs(overShifted.position[0] - over.position[0]) > 4.9,
  'a model centred elsewhere is framed elsewhere (the old constants could not do this)');

console.log('\ndegenerate input falls back rather than throwing');
check(computeVisibleBounds(null, null) === null, 'null model yields null, not a crash');
check(computeVisibleBounds({ ngeom: 0 }, {}) === null, 'a model with no geoms yields null');
check(framingFor('overhead', null, 60) === null, 'null bounds yield null placement');
check(framingFor('nonsense', b, 60) === null, 'an unknown virtual type yields null');

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
