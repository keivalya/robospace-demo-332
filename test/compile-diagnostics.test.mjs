// Regression test for compileModel() / readModelNames() in examples/mujocoUtils.js.
//
// Run: npm test           (from the repo root)
//
// Why this exists: detecting a failed MJCF compile through the shipped WASM is
// genuinely tricky — Model.ptr() is unbound and throws, reading fields off a
// failed model returns garbage from low memory rather than trapping, and
// load_from_xml only *sometimes* throws. The one reliable signal is that
// finish() writes to stdout, and only on failure. Two real bugs were caught
// here during development:
//
//   1. Using model.ptr() as the null check (it raises
//      "Cannot call Model.ptr due to unbound types: P8mjModel_").
//   2. Testing the *text* of the captured output instead of counting lines —
//      a failed compile frequently prints one EMPTY line, so truthiness-testing
//      the joined string silently accepted 7 of 14 broken models.
//
// Both were invisible without an executable check, hence this file.
//
// Note the `generic-msg` results below are expected, not failures: the shipped
// binary links with EXCEPTION_CATCHING_ALLOWED=['load_from_xml'], which strips
// the catch inside mj_loadXML that would produce readable text for MJCF
// *semantic* errors. Detection is still exact; only the message is missing.
// Rebuilding is blocked on porting src/main.genned.cc to MuJoCo 3.3.2.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import load_mujoco from '../dist/mujoco_wasm.js';
import { mujocoLogHooks } from '../examples/utils/mujocoLog.js';
import { compileModel, readModelNames } from '../examples/mujocoUtils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UR5E = path.join(HERE, '..', 'examples', 'scenes', 'universal_robots_ur5e');

const mujoco = await load_mujoco({
  // Swallow the passthrough so expected diagnostics don't clutter test output,
  // while still feeding the capture buffer the hooks exist for.
  print: (t) => mujocoLogHooks.print.call(null, t),
  printErr: (t) => mujocoLogHooks.printErr.call(null, t),
});
mujoco.FS.mkdir('/working');
mujoco.FS.mount(mujoco.MEMFS, { root: '.' }, '/working');

const wrap = (inner, head = '') => `<mujoco model="t">${head}<worldbody>${inner}</worldbody></mujoco>`;

const INVALID = [
  ['geom size arity (box needs 3)', wrap('<body><geom type="box" size="1"/></body>')],
  ['geom size arity (sphere needs 1)', wrap('<body><geom type="sphere"/></body>')],
  ['unclosed tag', '<mujoco model="t"><worldbody><body><geom type="sphere" size=".1"/></worldbody></mujoco>'],
  ['malformed xml', '<mujoco model="t"><<>></mujoco>'],
  ['unknown element', wrap('<notathing/>')],
  ['unknown attribute', wrap('<geom type="sphere" size=".1" bogus="7"/>')],
  ['reference to undefined mesh', wrap('<geom type="mesh" mesh="nope"/>')],
  ['mesh file not in the filesystem', wrap('<geom type="mesh" mesh="m"/>', '<asset><mesh name="m" file="absent.stl"/></asset>')],
  ['joint declared in worldbody', wrap('<joint name="j" type="hinge"/>')],
  ['duplicate body name', wrap('<body name="d"><geom type="sphere" size=".1"/></body><body name="d"><geom type="sphere" size=".1"/></body>')],
  ['actuator targets a nonexistent joint', '<mujoco model="t"><worldbody><body><geom type="sphere" size=".1"/></body></worldbody><actuator><position joint="ghost"/></actuator></mujoco>'],
  ['negative geom size', wrap('<body><geom type="sphere" size="-1"/></body>')],
  ['invalid enum value', wrap('<body><geom type="banana" size=".1"/></body>')],
  ['non-numeric pos', wrap('<body pos="a b c"><geom type="sphere" size=".1"/></body>')],
];

const VALID_PRIMITIVES = wrap(
  `<light pos="0 0 3" dir="0 0 -1" directional="true"/>
   <geom name="floor" type="plane" size="0 0 .05"/>
   <body name="cube" pos="0 0 .5"><freejoint/><geom type="box" size=".05 .05 .05"/></body>`,
  '<compiler angle="radian" autolimits="true"/><option integrator="implicitfast"/>',
);

let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const pass = (msg) => console.log(`  ok    ${msg}`);

console.log('every invalid model must throw MJCF_COMPILE_ERROR');
let withText = 0;
for (const [name, xml] of INVALID) {
  mujoco.FS.writeFile('/working/case.xml', xml);
  try {
    compileModel(mujoco, '/working/case.xml');
    fail(`${name} — accepted a broken model`);
  } catch (err) {
    if (err.code !== 'MJCF_COMPILE_ERROR') {
      fail(`${name} — wrong error code ${err.code}: ${err.message.slice(0, 70)}`);
      continue;
    }
    if (err.mujocoDiagnostic) withText++;
    pass(`${name} [${err.mujocoDiagnostic ? 'mujoco text' : 'generic message'}]`);
  }
}

console.log('\nvalid models must compile');
mujoco.FS.writeFile('/working/good.xml', VALID_PRIMITIVES);
try {
  const model = compileModel(mujoco, '/working/good.xml');
  if (model.nbody !== 2 || model.nq !== 7) fail(`primitives scene — unexpected nbody=${model.nbody} nq=${model.nq}`);
  else pass(`primitives scene (nq=${model.nq}, nbody=${model.nbody})`);
} catch (err) {
  fail(`primitives scene rejected: ${err.message.slice(0, 140)}`);
}

// The real thing: 30 geoms, 20 .obj meshes and a PNG texture. Guards against a
// false-positive detector that would reject every legitimate scene.
mujoco.FS.mkdir('/working/ur5e');
mujoco.FS.mkdir('/working/ur5e/assets');
for (const entry of fs.readdirSync(UR5E)) {
  const p = path.join(UR5E, entry);
  if (!fs.statSync(p).isDirectory()) mujoco.FS.writeFile(`/working/ur5e/${entry}`, new Uint8Array(fs.readFileSync(p)));
}
for (const entry of fs.readdirSync(path.join(UR5E, 'assets'))) {
  mujoco.FS.writeFile(`/working/ur5e/assets/${entry}`, new Uint8Array(fs.readFileSync(path.join(UR5E, 'assets', entry))));
}
try {
  const model = compileModel(mujoco, '/working/ur5e/scene.xml');
  const { actuatorNames, jointNames } = readModelNames(model);
  if (model.nu !== 6 || actuatorNames.length !== 6 || actuatorNames[0] !== 'shoulder_pan') {
    fail(`ur5e — unexpected actuators: ${actuatorNames.join(', ')}`);
  } else if (jointNames[0] !== 'shoulder_pan_joint') {
    fail(`ur5e — unexpected joints: ${jointNames.join(', ')}`);
  } else {
    pass(`ur5e scene (nq=${model.nq}, nu=${model.nu}, ngeom=${model.ngeom})`);
    pass(`ur5e actuator names: ${actuatorNames.join(', ')}`);
  }
} catch (err) {
  fail(`ur5e scene rejected: ${err.message.slice(0, 140)}`);
}

console.log(`\n${INVALID.length} invalid models detected, ${withText} with MuJoCo text; ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
