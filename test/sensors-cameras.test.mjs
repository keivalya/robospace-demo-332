// test/sensors-cameras.test.mjs
//
// Tests for camera coordinate transformations, sensor slicing,
// camera and sensor metadata decoding, and readModelStats.

import load_mujoco from '../dist/mujoco_wasm.js';
import { mujocoLogHooks } from '../examples/utils/mujocoLog.js';
import { compileModel, readNames } from '../examples/mujocoUtils.js';
import { readModelStats } from '../examples/utils/sceneWriter.js';
import { CameraViewer } from '../examples/utils/CameraViewer.js';

function createMockDom() {
  const makeEl = (tag = 'div') => {
    const listeners = {};
    const classes = new Set();
    const children = [];
    const attrs = {};
    const el = {
      tagName: tag.toUpperCase(),
      style: {},
      innerHTML: '',
      textContent: '',
      value: '',
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, force) => {
          const res = force !== undefined ? !!force : !classes.has(c);
          if (res) classes.add(c); else classes.delete(c);
          return res;
        },
        contains: (c) => classes.has(c),
      },
      addEventListener: (ev, fn) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(fn);
      },
      removeEventListener: (ev, fn) => {
        if (listeners[ev]) listeners[ev] = listeners[ev].filter((f) => f !== fn);
      },
      click: () => {
        (listeners['click'] || []).forEach((fn) => fn({ target: el }));
      },
      appendChild: (ch) => { children.push(ch); return ch; },
      querySelector: () => makeEl('div'),
      querySelectorAll: () => [],
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k] || null,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200 }),
      children,
    };
    return el;
  };
  return {
    createElement: makeEl,
    getElementById: () => makeEl('div'),
    body: makeEl('body'),
  };
}

if (!globalThis.document) {
  globalThis.document = createMockDom();
}

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));
const eq = (got, want, m) => check(
  JSON.stringify(got) === JSON.stringify(want),
  JSON.stringify(got) === JSON.stringify(want) ? m : `${m} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`
);

console.log('camera coordinate transformation math');
{
  // Coordinate change matrix S: MuJoCo (x, y, z) -> Three.js (x, z, -y)
  // Let Rm be a 3x3 rotation matrix in MuJoCo row-major order.
  // Rt = S * Rm
  // In row-major representation:
  // Row 0: Rm[0],  Rm[1],  Rm[2]
  // Row 1: Rm[6],  Rm[7],  Rm[8]
  // Row 2: -Rm[3], -Rm[4], -Rm[5]

  function transformMatrix(m) {
    return [
      m[0],  m[1],  m[2],
      m[6],  m[7],  m[8],
      -m[3], -m[4], -m[5],
    ];
  }

  function det3(m) {
    return (
      m[0] * (m[4] * m[8] - m[5] * m[7]) -
      m[1] * (m[3] * m[8] - m[5] * m[6]) +
      m[2] * (m[3] * m[7] - m[4] * m[6])
    );
  }

  // 1. Identity in MuJoCo
  const idM = [
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ];
  const idT = transformMatrix(idM);
  check(Math.abs(det3(idT) - 1.0) < 1e-9, 'transformed identity has determinant +1');

  // 2. Camera looking forward along +X in MuJoCo (Z is up):
  // Cam looking dir is -Z_cam = +X_world, Cam up is +Y_cam = +Z_world, Cam right is +X_cam = -Y_world
  // Columns:
  // col 0 (X_cam): [0, -1, 0]
  // col 1 (Y_cam): [0,  0, 1]
  // col 2 (Z_cam): [-1, 0, 0]
  const camFwd = [
    0, 0, -1,
    -1, 0, 0,
    0, 1, 0,
  ];
  check(Math.abs(det3(camFwd) - 1.0) < 1e-9, 'cam looking along +X is right-handed (det = 1)');
  const camFwdT = transformMatrix(camFwd);
  check(Math.abs(det3(camFwdT) - 1.0) < 1e-9, 'transformed forward cam has determinant +1');

  // In Three.js, view direction is -Z_cam_t:
  // Z_cam_t is column 2 of camFwdT:
  const zCamT = [camFwdT[2], camFwdT[5], camFwdT[8]];
  eq(zCamT, [-1, 0, 0], 'Three.js camera looking dir -Z corresponds to +X in Three.js coordinates');
}

console.log('\nmodel with camera and sensor compilation & decoding');
{
  const mujoco = await load_mujoco(mujocoLogHooks);
  mujoco.FS.mkdir('/working_test');
  mujoco.FS.mount(mujoco.MEMFS, { root: '.' }, '/working_test');

  const testSceneXml = `
<mujoco model="sensor_camera_test">
  <worldbody>
    <light pos="0 0 3"/>
    <geom name="floor" type="plane" size="1 1 0.1"/>
    <body name="sensor_robot" pos="0 0 0.5">
      <joint name="slide_z" type="slide" axis="0 0 1"/>
      <geom name="box" type="box" size="0.1 0.1 0.1"/>
      <site name="imu_site" pos="0 0 0"/>
      <camera name="front_cam" pos="0.1 0 0" fovy="60"/>
      <camera name="wrist_cam" pos="0 0 0.1" fovy="45"/>
    </body>
  </worldbody>
  <actuator>
    <motor name="lift_motor" joint="slide_z"/>
  </actuator>
  <sensor>
    <accelerometer name="body_accel" site="imu_site"/>
    <gyro name="body_gyro" site="imu_site"/>
  </sensor>
</mujoco>
`;
  mujoco.FS.writeFile('/working_test/scene.xml', testSceneXml);
  const model = compileModel(mujoco, '/working_test/scene.xml');

  check(model.ncam === 2, 'model has 2 cameras');
  check(model.nsensor === 2, 'model has 2 sensors');

  const camNames = readNames(model, model.name_camadr, model.ncam, 'camera');
  eq(camNames, ['front_cam', 'wrist_cam'], 'camera names correctly decoded');

  const sensorNames = readNames(model, model.name_sensoradr, model.nsensor, 'sensor');
  eq(sensorNames, ['body_accel', 'body_gyro'], 'sensor names correctly decoded');

  const stats = readModelStats(model);
  eq(stats.cameraNames, ['front_cam', 'wrist_cam'], 'readModelStats includes cameraNames');
  eq(stats.sensorNames, ['body_accel', 'body_gyro'], 'readModelStats includes sensorNames');
  check(stats.ncam === 2, 'readModelStats ncam is 2');
  check(stats.nsensor === 2, 'readModelStats nsensor is 2');

  // Test sensor dimension and address slicing
  const state = new mujoco.State(model);
  const simulation = new mujoco.Simulation(model, state);

  // sensordata length
  check(simulation.sensordata.length >= 6, 'sensordata contains at least 6 values (3 accel + 3 gyro)');
  const adr0 = model.sensor_adr[0];
  const dim0 = model.sensor_dim[0];
  const adr1 = model.sensor_adr[1];
  const dim1 = model.sensor_dim[1];
  check(dim0 === 3, 'accel dim is 3');
  check(dim1 === 3, 'gyro dim is 3');
  check(adr1 === adr0 + dim0, 'gyro address immediately follows accel address');

  // cam_xpos and cam_xmat exist and are valid Float64Arrays
  check(simulation.cam_xpos.length === 6, 'cam_xpos has 6 coordinates (2 cameras x 3)');
  check(simulation.cam_xmat.length === 18, 'cam_xmat has 18 coordinates (2 cameras x 9)');

  console.log('\nmodel without cameras or end-effector (camera button conditional hiding)');
  const testSceneNoSensors = `
<mujoco model="no_sensors_robot">
  <worldbody>
    <light pos="0 0 3"/>
    <geom name="floor" type="plane" size="1 1 0.1"/>
    <body name="link1" pos="0 0 0.5">
      <joint name="joint1" type="hinge" axis="0 0 1"/>
      <geom name="geom1" type="box" size="0.1 0.1 0.1"/>
      <body name="link2" pos="0.2 0 0">
        <joint name="joint2" type="slide" axis="1 0 0"/>
        <geom name="geom2" type="sphere" size="0.05"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <motor name="motor1" joint="joint1"/>
    <motor name="motor2" joint="joint2"/>
  </actuator>
</mujoco>
`;
  mujoco.FS.writeFile('/working_test/no_sensors.xml', testSceneNoSensors);
  const modelNoSensors = compileModel(mujoco, '/working_test/no_sensors.xml');
  const stateNoSensors = new mujoco.State(modelNoSensors);
  const simNoSensors = new mujoco.Simulation(modelNoSensors, stateNoSensors);

  check(modelNoSensors.nsensor === 0, 'model has 0 native sensors');
  check(modelNoSensors.ncam === 0, 'model has 0 native cameras');

  const container = globalThis.document.createElement('div');
  const camBtn = globalThis.document.createElement('button');

  // CameraViewer onboard POV & conditional hiding
  const camViewer = new CameraViewer(container);
  camViewer.setToggleButton(camBtn);

  // Model without cameras or end-effector:
  camViewer.onModelChanged(modelNoSensors, simNoSensors);
  check(camViewer.cameras.length === 0, 'no cameras created when model lacks cameras and end-effector');
  check(camBtn.style.display === 'none', 'camera button is hidden when no camera or end-effector exists');
  camViewer.show();
  check(!camViewer.visible, 'show() does not open viewer when cameras.length is 0');

  console.log('\nCameraViewer Gripper POV on model with attachment_site');
  const testSceneArm = `
<mujoco model="arm_with_gripper">
  <worldbody>
    <light pos="0 0 3"/>
    <geom name="floor" type="plane" size="1 1 0.1"/>
    <body name="base" pos="0 0 0">
      <body name="wrist_link" pos="0 0 0.5">
        <joint name="wrist_joint" type="hinge" axis="0 0 1"/>
        <geom type="box" size="0.05 0.05 0.05"/>
        <site name="attachment_site" pos="0 0.1 0"/>
      </body>
    </body>
  </worldbody>
</mujoco>
`;
  mujoco.FS.writeFile('/working_test/arm_gripper.xml', testSceneArm);
  const modelArm = compileModel(mujoco, '/working_test/arm_gripper.xml');
  const stateArm = new mujoco.State(modelArm);
  const simArm = new mujoco.Simulation(modelArm, stateArm);
  simArm.forward();

  camViewer.onModelChanged(modelArm, simArm);
  check(camViewer.cameras.length === 1, 'exactly 1 onboard camera created (Gripper POV)');
  check(camViewer.cameras[0].id === 'gripper_pov', 'camera id is gripper_pov');
  check(camViewer.cameras[0].name.includes('Gripper POV'), 'camera name is Gripper POV');
  check(camBtn.style.display === '', 'camera button is displayed when Gripper POV exists');
  check(camBtn.textContent.includes('POV'), 'button label shows POV');

  camBtn.click();
  check(camViewer.visible, 'clicking camera button toggles visible');
  check(camBtn.classList.contains('active'), 'camera button gets active class');
  camBtn.click();
  check(!camViewer.visible, 'clicking camera button again hides it');

  console.log('\nCameraViewer render scissor & viewport coordinate calculations');
  camViewer.show();
  check(camViewer.visible, 'camera viewer visible after show()');

  const calls = [];
  const mockRenderer = {
    domElement: {
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
    },
    getPixelRatio: () => 2, // Retina display 2x DPI
    getSize: (v) => v.set(800, 600),
    setScissorTest: (val) => { calls.push(['setScissorTest', val]); },
    setScissor: (x, y, w, h) => { calls.push(['setScissor', x, y, w, h]); },
    setViewport: (x, y, w, h) => { calls.push(['setViewport', x, y, w, h]); },
    clear: (color, depth, stencil) => { calls.push(['clear', color, depth, stencil]); },
    render: (s, c) => { calls.push(['render', s, c]); },
  };

  const reflectorObj = { isReflector: true, visible: true };
  let reflectorWasHiddenDuringRender = false;
  const mockScene = {
    traverse: (fn) => {
      fn(reflectorObj);
    },
  };
  // Hook render to verify reflector is hidden when sub-camera draws
  const origRender = mockRenderer.render;
  mockRenderer.render = (s, c) => {
    if (reflectorObj.visible === false) {
      reflectorWasHiddenDuringRender = true;
    }
    origRender(s, c);
  };

  camViewer.render(mockRenderer, mockScene, simArm, modelArm);

  // Verify scissor test was enabled then disabled
  check(calls.some((c) => c[0] === 'setScissorTest' && c[1] === true), 'scissor test enabled for PiP');
  check(calls[calls.length - 3][0] === 'setScissorTest' && calls[calls.length - 3][1] === false, 'scissor test disabled on restore');

  // Verify coordinates are unscaled CSS coordinates (NOT pre-multiplied by pixelRatio=2)
  const scissorCall = calls.find((c) => c[0] === 'setScissor');
  check(scissorCall !== undefined, 'setScissor was called');
  // mockDom viewportEl width=300, height=200
  eq(scissorCall[3], 300, 'scissor width is CSS logical 300px (not double-scaled to 600px)');
  eq(scissorCall[4], 200, 'scissor height is CSS logical 200px (not double-scaled to 400px)');

  const viewportCall = calls.find((c) => c[0] === 'setViewport');
  eq(viewportCall[3], 300, 'viewport width is CSS logical 300px (not double-scaled to 600px)');
  eq(viewportCall[4], 200, 'viewport height is CSS logical 200px (not double-scaled to 400px)');

  // Verify restore viewport and scissor match original CSS size (800x600, not double-scaled)
  const restoreVpCall = calls[calls.length - 2];
  eq(restoreVpCall, ['setViewport', 0, 0, 800, 600], 'primary viewport restored to 800x600 CSS dimensions');
  const restoreScissorCall = calls[calls.length - 1];
  eq(restoreScissorCall, ['setScissor', 0, 0, 800, 600], 'primary scissor restored to 800x600 CSS dimensions');

  // Verify reflector isolation
  check(reflectorWasHiddenDuringRender, 'reflector was hidden during PiP render to prevent state corruption');
  check(reflectorObj.visible === true, 'reflector visibility was restored after PiP render');
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
} else {
  console.log('\n0 failure(s)');
}
