// test/lerobot-exporter.test.mjs
//
// Unit tests for LeRobotExporter (In-Browser LeRobot Dataset Exporter).

import assert from 'node:assert/strict';
import { DataRecorder } from '../examples/utils/dataLogger.js';
import { LeRobotExporter } from '../examples/utils/lerobotExporter.js';

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, e) => { failures++; console.error(`  FAIL  ${m}`, e || ''); };

console.log('\nLeRobotExporter metadata & serialization');

try {
  const recorder = new DataRecorder({
    fps: 30,
    imageWidth: 224,
    imageHeight: 224,
    robotType: 'franka_panda',
    datasetName: 'panda_cube_dataset',
  });

  // Populate two episodes
  recorder.startEpisode(0, 'pick_and_place', 0);
  const demoMock = {
    simulation: {
      ctrl: new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0]),
      qpos: new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.04, 0.04, 0.5, 0, 0.025, 1, 0, 0, 0]),
      qvel: new Float64Array([0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0, 0, 0, 0, 0, 0, 0, 0]),
      site_xpos: new Float64Array([0.5, 0.1, 0.2]),
      site_xmat: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    },
    model: { nu: 8, nsite: 1, nbody: 9 },
    simClock: { time: 0.0, steps: 0 },
  };

  recorder.recordFrame(demoMock, true);
  demoMock.simClock.time = 0.033;
  recorder.recordFrame(demoMock, true);
  recorder.endEpisode(true);

  recorder.startEpisode(1, 'pick_and_place', 0);
  demoMock.simClock.time = 0.066;
  recorder.recordFrame(demoMock, true);
  recorder.endEpisode(true);

  const exporter = new LeRobotExporter(recorder);

  // 1. info.json
  const info = exporter.generateInfoJson();
  assert.equal(info.codebase_version, 'v2.0');
  assert.equal(info.robot_type, 'franka_panda');
  assert.equal(info.total_episodes, 2);
  assert.equal(info.total_frames, 3);
  assert.equal(info.fps, 30);
  assert.ok(info.features.action);
  assert.ok(info.features['observation.state']);
  assert.deepEqual(info.features.action.shape, [8]);
  assert.ok(info.data_path.includes('.parquet'));
  ok('generateInfoJson conforms to LeRobot v2.0 schema');

  // 2. episodes.jsonl
  const epJsonl = exporter.generateEpisodesJsonl();
  const epLines = epJsonl.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(epLines.length, 2);
  assert.equal(epLines[0].episode_index, 0);
  assert.equal(epLines[0].length, 2);
  assert.equal(epLines[1].episode_index, 1);
  assert.equal(epLines[1].length, 1);
  ok('generateEpisodesJsonl contains valid JSON descriptors per episode');

  // 3. tasks.jsonl
  const tasksJsonl = exporter.generateTasksJsonl();
  const taskLines = tasksJsonl.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(taskLines.length, 1);
  assert.equal(taskLines[0].task, 'pick_and_place');
  ok('generateTasksJsonl maps tasks accurately');

  // 4. stats.json
  const statsStr = exporter.generateStatsJson();
  const statsObj = JSON.parse(statsStr);
  assert.ok(statsObj.action);
  assert.ok(statsObj['observation.state']);
  assert.equal(statsObj.action.mean.length, 8);
  ok('generateStatsJson contains normalization statistics');

  // 5. episode data format (JSONL & Parquet)
  const ep0Jsonl = exporter.generateEpisodeJsonl(recorder.episodes[0]);
  const ep0Lines = ep0Jsonl.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ep0Lines.length, 2);
  assert.equal(ep0Lines[0].frame_index, 0);
  assert.equal(ep0Lines[1].frame_index, 1);
  ok('generateEpisodeJsonl serializes frame timeline correctly');

  const parquetBytes = await exporter.generateEpisodeParquet(recorder.episodes[0]);
  assert.ok(parquetBytes instanceof Uint8Array);
  assert.ok(parquetBytes.length > 8);
  // Verify PAR1 magic header and footer
  assert.equal(String.fromCharCode(parquetBytes[0], parquetBytes[1], parquetBytes[2], parquetBytes[3]), 'PAR1');
  const tail = parquetBytes.subarray(parquetBytes.length - 4);
  assert.equal(String.fromCharCode(tail[0], tail[1], tail[2], tail[3]), 'PAR1');
  ok('generateEpisodeParquet writes binary buffer with PAR1 magic markers');

  // 6. Python loader script & README
  const pyScript = exporter.generatePythonLoaderScript();
  assert.ok(pyScript.includes('load_robospace_dataset'));
  assert.ok(pyScript.includes('info.json'));
  ok('generatePythonLoaderScript creates ready-to-run helper');

  const readme = exporter.generateReadme();
  assert.ok(readme.includes('LeRobot v2.0'));
  assert.ok(readme.includes('franka_panda'));
  ok('generateReadme outputs dataset documentation');
} catch (err) {
  bad('LeRobotExporter test failed', err);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s) in LeRobotExporter tests`);
  process.exit(1);
} else {
  console.log('\n0 failure(s)\n');
}
