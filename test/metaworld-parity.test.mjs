// Does a Meta-World scene run *identically* in this MuJoCo WASM build and in
// native MuJoCo on the inference board?
//
// This matters because the RoboSpace Meta-World demo runs the physics in the
// browser and the policy on the board, and the board is where success was
// measured. If the two simulators disagree, a browser number means nothing.
//
// Meta-World was chosen over LIBERO precisely because its controller is
// portable: a mocap body welded to the hand, driven by
//
//     mocap_pos = clip(mocap_pos + clip(a[0:3], -1, 1)/100, low, high)
//     ctrl = [a[3], -a[3]];  step 5 frames
//
// against LIBERO's 413-line OSC_POSE. But "portable" turned out to hinge on one
// non-obvious thing, which this test pins:
//
//   **Meta-World patches the weld at runtime, and nothing in the MJCF says so.**
//   reset_mocap_welds() (metaworld/sawyer_xyz_env.py:133) overwrites eq_data for
//   every weld with [0,0,0, 0,0,0,-1, 0,0,0, 5.0] -- identity relpose and
//   torquescale 5. Left to the compiler you get relpose auto-computed from the
//   initial configuration (here pos [1.1355, 0.1603, 0.3170], quat
//   [0.6428, -0.7660, 0, 0]) and torquescale 1. The visible symptom is not an
//   error: the arm has no actuators at all (nu=2, both gripper), so with a 5x
//   weaker torque coupling the hand simply sags ~19 cm below the mocap target and
//   tracks it loosely. A policy driving it looks broken.
//
// With the patch applied the agreement is exact. Reference values below were
// produced on the board under MuJoCo 3.3.0; this build is 3.3.2.
//
//   MW_ASSETS=/path/to/metaworld/assets node --import ./test/register.mjs \
//     test/metaworld-parity.test.mjs
//
// The asset tree is whatever `pip show metaworld` installs, minus the PNGs:
// 161 XML + 131 STL = 5.47 MB. stripFileTextures() removes the 3 texture
// references in basic_scene.xml (wood2/floor2/metal), which this build cannot
// load.
import fs from 'node:fs';
import path from 'node:path';
import load_mujoco from '../dist/mujoco_wasm.js';
import { mujocoLogHooks } from '../examples/utils/mujocoLog.js';
import { compileModel, readNames, readModelNames } from '../examples/mujocoUtils.js';
import { stripFileTextures } from '../examples/utils/robotPacks.js';

const SRC = process.env.MW_ASSETS
  || '/home/ubuntu/vla_model/.venv/lib/python3.12/site-packages/metaworld/assets';
if (!fs.existsSync(SRC)) {
  console.log(`SKIP: no Meta-World assets at ${SRC} (set MW_ASSETS)`);
  process.exit(0);
}

// --- reference values, measured on the board (MuJoCo 3.3.0) ------------------
const WELD_EQ_DATA = [0, 0, 0, 0, 0, 0, -1, 0, 0, 0, 5.0];
const HAND_INIT = [0, 0.6, 0.2], MOCAP_QUAT = [1, 0, 1, 0];
const LOW = [-0.5, 0.4, 0.05], HIGH = [0.5, 1.0, 0.5];   // drawer-open's own bounds
const SCALE = 1 / 100, FRAME_SKIP = 5, SETTLE = 50;
const BOARD_RESET = {                       // hand xyz during _reset_hand
  0:  [1.1294, 0.1968, 0.3103], 10: [-0.0333, 0.4926, 0.2869],
  20: [0.0140, 0.5854, 0.2090], 30: [-0.0139, 0.6094, 0.1981],
  40: [-0.0030, 0.6068, 0.1978], 49: [0.0046, 0.6015, 0.1952],
};
const BOARD_DRIVE = {                       // hand xyz + gripper gap under a fixed drive
  0:  [0.0045, 0.6017, 0.1950, 1.0000], 15: [-0.0021, 0.7124, 0.1986, 1.0000],
  30: [-0.0009, 0.7629, 0.2022, 0.8654], 45: [0.0012, 0.7833, 0.2030, 0.6107],
  59: [0.0021, 0.7846, 0.2034, 0.2849],
};
const BOARD_MODEL = { nbody: 37, ngeom: 52, njnt: 10, ncam: 7, nmocap: 1, neq: 1,
                      nq: 10, nv: 10, nu: 2 };
const TOL = 1e-3;

const mujoco = await load_mujoco(mujocoLogHooks);
mujoco.FS.mkdir('/working');
const mkdirp = (p) => { let c = '';
  for (const s of p.split('/').filter(Boolean)) { c += '/' + s;
    if (!mujoco.FS.analyzePath(c).exists) mujoco.FS.mkdir(c); } };
let nXml = 0, nBin = 0, dropped = new Set();
(function stage(rel = '') {
  for (const n of fs.readdirSync(path.join(SRC, rel))) {
    const r = rel ? `${rel}/${n}` : n, abs = path.join(SRC, r);
    if (fs.statSync(abs).isDirectory()) { mkdirp(`/working/mw/${r}`); stage(r); continue; }
    const ext = path.extname(n).toLowerCase();
    if (ext === '.png') continue;                    // stripFileTextures drops the refs
    if (!['.xml', '.stl', '.msh', '.obj'].includes(ext)) continue;
    mkdirp(path.posix.dirname(`/working/mw/${r}`));
    if (ext === '.xml') {
      const t = stripFileTextures(fs.readFileSync(abs, 'utf8'));
      t.dropped.forEach((d) => dropped.add(d));
      mujoco.FS.writeFile(`/working/mw/${r}`, t.xml); nXml++;
    } else {
      mujoco.FS.writeFile(`/working/mw/${r}`, new Uint8Array(fs.readFileSync(abs))); nBin++;
    }
  }
})();

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};
console.log(`staged ${nXml} xml + ${nBin} mesh; textures dropped: ${dropped.size}`);

// --- 1. every offered scene compiles ----------------------------------------
const SCENES = ['sawyer_drawer', 'sawyer_door_pull', 'sawyer_faucet',
                'sawyer_reach_v3', 'sawyer_button_press'];
for (const s of SCENES) {
  const f = `/working/mw/sawyer_xyz/${s}.xml`;
  if (!mujoco.FS.analyzePath(f).exists) { check(`compile ${s}`, false, 'file absent'); continue; }
  try { compileModel(mujoco, f); check(`compile ${s}`, true); }
  catch (e) { check(`compile ${s}`, false, String(e.message || e).slice(0, 200)); }
}

// --- 2. the drawer scene matches the board's model dimensions ---------------
const model = compileModel(mujoco, '/working/mw/sawyer_xyz/sawyer_drawer.xml');
const bad = Object.entries(BOARD_MODEL).filter(([k, v]) => model[k] !== v);
check('model dims match the board', bad.length === 0,
      bad.length ? bad.map(([k, v]) => `${k}=${model[k]} want ${v}`).join(' ') : '');

const bodies = readNames(model, model.name_bodyadr, model.nbody, 'body');
const cameras = readNames(model, model.name_camadr, model.ncam, 'cam');
const { jointNames } = readModelNames(model);
check('corner4 camera present', cameras.includes('corner4'),
      `cameras: ${cameras.join(',')}`);
check('corner4 fovy is 60', model.cam_fovy[cameras.indexOf('corner4')] === 60);
check('hand/claw bodies present',
      ['hand', 'rightclaw', 'leftclaw', 'mocap'].every((b) => bodies.includes(b)));
check('goal_slidey joint present', jointNames.includes('goal_slidey'));
// Only the floor is a plane. Planes become Reflectors (mujocoUtils.js:672) and
// CameraViewer hides every reflector during captureImage, so a plane is invisible
// to the policy -- the ported scene must swap it for a thin box.
const planes = [...Array(model.ngeom).keys()].filter((g) => model.geom_type[g] === 0);
check('exactly one plane geom (the floor)', planes.length === 1, `ids ${planes}`);

// --- 3. the weld patch, then physics parity ---------------------------------
const stride = model.eq_data.length / model.neq;
for (let i = 0; i < model.neq; i++) {
  if (model.eq_type[i] !== 1) continue;                    // mjEQ_WELD
  for (let k = 0; k < stride; k++) model.eq_data[i * stride + k] = WELD_EQ_DATA[k] ?? 0;
}
const state = new mujoco.State(model);
const sim = new mujoco.Simulation(model, state);
const bi = (n) => bodies.indexOf(n);
const hand = bi('hand'), rc = bi('rightclaw'), lc = bi('leftclaw');
const at = (id) => [sim.xpos[id * 3], sim.xpos[id * 3 + 1], sim.xpos[id * 3 + 2]];
const gap = () => { const a = at(rc), b = at(lc);
  return Math.min(1, Math.max(0, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 0.1)); };
const near = (got, want) => Math.max(...want.map((w, i) => Math.abs(got[i] - w))) < TOL;

for (let i = 0; i < model.nq; i++) sim.qpos[i] = 0;
for (let i = 0; i < model.nv; i++) sim.qvel[i] = 0;
sim.forward();
let resetOk = true;
for (let i = 0; i < SETTLE; i++) {
  for (let k = 0; k < 3; k++) sim.mocap_pos[k] = HAND_INIT[k];
  for (let k = 0; k < 4; k++) sim.mocap_quat[k] = MOCAP_QUAT[k];
  sim.ctrl[0] = -1; sim.ctrl[1] = 1;
  for (let k = 0; k < FRAME_SKIP; k++) sim.step();
  if (BOARD_RESET[i] && !near(at(hand), BOARD_RESET[i])) {
    resetOk = false;
    console.log(`        iter ${i}: got [${at(hand).map((v) => v.toFixed(4))}] ` +
                `want [${BOARD_RESET[i]}]`);
  }
}
check('_reset_hand trajectory matches the board', resetOk,
      `final hand [${at(hand).map((v) => v.toFixed(6))}]`);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
let driveOk = true;
for (let step = 0; step < 60; step++) {
  const a = step < 40 ? [0, 1, 0, -1] : [0, 0, 0, 1];
  for (let i = 0; i < 3; i++)
    sim.mocap_pos[i] = clamp(sim.mocap_pos[i] + clamp(a[i], -1, 1) * SCALE, LOW[i], HIGH[i]);
  sim.ctrl[0] = a[3]; sim.ctrl[1] = -a[3];
  for (let k = 0; k < FRAME_SKIP; k++) sim.step();
  const want = BOARD_DRIVE[step];
  if (want && !near([...at(hand), gap()], want)) {
    driveOk = false;
    console.log(`        step ${step}: got [${[...at(hand), gap()].map((v) => v.toFixed(4))}] ` +
                `want [${want}]`);
  }
}
check('mocap drive trajectory matches the board', driveOk);

// --- 4. per-task reset_model(): drawer, goal marker, starting position -------
//
// _reset_hand alone is not a reset. Each task also places the drawer, places the
// *visible* goal marker, and sets the drawer's starting position -- and the
// marker is rendered into the frame the policy consumes, so getting it wrong
// points the policy at nothing. This mirrors robospaceMetaworldReset in
// examples/main.js; the expected values come from
// metaworld/envs/sawyer_drawer_{open,close}_v3.py.
const TASK_RESET = {
  19: { goalOffsetY: -0.36, slide: 0.0 },     // open:  goal 0.16 + maxDist 0.20 out front
  18: { goalOffsetY: -0.16, slide: -0.15 },   // close: goal at the frame, drawer starts out
};
const sitesN = readNames(model, model.name_siteadr, model.nsite, 'site');
const jointsN = readModelNames(model).jointNames;
const drawerB = bodies.indexOf('drawer'), goalS = sitesN.indexOf('goal'),
      slideJ = jointsN.indexOf('goal_slidey'), linkB = bodies.indexOf('drawer_link');
check('drawer, goal site and drawer_link all present',
      drawerB >= 0 && goalS >= 0 && slideJ >= 0 && linkB >= 0);

const DRAWER_X = 0.0274;                      // the board's seed-0 draw
function resetForTask(taskId, x) {
  const cfg = TASK_RESET[taskId];
  for (let i = 0; i < model.neq; i++) {
    if (model.eq_type[i] !== 1) continue;
    for (let k = 0; k < stride; k++) model.eq_data[i * stride + k] = WELD_EQ_DATA[k] ?? 0;
  }
  model.body_pos[drawerB * 3] = x; model.body_pos[drawerB * 3 + 1] = 0.9; model.body_pos[drawerB * 3 + 2] = 0;
  model.site_pos[goalS * 3] = x;
  model.site_pos[goalS * 3 + 1] = 0.9 + cfg.goalOffsetY;
  model.site_pos[goalS * 3 + 2] = 0.09;
  for (let i = 0; i < model.nq; i++) sim.qpos[i] = 0;
  for (let i = 0; i < model.nv; i++) sim.qvel[i] = 0;
  sim.qpos[model.jnt_qposadr[slideJ]] = cfg.slide;
  sim.forward();
  for (let i = 0; i < SETTLE; i++) {
    for (let k = 0; k < 3; k++) sim.mocap_pos[k] = HAND_INIT[k];
    for (let k = 0; k < 4; k++) sim.mocap_quat[k] = MOCAP_QUAT[k];
    sim.ctrl[0] = -1; sim.ctrl[1] = 1;
    for (let k = 0; k < FRAME_SKIP; k++) sim.step();
  }
  sim.qpos[model.jnt_qposadr[slideJ]] = cfg.slide;
  sim.forward();
}
for (const [taskId, wantGoalY, wantSlide, label] of
     [[19, 0.54, 0.0, 'shut'], [18, 0.74, -0.15, 'open']]) {
  resetForTask(taskId, DRAWER_X);
  const goal = [model.site_pos[goalS * 3], model.site_pos[goalS * 3 + 1], model.site_pos[goalS * 3 + 2]];
  const slide = sim.qpos[model.jnt_qposadr[slideJ]];
  check(`task ${taskId}: goal marker at the task's target`,
        near(goal, [DRAWER_X, wantGoalY, 0.09]),
        `[${goal.map((v) => v.toFixed(4))}]`);
  check(`task ${taskId}: drawer starts ${label}`, Math.abs(slide - wantSlide) < TOL,
        `goal_slidey ${slide.toFixed(4)}, drawer_link y ${sim.xpos[linkB * 3 + 1].toFixed(4)}`);
  check(`task ${taskId}: hand still homed after the task reset`,
        near(at(hand), BOARD_RESET[49]), `[${at(hand).map((v) => v.toFixed(4))}]`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
