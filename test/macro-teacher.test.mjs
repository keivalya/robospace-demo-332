// test/macro-teacher.test.mjs
//
// Unit tests for TEACHER_TASKS (The Privileged Macro Action Engine).

import assert from 'node:assert/strict';
import { TEACHER_TASKS } from '../examples/utils/macroTeacher.js';

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, e) => { failures++; console.error(`  FAIL  ${m}`, e || ''); };

console.log('\nTeacher tasks & macro policy specifications');

try {
  assert.ok(TEACHER_TASKS.panda_pick_cube);
  assert.ok(TEACHER_TASKS.panda_pick_and_place);
  assert.ok(TEACHER_TASKS.panda_stack_blocks);
  assert.ok(TEACHER_TASKS.ur5e_reach_beacon);
  ok('all 4 built-in teacher tasks exist');

  // Check panda_pick_cube
  const pick = TEACHER_TASKS.panda_pick_cube;
  assert.equal(pick.robot, 'franka_panda');
  assert.ok(pick.sceneXml.includes('<include file="panda.xml"/>'));
  assert.ok(pick.sceneXml.includes('<body name="cube"'));
  assert.ok(pick.pythonScript.includes('sim.get_exact_object_pose'));
  assert.ok(pick.pythonScript.includes('robot.reach_pose'));
  assert.ok(pick.pythonScript.includes('robot.open_gripper'));
  assert.ok(pick.pythonScript.includes('robot.close_gripper'));
  assert.equal(typeof pick.evaluateSuccess, 'function');
  assert.ok(pick.domainRandomization.cube);
  assert.deepEqual(pick.domainRandomization.cube.x, [0.44, 0.54]);
  ok('panda_pick_cube has scene, domain randomization, and scripted policy');

  // Check panda_pick_and_place
  const pnp = TEACHER_TASKS.panda_pick_and_place;
  assert.equal(pnp.robot, 'franka_panda');
  assert.ok(pnp.sceneXml.includes('name="pad"'));
  assert.ok(pnp.pythonScript.includes('target_pad'));
  assert.equal(typeof pnp.evaluateSuccess, 'function');
  ok('panda_pick_and_place targets pad with valid evaluator');

  // Check panda_stack_blocks
  const stack = TEACHER_TASKS.panda_stack_blocks;
  assert.ok(stack.sceneXml.includes('name="base_cube"'));
  assert.ok(stack.sceneXml.includes('name="top_cube"'));
  assert.ok(stack.pythonScript.includes('top_pose'));
  assert.ok(stack.pythonScript.includes('base_pose'));
  assert.equal(typeof stack.evaluateSuccess, 'function');
  ok('panda_stack_blocks defines dual cubes with stacking macro');

  // Check evaluateSuccess logic
  // Mock model with a cube body
  const nameBuffer = new Uint8Array([
    119, 111, 114, 108, 100, 0, // world\0
    99, 117, 98, 101, 0,        // cube\0
  ]);
  const mockModel = {
    nbody: 2,
    name_bodyadr: [0, 6],
    names: nameBuffer,
  };
  const mockSim = {
    xpos: new Float64Array([0, 0, 0, 0.5, 0.0, 0.25]), // cube lifted to 0.25m
  };

  assert.equal(pick.evaluateSuccess(mockSim, mockModel), true);
  mockSim.xpos[5] = 0.025; // on ground
  assert.equal(pick.evaluateSuccess(mockSim, mockModel), false);
  ok('evaluateSuccess correctly evaluates cube lift condition');
} catch (err) {
  bad('Teacher tasks test failed', err);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s) in Teacher tasks tests`);
  process.exit(1);
} else {
  console.log('\n0 failure(s)\n');
}
