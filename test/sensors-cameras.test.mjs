// test/sensors-cameras.test.mjs
//
// Tests for camera coordinate transformations, sensor slicing,
// camera and sensor metadata decoding, and readModelStats.

import load_mujoco from '../dist/mujoco_wasm.js';
import { mujocoLogHooks } from '../examples/utils/mujocoLog.js';
import { compileModel, readNames } from '../examples/mujocoUtils.js';
import { readModelStats } from '../examples/utils/sceneWriter.js';
import { SensorMonitor, SENSOR_TYPES } from '../examples/utils/SensorMonitor.js';
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

console.log('\nsensor type metadata completeness');
{
  check(SENSOR_TYPES[0].type === 'touch', 'type 0 is touch');
  check(SENSOR_TYPES[1].type === 'accelerometer' && SENSOR_TYPES[1].unit === 'm/s²', 'type 1 is accelerometer with m/s²');
  check(SENSOR_TYPES[3].type === 'gyro' && SENSOR_TYPES[3].unit === 'rad/s', 'type 3 is gyro with rad/s');
  check(SENSOR_TYPES[4].type === 'force' && SENSOR_TYPES[4].unit === 'N', 'type 4 is force with N');
  check(SENSOR_TYPES[7].type === 'rangefinder' && SENSOR_TYPES[7].unit === 'm', 'type 7 is rangefinder with m');
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

  console.log('\nmodel without sensors (telemetry fallback & toggle buttons)');
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
  const sensorMon = new SensorMonitor(container);
  const camBtn = globalThis.document.createElement('button');
  const sensorBtn = globalThis.document.createElement('button');

  sensorMon.setToggleButton(sensorBtn);
  check(!sensorMon.visible, 'sensor monitor starts hidden');
  check(!sensorBtn.classList.contains('active'), 'sensor button starts inactive');

  sensorBtn.click();
  check(sensorMon.visible, 'clicking button toggles sensor monitor visible');
  check(sensorBtn.classList.contains('active'), 'button gets active class when visible');

  sensorBtn.click();
  check(!sensorMon.visible, 'clicking button again hides sensor monitor');
  check(!sensorBtn.classList.contains('active'), 'button loses active class when hidden');

  // onModelChanged with 0 sensors should populate virtual telemetry sensors
  sensorMon.onModelChanged(modelNoSensors, simNoSensors);
  check(sensorMon.sensors.length === 6, 'virtual sensors created: 2 joint pos + 2 joint vel + 2 actuator ctrl');
  check(sensorBtn.textContent.includes('6'), 'button label updated with sensor count');

  // Verify telemetry sampling
  simNoSensors.qpos[0] = 0.42;
  simNoSensors.qvel[1] = -1.25;
  simNoSensors.ctrl[0] = 3.5;
  sensorMon.sample(simNoSensors, modelNoSensors);

  const snapshot = sensorMon.getSensorSnapshot();
  const snapMap = Object.fromEntries(snapshot.map((s) => [s.name, s.value[0]]));
  check(Math.abs(snapMap['joint1_pos'] - 0.42) < 1e-5, 'joint1_pos sampled correctly');
  check(Math.abs(snapMap['joint2_vel'] - (-1.25)) < 1e-5, 'joint2_vel sampled correctly');
  check(Math.abs(snapMap['motor1_ctrl'] - 3.5) < 1e-5, 'motor1_ctrl sampled correctly');

  // CameraViewer virtual cameras & toggle
  const camViewer = new CameraViewer(container);
  camViewer.setToggleButton(camBtn);
  check(!camViewer.visible, 'camera viewer starts hidden');
  camBtn.click();
  check(camViewer.visible, 'clicking camera button toggles visible');
  check(camBtn.classList.contains('active'), 'camera button gets active class');
  camBtn.click();
  check(!camViewer.visible, 'clicking camera button again hides it');

  camViewer.onModelChanged(modelNoSensors, simNoSensors);
  check(camViewer.cameras.length === 2, 'virtual fallback cameras created when ncam is 0');
  check(camViewer.cameras[0].isVirtual && camViewer.cameras[1].isVirtual, 'both cameras are virtual fallbacks');
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
} else {
  console.log('\n0 failure(s)');
}
