// Network test: fetch a real robot pack from mujoco_menagerie into MEMFS and
// compile a scene that <include>s it.
//
//   npm run test:packs              (franka_panda, ~33 MB)
//   npm run test:packs -- stretch_3 (~73 MB, exercises the >20 MB raw fallback)
//
// Kept out of `npm test` because it downloads tens of megabytes. It is the only
// check that proves the three things the loader has to get right: assets land
// where MuJoCo's assetdir resolution expects them, binary meshes and PNGs
// survive the write byte-exact, and the oversized Stretch mesh routes around
// jsDelivr's 20 MB cap.

import load_mujoco from '../dist/mujoco_wasm.js';
import { mujocoLogHooks } from '../examples/utils/mujocoLog.js';
import { compileModel, readModelNames } from '../examples/mujocoUtils.js';
import { ensureRobotPack, ROBOT_MANIFESTS } from '../examples/utils/robotPacks.js';

const packId = process.argv[2] || 'franka_panda';
const manifest = ROBOT_MANIFESTS[packId];
if (!manifest) {
  console.error(`unknown pack "${packId}"; try: ${Object.keys(ROBOT_MANIFESTS).join(', ')}`);
  process.exit(1);
}

// Expectations derived from the robot XMLs themselves, not from memory.
const EXPECTED = {
  franka_panda: { nu: 8, firstActuator: 'actuator1', hasFreeBase: false, droppedTextures: 0 },
  // stretch.xml declares 11 image-file textures, none of which this MuJoCo build
  // can load; the pack patch has to remove all 11 or the model will not compile.
  stretch_3: { nu: 10, firstActuator: 'left_wheel_vel', hasFreeBase: true, droppedTextures: 11 },
};

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };

const mujoco = await load_mujoco(mujocoLogHooks);
mujoco.FS.mkdir('/working');
mujoco.FS.mount(mujoco.MEMFS, { root: '.' }, '/working');

// Count real network hits so the cache assertion below means something.
let networkFetches = 0;
const countingFetch = (url) => { networkFetches += 1; return fetch(url); };
const cache = new Map();
const mapCache = {
  async get(key) { return cache.get(key) || null; },
  async set(key, bytes) { cache.set(key, bytes); },
};

const sceneDir = `custom_scenes/${packId}_test`;
console.log(`fetching ${packId}: ${manifest.files.length} files, ${(manifest.totalBytes / 1048576).toFixed(1)} MB`);

const started = Date.now();
let lastPct = -10;
const { entry, paths, patched, homePose } = await ensureRobotPack(mujoco, packId, sceneDir, {
  cache: mapCache,
  fetchImpl: countingFetch,
  onProgress: ({ done, total, bytes, totalBytes }) => {
    const pct = Math.floor((bytes / totalBytes) * 100);
    if (pct >= lastPct + 20) { lastPct = pct; console.log(`  ... ${done}/${total} files, ${(bytes / 1048576).toFixed(1)} MB`); }
  },
});
console.log(`  downloaded in ${((Date.now() - started) / 1000).toFixed(1)}s over ${networkFetches} requests`);

if (paths.length === manifest.files.length) ok(`wrote all ${paths.length} files`);
else bad(`expected ${manifest.files.length} files, wrote ${paths.length}`);

const notes = patched.flatMap((p) => p.notes);
const wantDropped = EXPECTED[packId]?.droppedTextures ?? 0;
const gotDropped = notes.filter((n) => /image-file texture/.test(n))
  .reduce((n, note) => n + Number(/removed (\d+)/.exec(note)?.[1] ?? 0), 0);
if (gotDropped === wantDropped) {
  ok(wantDropped
    ? `pack patch removed ${gotDropped} unsupported image-file texture(s)`
    : 'no image-file textures to strip');
} else {
  bad(`expected ${wantDropped} textures to be stripped, got ${gotDropped} — if upstream changed, revisit stripFileTextures()`);
}

// Every pack ships a <keyframe>; it must be captured and removed. Leaving it in
// aborts mj_makeData as soon as a scene adds a joint (see below).
if (homePose) ok(`captured home pose "${homePose.name}" (${homePose.qpos.length} qpos, ${homePose.ctrl.length} ctrl)`);
else bad('no home pose captured — robots will spawn at qpos0 and visibly lurch');
if (notes.some((n) => /removed <keyframe>/.test(n))) ok('<keyframe> stripped from the robot XML');
else bad('<keyframe> was not stripped — adding any joint to a scene will abort the WASM module');

// Byte-exactness: compare a binary asset's size on disk against the git tree.
const binary = manifest.files.find((f) => /\.(stl|png)$/i.test(f.path));
if (binary) {
  const onDisk = mujoco.FS.readFile(`/working/${sceneDir}/${binary.path}`);
  if (onDisk.byteLength === binary.size) ok(`${binary.path} is byte-exact (${binary.size} bytes)`);
  else bad(`${binary.path} is ${onDisk.byteLength} bytes, expected ${binary.size} — the write path is mangling binary assets`);
}

const oversized = manifest.files.find((f) => f.viaRaw);
if (oversized) {
  const onDisk = mujoco.FS.readFile(`/working/${sceneDir}/${oversized.path}`);
  if (onDisk.byteLength === oversized.size) ok(`${oversized.path} came through the raw-GitHub fallback intact (${(oversized.size / 1048576).toFixed(1)} MB)`);
  else bad(`${oversized.path} is ${onDisk.byteLength} bytes, expected ${oversized.size}`);
}

// A scene beside the robot, following the shape of examples/scenes/*/scene.xml:
// no <compiler> here — the included robot supplies it.
const scene = `<mujoco model="${packId} test scene">
  <include file="${entry}"/>
  <asset>
    <texture type="2d" name="groundplane" builtin="checker" mark="edge" rgb1="0.2 0.3 0.4" rgb2="0.1 0.2 0.3"
      markrgb="0.8 0.8 0.8" width="300" height="300"/>
    <material name="groundplane" texture="groundplane" texuniform="true" texrepeat="5 5" reflectance="0.2"/>
  </asset>
  <worldbody>
    <light pos="0 0 3" dir="0 0 -1" directional="true"/>
    <geom name="floor" size="0 0 0.05" type="plane" material="groundplane"/>
  </worldbody>
</mujoco>`;
mujoco.FS.writeFile(`/working/${sceneDir}/scene.xml`, scene);

try {
  const model = compileModel(mujoco, `/working/${sceneDir}/scene.xml`);
  const { actuatorNames, jointNames } = readModelNames(model);
  const want = EXPECTED[packId];
  ok(`scene compiled: nq=${model.nq} nu=${model.nu} nbody=${model.nbody} ngeom=${model.ngeom}`);
  console.log(`        actuators: ${actuatorNames.join(', ')}`);

  if (want) {
    if (model.nu === want.nu) ok(`actuator count is ${want.nu}`);
    else bad(`expected nu=${want.nu}, got ${model.nu}`);
    if (actuatorNames[0] === want.firstActuator) ok(`first actuator is "${want.firstActuator}"`);
    else bad(`expected first actuator "${want.firstActuator}", got "${actuatorNames[0]}"`);
    // A mobile base shows up as a 7-dof free joint at the head of qpos.
    const freeBase = model.nq - jointNames.filter((n) => n).length >= 6;
    if (freeBase === want.hasFreeBase) ok(`mobile base: ${want.hasFreeBase}`);
    else bad(`expected hasFreeBase=${want.hasFreeBase} (nq=${model.nq}, njnt=${jointNames.length})`);
  }

  // The simulation must also step without blowing up.
  const state = new mujoco.State(model);
  const sim = new mujoco.Simulation(model, state);
  sim.forward();
  for (let i = 0; i < 200; i++) sim.step();
  const qpos = Array.from(sim.qpos);
  if (qpos.every(Number.isFinite)) ok('200 steps produced finite qpos');
  else bad(`qpos went non-finite after stepping: ${qpos.slice(0, 8).join(', ')}`);
} catch (err) {
  bad(`scene failed to compile: ${err.message.slice(0, 300)}`);
}

// Regression guard for the worst bug found in this area: a scene that includes a
// robot AND declares a joint of its own. With the robot's <keyframe> left in, this
// compiles fine and then aborts the whole WASM module inside mj_makeData
// ("mj_stackAlloc: out of memory, stack overflow", max = 0), which in the browser
// means a dead simulator until reload. It fires for any scene with a movable
// object, so essentially every interesting generated scene. A single extra hinge
// joint (nq 9 -> 10) is enough to trigger it.
const withAddedJoints = `<mujoco model="${packId} plus objects">
  <include file="${entry}"/>
  <worldbody>
    <light pos="0 0 3" dir="0 0 -1" directional="true"/>
    <geom name="floor" size="0 0 0.05" type="plane"/>
    <body name="cube" pos="0.55 0 0.03"><freejoint/><geom type="box" size=".025 .025 .025"/></body>
    <body name="lever" pos="0.3 0.4 0.2"><joint name="hinge" type="hinge" axis="0 1 0"/><geom type="box" size=".1 .02 .02"/></body>
  </worldbody>
</mujoco>`;
mujoco.FS.writeFile(`/working/${sceneDir}/plus.xml`, withAddedJoints);
{
  let sim = null;
  try {
    const model = compileModel(mujoco, `/working/${sceneDir}/plus.xml`);
    const state = new mujoco.State(model);          // this is where it used to abort
    sim = new mujoco.Simulation(model, state);
    sim.forward();
    for (let i = 0; i < 200; i++) sim.step();
    if (Array.from(sim.qpos).every(Number.isFinite)) {
      ok(`scene with added joints ran: nq=${model.nq} nkey=${model.nkey} (was fatal with a keyframe present)`);
    } else {
      bad('scene with added joints produced non-finite qpos');
    }
  } catch (err) {
    bad(`scene with added joints failed: ${err.message.slice(0, 200)}`);
  } finally {
    try { if (sim) sim.free(); } catch (_) { /* ignore */ }
  }
}

// Second pass must be served entirely from cache.
const before = networkFetches;
await ensureRobotPack(mujoco, packId, `${sceneDir}_again`, { cache: mapCache, fetchImpl: countingFetch });
if (networkFetches === before) ok('second load hit the cache with zero network requests');
else bad(`second load made ${networkFetches - before} network requests; the cache key is unstable`);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
