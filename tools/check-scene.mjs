// Runs a candidate scene through the exact pipeline the agent uses:
// validate → write into MEMFS beside the robot → compile → apply home pose →
// settle → step. Offline, no browser, no API key.
//
//   node --import ./test/register.mjs tools/check-scene.mjs <scene.xml> [robotId]
//
// Exit code is 0 only if the scene both validates and runs, so this doubles as a
// gate when iterating on the system prompt.

import fs from 'node:fs';
import path from 'node:path';
import { DOMParser } from '../../robospace-nextjs/node_modules/@xmldom/xmldom/lib/index.js';

import load_mujoco from '../dist/mujoco_wasm.js';
import { mujocoLogHooks } from '../examples/utils/mujocoLog.js';
import { compileModel } from '../examples/mujocoUtils.js';
import { writeGeneratedScene } from '../examples/utils/sceneWriter.js';
import { validateScene, formatValidation } from '../../robospace-nextjs/src/lib/agent/validate.js';
import { ROBOTS } from '../../robospace-nextjs/src/lib/agent/robots.js';

const [scenePath, robotId] = process.argv.slice(2);
if (!scenePath) {
  console.error('usage: node --import ./test/register.mjs tools/check-scene.mjs <scene.xml> [robotId]');
  process.exit(2);
}
const xml = fs.readFileSync(scenePath, 'utf8');

// Infer the robot from the <include> when not given, the way the agent's tool call
// carries it explicitly.
let robot = robotId ? ROBOTS[robotId] : null;
if (!robot) {
  const inc = /<include\s+file\s*=\s*"([^"]+)"/.exec(xml);
  if (inc) robot = Object.values(ROBOTS).find((r) => r.entry === inc[1]) || null;
}

console.log(`scene:  ${path.basename(scenePath)}  (${xml.split('\n').length} lines, ${xml.length} bytes)`);
console.log(`robot:  ${robot ? `${robot.id} (${robot.label})` : 'none detected'}`);

// ── step 1: validate ────────────────────────────────────────────────────────
const parseXml = (text) => {
  const problems = [];
  const doc = new DOMParser({
    onError: (level, message) => {
      if (level === 'error' || level === 'fatalError') problems.push(message);
    },
  }).parseFromString(text, 'text/xml');
  if (problems.length) throw new Error(problems.join('; '));
  return doc;
};

const result = validateScene(xml, { robot, parseXml });
console.log(`\n── validate ── ${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
if (result.errors.length || result.warnings.length) console.log(formatValidation(result));
if (!result.ok) {
  console.log('\nFAILED validation — this is what the agent would be told to fix.');
  process.exit(1);
}

// ── step 2: compile and run ─────────────────────────────────────────────────
const mujoco = await load_mujoco(mujocoLogHooks);
mujoco.FS.mkdir('/working');
mujoco.FS.mount(mujoco.MEMFS, { root: '.' }, '/working');

const demo = {
  mujoco, params: { scene: null }, model: null, state: null, simulation: null, mujoco_time: 0,
  async reloadScene() {
    if (this.simulation) { try { this.simulation.free(); } catch (_) { /* ignore */ } }
    this.model = compileModel(mujoco, `/working/${this.params.scene}`);
    this.state = new mujoco.State(this.model);
    this.simulation = new mujoco.Simulation(this.model, this.state);
    this.simulation.forward();
  },
};

// Bundled robots already live in the simulator's scene folder; only registry packs
// are fetched. ur5e needs its files copied in the way the browser's boot does.
const needsFetch = robot && !robot.bundled;
if (robot?.bundled) {
  const src = path.join(import.meta.dirname, '..', 'examples', 'scenes', 'universal_robots_ur5e');
  const dir = '/working/custom_scenes/check';
  for (const p of ['custom_scenes', 'custom_scenes/check', 'custom_scenes/check/assets']) {
    try { mujoco.FS.mkdir(`/working/${p}`); } catch (_) { /* exists */ }
  }
  for (const f of fs.readdirSync(src)) {
    const abs = path.join(src, f);
    if (!fs.statSync(abs).isDirectory()) mujoco.FS.writeFile(`${dir}/${f}`, new Uint8Array(fs.readFileSync(abs)));
  }
  for (const f of fs.readdirSync(path.join(src, 'assets'))) {
    mujoco.FS.writeFile(`${dir}/assets/${f}`, new Uint8Array(fs.readFileSync(path.join(src, 'assets', f))));
  }
}

try {
  const applied = await writeGeneratedScene(demo, {
    sceneName: 'check',
    robotPack: needsFetch ? robot.id : null,
    files: [{ path: 'scene.xml', content: xml }],
    onProgress: ({ done, total, bytes, totalBytes }) => {
      if (done === total || done % 25 === 0) {
        process.stdout.write(`\r  fetching ${robot.id}: ${done}/${total} files, ${(bytes / 1048576).toFixed(1)}/${(totalBytes / 1048576).toFixed(1)} MB`);
      }
    },
  });
  if (needsFetch) process.stdout.write('\n');

  const s = applied.modelStats;
  console.log('\n── compile ── OK');
  console.log(`  nq=${s.nq} nv=${s.nv} nu=${s.nu} nbody=${s.nbody} ngeom=${s.ngeom}`);
  console.log(`  actuators: ${s.actuatorNames.join(', ') || '(none)'}`);
  for (const p of applied.patched) console.log(`  patched ${p.path}: ${p.notes.join('; ')}`);
  console.log(`  settled in ${applied.settled.steps} steps (${applied.settled.seconds.toFixed(2)}s)`
    + `${applied.settled.atRest ? ', at rest' : ', STILL MOVING when the budget ran out'}`);

  // Stability: nothing should be exploding, sinking or vibrating after settling.
  const q0 = Array.from(demo.simulation.qpos);
  for (let i = 0; i < 1500; i++) demo.simulation.step();
  const qv = Array.from(demo.simulation.qvel);
  const q1 = Array.from(demo.simulation.qpos);
  const peak = Math.max(...qv.map(Math.abs));
  const drift = Math.max(...q1.map((v, i) => Math.abs(v - q0[i])));
  const finite = q1.every(Number.isFinite);
  console.log('\n── run 3s ──');
  console.log(`  finite: ${finite}   peak |qvel|: ${peak.toExponential(1)}   max drift: ${drift.toFixed(4)}`);
  if (!finite) { console.log('  UNSTABLE: state went non-finite.'); process.exit(1); }
  if (peak > 1.0) console.log('  warning: still moving noticeably — something may be falling or vibrating.');
  else console.log('  scene is stable.');
  process.exit(0);
} catch (err) {
  console.log('\n── compile ── FAILED');
  console.log(`  ${err.message}`);
  if (err.code === 'MJCF_COMPILE_ERROR' && !err.mujocoDiagnostic) {
    console.log('  (MuJoCo reported no reason; this is the gap validate.js is meant to cover —');
    console.log('   if this scene is genuinely broken in a way the validator missed, add a check.)');
  }
  process.exit(1);
}
