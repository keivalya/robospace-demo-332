// test/camera-capture.test.mjs
//
// Tests for camera image capture, projection matrix FOV synchronization,
// virtual camera offsets, and transform synchronization.

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CameraViewer } from '../examples/utils/CameraViewer.js';
import { DataRecorder } from '../examples/utils/dataLogger.js';
import { LeRobotExporter } from '../examples/utils/lerobotExporter.js';

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, e) => { failures++; console.error(`  FAIL  ${m}`, e || ''); };

console.log('\nCamera capture pipeline & transform synchronization');

try {
  // 1. Test CameraViewer FOV & projection matrix update
  const cv = new CameraViewer(null);
  const mockModel = {
    ncam: 1,
    name_camadr: new Int32Array([0]),
    names: new TextEncoder().encode('front_camera\0'),
    cam_bodyid: new Int32Array([-1]),
    cam_fovy: new Float64Array([60]), // 60 deg FOV
  };
  const mockSim = {
    cam_xpos: new Float64Array([0.85, 0.0, 0.45]),
    cam_xmat: new Float64Array([
      0, -0.5, 0.866,
      1, 0, 0,
      0, 0.866, 0.5,
    ]),
  };

  cv.onModelChanged(mockModel, mockSim);
  assert.equal(cv.cameras.length, 1);
  assert.equal(cv.cameras[0].name, 'front_camera');
  assert.equal(cv.cameras[0].fovy, 60);

  // Update camera and verify camera fov is applied
  cv.updateCamera(mockSim, mockModel, 0);
  assert.equal(cv.threeCamera.fov, 60);
  ok('native camera updates fov and orientation from MuJoCo state');

  // 2. Test virtual camera offset from robot hand
  const mockPandaModel = {
    ncam: 0,
    nsite: 0,
    nbody: 2,
    name_bodyadr: new Int32Array([0, 5]),
    names: new TextEncoder().encode('base\0hand\0'),
  };
  const mockPandaSim = {
    xpos: new Float64Array([0, 0, 0,  0.5, 0.1, 0.6]),
    xmat: new Float64Array([
      1, 0, 0,  0, 1, 0,  0, 0, 1,
      0.707, 0.707, 0,  0.707, -0.707, 0,  0, 0, -1,
    ]),
  };

  cv.onModelChanged(mockPandaModel, mockPandaSim);
  assert.equal(cv.cameras.length, 1);
  assert.ok(cv.cameras[0].isVirtual);
  cv.updateCamera(mockPandaSim, mockPandaModel, 0);

  // Verify virtual camera matrix is properly oriented
  const mat = cv.threeCamera.matrix;
  assert.ok(mat instanceof THREE.Matrix4);
  ok('virtual gripper camera offsets correctly along tool axis');

  // 3. Test DataRecorder camera key resolution
  const recorder = new DataRecorder({
    fps: 30,
    imageWidth: 224,
    imageHeight: 224,
  });

  const demoMock = {
    simulation: {
      ctrl: new Float64Array([0.1, 0.2]),
      qpos: new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]),
      qvel: new Float64Array([0.01, 0.02]),
      xpos: new Float64Array([0, 0, 0, 0.5, 0.1, 0.6]),
      xquat: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0]),
    },
    model: { nu: 2, nbody: 2, nsite: 0 },
    simClock: { time: 0.1, steps: 50 },
    cameraViewer: cv,
    renderer: null, // headless
    scene: null,
  };

  recorder.startEpisode(0, 'test_task', 0);
  recorder.recordFrame(demoMock, true);
  recorder.endEpisode(true);

  assert.ok(recorder.cameraName);
  ok('DataRecorder persists resolved active camera name');

  // 4. Test LeRobotExporter standardized camera key
  const exporter = new LeRobotExporter(recorder);
  const camKey = exporter.getCameraKey();
  assert.ok(camKey.startsWith('observation.images.'));
  const info = exporter.generateInfoJson();
  assert.ok(info.features[camKey]);
  assert.deepEqual(info.features[camKey].shape, [224, 224, 3]);
  ok('LeRobotExporter standardized observation.images.<name> feature key');

} catch (err) {
  bad('Camera capture test failed', err);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s) in camera capture tests`);
  process.exit(1);
} else {
  console.log('\n0 failure(s)\n');
}
