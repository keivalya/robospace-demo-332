// Simulation time: the SimClock itself, plus a source scan that every place stepping
// the simulation also advances the clock.
//
//   npm run test:clock
//
// The scan is the point. `d->time` is unbound in this WASM build, so simulation time
// has to be reconstructed as steps × timestep — which means it is only correct while
// every `simulation.step()` site feeds the clock. A fifth site added later would make
// time run slow with no error and no visible symptom beyond "my timed trajectory
// drifts", which is close to undiagnosable. This catches it at the only moment it is
// cheap to catch.

import fs from 'node:fs';
import path from 'node:path';
import { SimClock } from '../examples/utils/simClock.js';

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));
const near = (got, want, m) => check(Math.abs(got - want) < 1e-12, `${m} (got ${got})`);

console.log('SimClock');
{
  const c = new SimClock();
  check(c.steps === 0 && c.time === 0, 'starts at zero');

  c.advance(10, 0.002);
  near(c.time, 0.02, 'advance(10, 0.002) → 0.02 s');
  check(c.steps === 10, 'and counts 10 steps');

  c.advance(5, 0.002);
  near(c.time, 0.03, 'advance accumulates');

  // Guards, because both arguments come from a model that may be mid-teardown.
  c.advance(0, 0.002);
  c.advance(-3, 0.002);
  c.advance(5, 0);
  c.advance(5, NaN);
  c.advance(5, undefined);
  near(c.time, 0.03, 'non-positive or non-finite arguments are ignored');
  check(c.steps === 15, 'and do not move the step count');

  c.reset();
  check(c.steps === 0 && c.time === 0, 'reset() returns to zero');

  // resetDataKeyframe(k) sets d->time = key_time[k], so a keyframe reset carries one.
  c.reset(1.25);
  near(c.time, 1.25, 'reset(t) starts from t');
  check(c.steps === 0, 'and zeroes the step count');

  c.reset(NaN);
  near(c.time, 0, 'reset(NaN) falls back to zero rather than poisoning the clock');
}

console.log('\nevery stepping site advances the clock');
{
  const root = path.join(import.meta.dirname, '..', 'examples');
  const files = [
    'main.js',
    'pythonIntegration.js',
    'utils/sceneWriter.js',
    'mujocoUtils.js',
  ];

  // Dead code that no live path reaches: setupGUI and reloadFunc in mujocoUtils.js are
  // never imported by main.js. Listed explicitly so that if either is ever revived,
  // this test fails and the clock gets wired in with it.
  const ALLOW = [
    { file: 'mujocoUtils.js', contains: 'parentContext.simulation.resetData()' },
  ];

  const WINDOW = 4;   // lines of context in which simClock must appear

  for (const rel of files) {
    const lines = fs.readFileSync(path.join(root, rel), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isStep = /\bsimulation\.step\s*\(/.test(line);
      const isReset = /\bsimulation\.resetData\s*\(/.test(line);
      if (!isStep && !isReset) continue;
      if (ALLOW.some((a) => rel.endsWith(a.file) && line.includes(a.contains))) {
        ok(`${rel}:${i + 1} allow-listed (dead code)`);
        continue;
      }
      const context = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join('\n');
      check(/simClock/.test(context),
        `${rel}:${i + 1} ${isStep ? 'step' : 'reset'} site feeds simClock`);
    }
  }
}

console.log('\nget_time() must not be wired to the render loop accumulator');
{
  // The original bug: window.getSimTime returned demo.mujoco_time / 1000, which
  // render() resyncs to the requestAnimationFrame timestamp — so it reported seconds
  // since page load, not simulation time.
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'examples', 'pythonIntegration.js'), 'utf8',
  );
  const getSimTime = /window\.getSimTime\s*=\s*[^;]*;/.exec(src);
  check(getSimTime !== null, 'window.getSimTime is defined');
  check(getSimTime !== null && !/mujoco_time/.test(getSimTime[0]),
    'and does not read mujoco_time');
  check(getSimTime !== null && /simClock/.test(getSimTime[0]), 'it reads simClock instead');
}

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
