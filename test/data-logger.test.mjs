// test/data-logger.test.mjs
//
// Unit tests for DataRecorder (Synchronized Observers & The Data Logger).

import assert from 'node:assert/strict';
import { DataRecorder } from '../examples/utils/dataLogger.js';

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, e) => { failures++; console.error(`  FAIL  ${m}`, e || ''); };

console.log('\nDataRecorder lifecycle & observation logging');

try {
  const recorder = new DataRecorder({
    fps: 30,
    imageWidth: 224,
    imageHeight: 224,
    robotType: 'franka_panda',
    datasetName: 'test_dataset',
  });

  assert.equal(recorder.fps, 30);
  assert.equal(recorder.imageWidth, 224);
  assert.equal(recorder.isRecording, false);
  ok('recorder initializes with default configuration');

  // Start episode
  recorder.startEpisode(0, 'test_pick_task', 0);
  assert.equal(recorder.isRecording, true);
  assert.equal(recorder.currentEpisodeIndex, 0);
  assert.equal(recorder.currentEpisodeFrames.length, 0);
  ok('startEpisode sets active recording state');

  // Mock demo with simulation & model
  const mockDemo = {
    simulation: {
      ctrl: new Float64Array([0.1, -0.2, 0.3, -0.4, 0.5, -0.6, 0.7, 1.0]),
      qpos: new Float64Array([0.1, -0.2, 0.3, -0.4, 0.5, -0.6, 0.7, 0.04, 0.04, 0.5, 0, 0.025, 1, 0, 0, 0]),
      qvel: new Float64Array([0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.0, 0.0, 0, 0, 0, 0, 0, 0]),
      site_xpos: new Float64Array([0.45, 0.12, 0.22]),
      site_xmat: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    },
    model: {
      nu: 8,
      nsite: 1,
      nbody: 9,
    },
    simClock: { time: 0.033, steps: 16 },
  };

  const f1 = recorder.recordFrame(mockDemo, true);
  assert.ok(f1);
  assert.equal(f1.frame_index, 0);
  assert.equal(f1.episode_index, 0);
  assert.equal(f1.action.length, 8);
  assert.equal(f1.state.length, 8 + 8 + 3 + 4); // jointPos(8) + jointVel(8) + eePos(3) + eeQuat(4)
  assert.deepEqual(f1.eePos, [0.45, 0.12, 0.22]);
  ok('recordFrame extracts unprivileged kinematics and 6-DoF end-effector pose');

  // Advance clock and record second frame
  mockDemo.simClock.time = 0.067;
  mockDemo.simulation.ctrl[0] = 0.2;
  const f2 = recorder.recordFrame(mockDemo, true);
  assert.ok(f2);
  assert.equal(f2.frame_index, 1);
  assert.equal(recorder.currentEpisodeFrames.length, 2);
  ok('frame sequence accumulates in current episode');

  // End episode
  const epResult = recorder.endEpisode(true);
  assert.equal(recorder.isRecording, false);
  assert.equal(epResult.success, true);
  assert.equal(epResult.length, 2);
  assert.equal(recorder.episodes.length, 1);
  assert.equal(recorder.successCount, 1);
  ok('endEpisode finishes episode and updates success counter');

  // Statistics verification
  const stats = recorder.getStats();
  assert.ok(stats.action);
  assert.ok(stats['observation.state']);
  assert.equal(stats.action.mean.length, 8);
  assert.ok(Math.abs(stats.action.min[0] - 0.1) < 1e-6);
  assert.ok(Math.abs(stats.action.max[0] - 0.2) < 1e-6);
  assert.ok(Math.abs(stats.action.mean[0] - 0.15) < 1e-6);
  ok('stats accumulator calculates accurate min, max, mean and std');

  // Progress inspection
  const progress = recorder.getProgress();
  assert.equal(progress.totalEpisodes, 1);
  assert.equal(progress.totalFrames, 2);
  assert.equal(progress.successRate, 1.0);
  ok('getProgress reports valid totals and 100% success rate');

  // Clear verification
  recorder.clear();
  assert.equal(recorder.episodes.length, 0);
  assert.equal(recorder.totalFrames, 0);
  assert.equal(recorder.successCount, 0);
  ok('clear resets all recorded state');
} catch (err) {
  bad('DataRecorder test failed', err);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s) in DataRecorder tests`);
  process.exit(1);
} else {
  console.log('\n0 failure(s)\n');
}
