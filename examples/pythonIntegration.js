// pythonIntegration.js
import * as THREE from 'three';
import { getPosition, getQuaternion, readModelNames, readNames } from './mujocoUtils.js';
import { matToQuat } from './utils/mjmath.js';
import { solveIk } from './utils/ik.js';
import { createCodeEditor } from './utils/CodeEditor.js';

export async function initializePythonEnvironment(demo) {
    if (!window.pyodide) return;

    try {
        // Load required packages first
        await window.pyodide.loadPackage(["numpy"]);
        console.log("NumPy loaded successfully");

        // Setup JavaScript bridge functions
        window.getMujocoModel = () => demo.model;
        window.getMujocoSimulation = () => demo.simulation;
        window.getMujocoState = () => demo.state;

        window.setControl = (ctrlArray) => {
            if (!demo.simulation) return;
            // Normalize input: Pyodide passes Python lists as PyProxy (not Array).
            // Accept Array, PyProxy, iterable, or JSON string.
            let ctrl;
            if (Array.isArray(ctrlArray)) {
                ctrl = ctrlArray;
            } else if (typeof ctrlArray === 'string') {
                ctrl = JSON.parse(ctrlArray);
            } else if (ctrlArray && typeof ctrlArray.toJs === 'function') {
                ctrl = ctrlArray.toJs();
            } else {
                ctrl = Array.from(ctrlArray);
            }
            for (let i = 0; i < Math.min(ctrl.length, demo.model.nu); i++) {
                demo.simulation.ctrl[i] = Number(ctrl[i]);
            }
        };

        window.getControl = () => {
            if (!demo.simulation) return [];
            return Array.from(demo.simulation.ctrl);
        };

        window.resetSimulation = () => {
            if (!demo.simulation) return;
            demo.simulation.resetData();
            demo.simulation.forward();
            demo.simClock?.reset(0);
        };

        window.stepSimulation = (n = 1) => {
            if (!demo.simulation) return 0;
            const count = Math.max(1, Math.min(Math.floor(Number(n) || 1), 100000));
            for (let i = 0; i < count; i++) demo.simulation.step();
            // Keep the clock in step with every stepping site, or time silently runs
            // slow — see utils/simClock.js.
            demo.simClock?.advance(count, demo.model?.getOptions?.().timestep ?? 0);
            return count;
        };

        window.getNumActuators = () => {
            if (!demo.model) return 0;
            return demo.model.nu;
        };

        window.getActuatorNames = () => {
            if (!demo.model) return [];
            const names = [];
            const textDecoder = new TextDecoder("utf-8");
            const nullChar = textDecoder.decode(new ArrayBuffer(1));

            for (let i = 0; i < demo.model.nu; i++) {
                const nameAddress = demo.model.name_actuatoradr[i];
                const nameBytes = demo.model.names.subarray(nameAddress);
                const decodedString = textDecoder.decode(nameBytes);
                const name = decodedString.split(nullChar)[0];
                names.push(name || `actuator_${i}`);
            }
            return names;
        };

        window.getActuatorRanges = () => {
            if (!demo.model) return [];
            const ranges = [];
            for (let i = 0; i < demo.model.nu; i++) {
                if (demo.model.actuator_ctrllimited[i]) {
                    const rangeStart = i * 2;
                    ranges.push([
                        demo.model.actuator_ctrlrange[rangeStart],
                        demo.model.actuator_ctrlrange[rangeStart + 1]
                    ]);
                } else {
                    ranges.push([-1, 1]);
                }
            }
            return ranges;
        };

        // Real simulation time, not wall clock. demo.mujoco_time is a render-loop
        // catch-up accumulator resynced to the rAF timestamp, so returning it made
        // get_time() report seconds since page load: it never reset, froze while
        // paused, then jumped by the pause duration, and jumped again on every scene
        // load. See utils/simClock.js.
        window.getSimTime = () => (demo.simClock ? demo.simClock.time : 0);
        window.getSimSteps = () => (demo.simClock ? demo.simClock.steps : 0);
        window.getTimestep = () => (demo.model ? demo.model.getOptions().timestep : 0);
        window.isPaused = () => !!demo.params?.paused;

        window.getQpos = () => {
            if (!demo.simulation) return [];
            return Array.from(demo.simulation.qpos);
        };

        window.getQvel = () => {
            if (!demo.simulation) return [];
            return Array.from(demo.simulation.qvel);
        };

        // Setup Python output to go to the console panel
        const MAX_OUTPUT_LINES = 2000;
        window.pythonOutput = (text) => {
            const outputArea = document.getElementById('python-output');
            if (outputArea) {
                const line = document.createElement('div');
                line.style.whiteSpace = 'pre-wrap';
                line.textContent = text;
                outputArea.appendChild(line);
                // Bounded, because one <div> per line and no limit is a slow tab death
                // once scripts start looping — a control loop printing every frame adds
                // 60 nodes a second. Keep the tail; that is the part being read.
                while (outputArea.childElementCount > MAX_OUTPUT_LINES) {
                    outputArea.removeChild(outputArea.firstElementChild);
                }
                outputArea.scrollTop = outputArea.scrollHeight;
            }
        };

        // Progress and diagnostics from load_robot / load_scene. These went only to
        // devtools, so a user awaiting a 33-73 MB download saw nothing at all in the
        // panel they were looking at.
        window.robospaceLog = (text, level = 'log') => {
            if (level === 'error') console.error(text);
            else if (level === 'warn') console.warn(text);
            else console.log(text);
            if (typeof window.pythonOutput === 'function') window.pythonOutput(text);
        };
        // Add these window functions in initializePythonEnvironment()

        // name_camadr entries are byte offsets, not indices into a split array — see
        // readNames() in mujocoUtils.js. This used to return camera_0, camera_1, ...
        // for every model.
        window.getCameraNames = () => (demo.model
            ? readNames(demo.model, demo.model.name_camadr, demo.model.ncam, 'camera')
            : []);

        /**
         * Everything a script needs to address a model by name, in one crossing.
         *
         * One call rather than fifteen bridge functions: the names all come out of the
         * same packed buffer, so a single decode pass is both faster and the only way
         * the Python side can cache coherently (keyed on `epoch`, which changes
         * whenever a scene loads).
         *
         * The joint table is the part that matters most. Without `qposadr` and the
         * per-type widths, a script cannot map a joint to its slice of `qpos` — which
         * is why the shipped pd_control example indexes qpos by *actuator* number and
         * is silently wrong for any model with a free joint or a gripper.
         */
        window.getModelIndex = () => {
            const m = demo.model;
            if (!m) return null;

            const mj = demo.mujoco;
            const JNT = mj?.mjtJoint;
            const TRN = mj?.mjtTrn;
            // Widths of a joint's qpos / dof slice, by joint type.
            const widths = {
                [JNT?.mjJNT_FREE?.value ?? 0]: { nqpos: 7, ndof: 6, name: 'free' },
                [JNT?.mjJNT_BALL?.value ?? 1]: { nqpos: 4, ndof: 3, name: 'ball' },
                [JNT?.mjJNT_SLIDE?.value ?? 2]: { nqpos: 1, ndof: 1, name: 'slide' },
                [JNT?.mjJNT_HINGE?.value ?? 3]: { nqpos: 1, ndof: 1, name: 'hinge' },
            };

            const jointNames = readNames(m, m.name_jntadr, m.njnt, 'joint');
            const actuatorNames = readNames(m, m.name_actuatoradr, m.nu, 'actuator');

            const jointInfo = [];
            for (let i = 0; i < m.njnt; i++) {
                const type = m.jnt_type[i];
                const w = widths[type] || { nqpos: 1, ndof: 1, name: `type${type}` };
                const limited = !!m.jnt_limited[i];
                jointInfo.push({
                    name: jointNames[i],
                    type,
                    typeName: w.name,
                    limited,
                    // null rather than the meaningless contents of jnt_range: an
                    // unlimited joint has no range, and reporting one is a lie the
                    // caller would then clamp against.
                    range: limited ? [m.jnt_range[2 * i], m.jnt_range[2 * i + 1]] : null,
                    qposadr: m.jnt_qposadr[i],
                    dofadr: m.jnt_dofadr[i],
                    nqpos: w.nqpos,
                    ndof: w.ndof,
                });
            }

            const jointByName = new Map(jointInfo.map((j) => [j.name, j]));
            const actuators = [];
            for (let i = 0; i < m.nu; i++) {
                const isJointTransmission = m.actuator_trntype[i] === (TRN?.mjTRN_JOINT?.value ?? 0);
                const jointId = isJointTransmission ? m.actuator_trnid[2 * i] : -1;
                const jointName = (jointId >= 0 && jointId < jointNames.length) ? jointNames[jointId] : null;
                const ctrlLimited = !!m.actuator_ctrllimited[i];
                actuators.push({
                    name: actuatorNames[i],
                    joint: jointName,
                    ctrlrange: ctrlLimited
                        ? [m.actuator_ctrlrange[2 * i], m.actuator_ctrlrange[2 * i + 1]]
                        : null,
                    qposadr: jointName ? (jointByName.get(jointName)?.qposadr ?? null) : null,
                    dofadr: jointName ? (jointByName.get(jointName)?.dofadr ?? null) : null,
                });
            }

            const sensorInfo = [];
            const sensorNames = readNames(m, m.name_sensoradr, m.nsensor, 'sensor');
            for (let i = 0; i < m.nsensor; i++) {
                sensorInfo.push({
                    name: sensorNames[i],
                    adr: m.sensor_adr[i],
                    dim: m.sensor_dim[i],
                    type: m.sensor_type[i],
                });
            }

            return {
                epoch: demo.modelEpoch || 0,
                nq: m.nq, nv: m.nv, nu: m.nu, nbody: m.nbody, njnt: m.njnt,
                ngeom: m.ngeom, nsite: m.nsite, ncam: m.ncam, nsensor: m.nsensor, nkey: m.nkey,
                timestep: m.getOptions().timestep,
                bodies: readNames(m, m.name_bodyadr, m.nbody, 'body'),
                joints: jointNames,
                sites: readNames(m, m.name_siteadr, m.nsite, 'site'),
                geoms: readNames(m, m.name_geomadr, m.ngeom, 'geom'),
                cameras: readNames(m, m.name_camadr, m.ncam, 'camera'),
                sensors: sensorNames,
                actuators,
                jointInfo,
                sensorInfo,
            };
        };

        /**
         * World pose of a body, site, geom or camera, in RAW MuJoCo coordinates.
         *
         * Deliberately does not use getPosition/getQuaternion from mujocoUtils: those
         * swizzle Z-up into three.js's Y-up for rendering. A script must see the same
         * frame its scene XML is written in, or the two disagree in a way nobody can
         * learn from.
         *
         * Sites report `mat` and a quaternion derived from it, because MuJoCo stores no
         * `site_xquat` at all.
         */
        window.getFramePose = (kind, id) => {
            const m = demo.model;
            const sim = demo.simulation;
            if (!m || !sim) return null;

            const sources = {
                body: { pos: sim.xpos, mat: sim.xmat, quat: sim.xquat, count: m.nbody },
                site: { pos: sim.site_xpos, mat: sim.site_xmat, quat: null, count: m.nsite },
                geom: { pos: sim.geom_xpos, mat: sim.geom_xmat, quat: null, count: m.ngeom },
                camera: { pos: sim.cam_xpos, mat: sim.cam_xmat, quat: null, count: m.ncam },
            };
            const src = Object.prototype.hasOwnProperty.call(sources, kind) ? sources[kind] : null;
            if (!src) return null;
            const i = Number(id);
            if (!Number.isInteger(i) || i < 0 || i >= src.count) return null;

            const mat = Array.from(src.mat.subarray(9 * i, 9 * i + 9));
            const quat = src.quat
                ? Array.from(src.quat.subarray(4 * i, 4 * i + 4))
                : matToQuat(mat);
            return {
                pos: Array.from(src.pos.subarray(3 * i, 3 * i + 3)),
                mat,
                quat,
            };
        };

        /** Centre of mass of a body's subtree; 'world' (body 0) gives the whole model's. */
        window.getSubtreeCom = (bodyId) => {
            const sim = demo.simulation;
            if (!sim || !demo.model) return null;
            const i = Number(bodyId);
            if (!Number.isInteger(i) || i < 0 || i >= demo.model.nbody) return null;
            return Array.from(sim.subtree_com.subarray(3 * i, 3 * i + 3));
        };

        // Normalising numeric input from Python once, rather than in each setter. A
        // Python list arrives as a PyProxy that cannot be indexed directly on this side
        // — the same trap set_control() documents.
        const toNumberArray = (value) => {
            if (value == null) return [];
            if (typeof value === 'string') {
                try { return JSON.parse(value); } catch (_) { return []; }
            }
            if (Array.isArray(value)) return value;
            if (typeof value.toJs === 'function') return Array.from(value.toJs());
            if (typeof value.length === 'number') return Array.from(value);
            return [];
        };

        const writeInto = (target, values, label) => {
            const arr = toNumberArray(values);
            if (arr.length > target.length) {
                throw new Error(`${label}: got ${arr.length} values but this model has ${target.length}.`);
            }
            for (let i = 0; i < arr.length; i++) target[i] = Number(arr[i]);
            return arr.length;
        };

        window.setQpos = (values) => {
            if (!demo.simulation) return 0;
            const n = writeInto(demo.simulation.qpos, values, 'set_qpos');
            demo.simulation.forward();
            return n;
        };

        window.setQvel = (values) => {
            if (!demo.simulation) return 0;
            const n = writeInto(demo.simulation.qvel, values, 'set_qvel');
            demo.simulation.forward();
            return n;
        };

        /** Positions only — about 16x cheaper than a full forward(), which matters when
         *  a solver evaluates kinematics hundreds of times. */
        window.mjKinematics = () => { if (demo.simulation) demo.simulation.kinematics(); };
        window.mjForward = () => { if (demo.simulation) demo.simulation.forward(); };

        /**
         * One crossing per solve. Everything about the algorithm, and why it is here
         * rather than in Python, is in utils/ik.js.
         */
        window.ikSolve = (specJson) => {
            let spec;
            try {
                spec = typeof specJson === 'string' ? JSON.parse(specJson) : specJson;
            } catch (e) {
                throw new Error(`ik: could not read the request (${e.message})`);
            }
            return solveIk(demo, spec);
        };

        /**
         * Resolves at the end of the next rendered frame.
         *
         * yield_control() used to be `await asyncio.sleep(0)`, which hands control to
         * Pyodide's webloop and lands on a setTimeout(0) — clamped to ~4 ms once nested,
         * so a control loop spun at ~250 Hz, competed with requestAnimationFrame for the
         * main thread, and had no guarantee the simulation had advanced at all between
         * iterations. Waiting on the render loop makes one loop iteration mean exactly
         * one simulation frame, which is what a time-parameterised trajectory needs.
         *
         * The timeout is not a nicety: requestAnimationFrame does not fire in a hidden
         * tab, so without it a backgrounded script would wait forever and could not even
         * be stopped.
         */
        window.robospaceNextFrame = (timeoutMs = 50) => new Promise((resolve) => {
            let settled = false;
            const finish = () => { if (!settled) { settled = true; resolve(); } };
            demo._frameWaiters.push(finish);
            setTimeout(finish, timeoutMs);
        });

        /**
         * Steps the simulation while ramping the control targets, and records the motion
         * for playback. This is what makes the whole motion API await-free.
         *
         * The insight is that stepping is far faster than real time: 2 s of simulation at
         * a 2 ms timestep is 1000 steps, which is tens of milliseconds of wall clock. So
         * a motion can just *run*, synchronously, inside one Python call — no coroutine,
         * no yielding, no await. The user's script finishes almost immediately with the
         * physics already correct.
         *
         * The cost of running synchronously is that nothing repaints while it does, so
         * the motion would be invisible. Recording a qpos frame every `recordEvery` steps
         * and letting the render loop replay them gives the animation back.
         *
         * @returns {{steps:number, recorded:number, ms:number}}
         */
        window.robospaceRunMotion = (specJson) => {
            const sim = demo.simulation;
            const model = demo.model;
            if (!sim || !model) throw new Error('No model is loaded.');

            const spec = typeof specJson === 'string' ? JSON.parse(specJson) : specJson;
            const { start = null, goal = null, seconds = 0 } = spec;
            const timestep = model.getOptions().timestep;
            if (!(timestep > 0)) throw new Error(`Cannot step: timestep is ${timestep}.`);

            const steps = Math.max(1, Math.min(Math.round(seconds / timestep), 200000));
            // One recorded frame per rendered frame, so playback runs at wall-clock speed.
            const recordEvery = Math.max(1, Math.round((1 / 60) / timestep));

            const ctrl = sim.ctrl;
            const nu = ctrl.length;
            const from = start ? start.slice(0, nu) : Array.from(ctrl);
            const to = goal ? goal.slice(0, nu) : from;

            const frames = (demo.playback && demo.playback.frames) || [];
            const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

            for (let s = 1; s <= steps; s++) {
                const a = s / steps;
                for (let i = 0; i < nu; i++) ctrl[i] = from[i] + a * (to[i] - from[i]);
                sim.step();
                if (s % recordEvery === 0 || s === steps) frames.push(Float64Array.from(sim.qpos));
                // Bail out rather than finish a long motion the user has cancelled.
                if (s % 500 === 0 && window._pythonShouldStop) break;
            }
            demo.simClock?.advance(steps, timestep);

            // Keep the true dynamic state so it can be restored when playback ends —
            // replaying frames writes qpos only, and stopping mid-frame would otherwise
            // leave the model in a pose the script never actually computed.
            demo.playback = {
                frames,
                index: demo.playback ? demo.playback.index : 0,
                finalState: { qpos: Float64Array.from(sim.qpos), qvel: Float64Array.from(sim.qvel) },
            };

            const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
            return { steps, recorded: frames.length, ms };
        };

        /** Drops any pending playback and shows the current state immediately. */
        window.robospaceSkipPlayback = () => {
            if (!demo.playback) return false;
            const final = demo.playback.finalState;
            demo.playback = null;
            if (final && demo.simulation) {
                demo.simulation.qpos.set(final.qpos);
                demo.simulation.qvel.set(final.qvel);
                demo.simulation.forward();
            }
            return true;
        };

        window.resetKeyframe = (k) => {
            const m = demo.model;
            if (!m || !demo.simulation) return false;
            const i = Number(k);
            if (!Number.isInteger(i) || i < 0 || i >= m.nkey) return false;
            demo.simulation.resetDataKeyframe(i);
            demo.simulation.forward();
            // resetDataKeyframe sets d->time = key_time[k] in C, so mirror that rather
            // than zeroing — the keyframe may represent a moment mid-trajectory.
            demo.simClock?.reset(m.key_time ? m.key_time[i] : 0);
            return true;
        };

        /** Per-sensor values, sliced by sensor_adr/sensor_dim. get_sensor_data()
         *  returns the flat sensordata array, which callers were indexing by sensor
         *  number — wrong for any multi-dimensional sensor (framepos is 3, framequat
         *  is 4, force is 3). */
        window.getSensors = () => {
            const m = demo.model;
            if (!m || !demo.simulation) return [];
            const data = demo.simulation.sensordata;
            const names = readNames(m, m.name_sensoradr, m.nsensor, 'sensor');
            const out = [];
            for (let i = 0; i < m.nsensor; i++) {
                const adr = m.sensor_adr[i];
                const dim = m.sensor_dim[i];
                out.push({
                    name: names[i],
                    adr,
                    dim,
                    value: Array.from(data.subarray(adr, adr + dim)),
                });
            }
            return out;
        };

        window.getNumCameras = () => {
            if (!demo.model) return 0;
            return demo.model.ncam;
        };

        window.getCameraInfo = (cameraId) => {
            if (!demo.model || !demo.simulation) return null;
            if (cameraId >= demo.model.ncam) return null;

            // readNames, not decode(names).split('\0')[byteOffset] — see mujocoUtils.js.
            const camName = readNames(demo.model, demo.model.name_camadr, demo.model.ncam, 'camera')[cameraId];

            // Get camera parameters
            const camBodyId = demo.model.cam_bodyid[cameraId];
            const fovy = demo.model.cam_fovy[cameraId];

            // Get camera position from simulation
            let position = [0, 0, 0];
            if (camBodyId >= 0) {
                const idx = camBodyId * 3;
                position = [
                    demo.simulation.xpos[idx],
                    demo.simulation.xpos[idx + 1],
                    demo.simulation.xpos[idx + 2]
                ];
            }

            // Get camera offset
            const offset = [
                demo.model.cam_pos[cameraId * 3],
                demo.model.cam_pos[cameraId * 3 + 1],
                demo.model.cam_pos[cameraId * 3 + 2]
            ];

            return {
                id: cameraId,
                name: camName,
                bodyId: camBodyId,
                fov: fovy,
                position: position,
                offset: offset
            };
        };

        // Simplified sensor data with proper checks
        window.getSensorData = () => {
            if (!demo.simulation || !demo.simulation.sensordata) return [];
            return Array.from(demo.simulation.sensordata);
        };

        window.getNumSensors = () => {
            if (!demo.model) return 0;
            return demo.model.nsensor;
        };

        // Was indexing the split-name array by a byte offset, so this returned
        // sensor_0, sensor_1, ... for every model that has sensors — which made the
        // sensor path (the only route to Cartesian feedback today) unusable.
        window.getSensorNames = () => (demo.model
            ? readNames(demo.model, demo.model.name_sensoradr, demo.model.nsensor, 'sensor')
            : []);

        // Set up interrupt buffer so Stop button can kill long-running scripts
        _setupInterruptBuffer();

        // Initialize Python environment with helper functions
        await window.pyodide.runPythonAsync(`
import numpy as np
from js import window
from pyodide.ffi import to_js
import json
import math
import sys
import io
import inspect
import asyncio

# Redirect stdout and stderr to the OUTPUT panel.
#
# Buffered by line rather than emitted per write(). print() calls write() once per
# argument plus once for the separator and once for the newline, and each write
# became its own block <div>, so print("a", "b") rendered on three lines. The old
# guard also dropped any write that was exactly a newline, which swallowed bare
# print() entirely.
class OutputRedirector:
    def __init__(self):
        self._buf = ''

    def write(self, text):
        if not text:
            return
        self._buf += text
        while '\\n' in self._buf:
            line, self._buf = self._buf.split('\\n', 1)
            window.pythonOutput(line)

    def flush(self):
        if self._buf:
            window.pythonOutput(self._buf)
            self._buf = ''

sys.stdout = OutputRedirector()
sys.stderr = OutputRedirector()

_last_heartbeat = 0.0

async def yield_control():
    """Wait for the next rendered frame. Required inside any long-running loop.

        while get_time() < 5:
            set_control(compute_control())
            await yield_control()

    One iteration of a loop containing this is one simulation frame, so time-based
    trajectories behave the same at 60 fps and at 20.

    This is also the only place a Stop is noticed. A loop without it freezes the tab
    unrecoverably -- Pyodide runs on the main thread and SharedArrayBuffer is
    unavailable here, so there is no way to interrupt from outside.
    """
    global _last_heartbeat
    # Checked on both sides of the await: while frames are not arriving (a hidden tab)
    # the wait falls back to a timer, and Stop must still land.
    if window._pythonShouldStop:
        raise KeyboardInterrupt("Stopped by user")
    await window.robospaceNextFrame()
    if window._pythonShouldStop:
        raise KeyboardInterrupt("Stopped by user")
    # A long correct run and a hung one look identical from the outside; say something
    # occasionally so they do not.
    now = window.performance.now() / 1000.0
    if _last_heartbeat == 0.0:
        _last_heartbeat = now
    elif now - _last_heartbeat > 10.0:
        _last_heartbeat = now
        print(f"  ... still running, sim time {get_time():.1f}s (Stop or Esc to end)")

def clamp_control(ctrl):
    """Clip each value to its actuator's control range.

    Unlimited actuators are left alone rather than being clipped to a made-up range --
    get_actuator_ranges() reports (-1, 1) for those, which is not real.
    """
    acts = _index()['actuators']
    out = []
    for i, v in enumerate(ctrl):
        rng = acts[i]['ctrlrange'] if i < len(acts) else None
        out.append(max(rng[0], min(rng[1], v)) if rng else v)
    return out

def set_actuator(actuator, value):
    """Set one actuator by name or index, leaving every other target unchanged."""
    names = [a['name'] for a in _index()['actuators']]
    if isinstance(actuator, int) and not isinstance(actuator, bool):
        idx = actuator
        if not (0 <= idx < len(names)):
            raise ValueError(f'actuator index {idx} is out of range (0..{len(names) - 1}).')
    elif actuator in names:
        idx = names.index(actuator)
    else:
        raise ValueError(f'no actuator named {actuator!r}. Available: ' + ', '.join(names))
    ctrl = list(get_control())
    ctrl[idx] = float(value)
    set_control(ctrl)

async def control_loop(fn, duration=None, hz=None):
    """Call fn(t) every frame, where t is seconds since the loop started.

        async def policy(t):
            set_control(clamp_control([0.3 * math.sin(2 * t)] * get_num_actuators()))

        await control_loop(policy, duration=10)

    fn may be a plain function or a coroutine. Pass hz to call it at a fixed rate
    instead of every frame; the loop still yields each frame either way, so the
    simulation keeps running smoothly between calls.
    """
    t0 = get_time()
    interval = None if not hz else 1.0 / hz
    last_call = None
    stalled_since = None
    warned = False
    while True:
        t = get_time() - t0
        if duration is not None and t >= duration:
            return
        if interval is None or last_call is None or (t - last_call) >= interval:
            result = fn(t)
            if inspect.isawaitable(result):
                await result
            last_call = t
        # duration is measured in SIMULATION time, which does not advance while paused,
        # so say so rather than appearing to hang. Switching to wall clock instead would
        # make the trajectory depend on frame rate, which is worse.
        wall = window.performance.now() / 1000.0
        if stalled_since is None or t > 0:
            stalled_since = wall
        if not warned and is_paused() and wall - stalled_since > 1.0:
            warned = True
            print('  simulation is paused -- press Space or the play button to resume')
        await yield_control()

# Helper functions to interact with MuJoCo
def get_num_actuators():
    """Get number of actuators"""
    return window.getNumActuators()

def get_actuator_names():
    """Get list of actuator names"""
    return window.getActuatorNames().to_py()

def get_actuator_ranges():
    """Get actuator control ranges"""
    ranges = window.getActuatorRanges().to_py()
    return [(r[0], r[1]) for r in ranges]

def set_control(ctrl):
    """Set control values for all actuators"""
    if isinstance(ctrl, np.ndarray):
        ctrl = ctrl.tolist()
    # Explicitly convert to a JS Array — Pyodide 0.23 otherwise wraps
    # Python lists as PyProxy, which the JS bridge can't index directly.
    window.setControl(to_js(ctrl))

def get_control():
    """Get current control values"""
    return window.getControl().to_py()

def reset():
    """Reset the simulation to its initial state and zero the clock."""
    window.resetSimulation()

def step(n=1):
    """Step the simulation forward n times. Returns the number of steps taken.

    Note this steps *in addition to* the render loop, which is already stepping to
    keep up with wall clock. For timed control, prefer awaiting yield_control() in a
    loop and reading get_time().
    """
    return window.stepSimulation(n)

def get_time():
    """Simulation time in seconds.

    This is real simulation time -- steps x timestep -- and it resets with reset()
    and with each scene load. It does not advance while the simulation is paused.
    """
    return window.getSimTime()

def get_steps():
    """Number of physics steps taken since the last reset or scene load."""
    return window.getSimSteps()

def dt():
    """The model's integration timestep, in seconds."""
    return window.getTimestep()

def is_paused():
    """True when the simulation is paused (press Space, or the pause button).

    Worth checking in a timed loop: get_time() does not advance while paused, so a
    loop conditioned on elapsed simulation time never finishes.

    NOTE TO EDITORS: no backticks anywhere in this string. Everything from the
    triple-quote after runPythonAsync( down to the closing one lives inside a JS
    template literal, so one raw backtick ends the literal and the whole module
    becomes a syntax error -- with a stack trace pointing at an unrelated function.
    """
    return bool(window.isPaused())

def get_qpos():
    """Get joint positions"""
    return np.array(window.getQpos().to_py())

def get_qvel():
    """Get joint velocities"""
    return np.array(window.getQvel().to_py())

def print_info():
    """Print system information"""
    n = get_num_actuators()
    names = get_actuator_names()
    ranges = get_actuator_ranges()
    
    print(f"\\nSystem Information:")
    print(f"  Number of actuators: {n}")
    print(f"\\nActuators:")
    for i in range(n):
        name = names[i] if i < len(names) else f"actuator_{i}"
        r = ranges[i] if i < len(ranges) else (-1, 1)
        print(f"  [{i:2d}] {name:20s} | Range: [{r[0]:6.2f}, {r[1]:6.2f}]")

# Camera functions
# ─── model introspection ────────────────────────────────────────────────────
# Cached on the model epoch, which changes on every scene load. Without a cache each
# lookup would re-decode the whole name buffer and cross the JS boundary again.

_model_index = None

def model_info(refresh=False):
    """The whole model index as a dict: names, joint table, actuator table, sensors.

    Keys: nq nv nu nbody njnt ngeom nsite ncam nsensor nkey timestep,
    bodies joints sites geoms cameras sensors (lists of names),
    actuators (name, joint, ctrlrange, qposadr, dofadr),
    jointInfo (name, type, typeName, limited, range, qposadr, dofadr, nqpos, ndof),
    sensorInfo (name, adr, dim, type).

    Use the named helpers below in preference; this is the escape hatch.
    """
    global _model_index
    raw = window.getModelIndex()
    if raw is None:
        return None
    index = raw.to_py()
    if refresh or _model_index is None or _model_index.get('epoch') != index.get('epoch'):
        _model_index = index
    return _model_index

def _index():
    info = model_info()
    if info is None:
        raise RuntimeError('No model is loaded yet.')
    return info

def _lookup(kind, key, entries, names):
    """Resolve a name or an integer index, or raise listing what does exist.

    The listing is the point: 'no site named "gripper". Available: attachment_site'
    replaces most of what a user currently learns by trial and error.
    """
    if isinstance(key, int) and not isinstance(key, bool):
        if 0 <= key < len(entries):
            return entries[key]
        raise ValueError(f'{kind} index {key} is out of range (0..{len(entries) - 1}).')
    for entry, name in zip(entries, names):
        if name == key:
            return entry
    listing = ', '.join(names) if names else '(none)'
    raise ValueError(f'no {kind} named {key!r}. Available: {listing}')

def actuator_names():
    """Names of the actuators, in ctrl order."""
    return [a['name'] for a in _index()['actuators']]

def joint_names():
    """Names of the joints, in model order."""
    return list(_index()['joints'])

def body_names():
    """Names of the bodies. Index 0 is always 'world'."""
    return list(_index()['bodies'])

def site_names():
    """Names of the sites. Sites are the usual way to mark a tool tip or a grasp point."""
    return list(_index()['sites'])

def geom_names():
    """Names of the geoms."""
    return list(_index()['geoms'])

def joint_info(joint):
    """Everything about one joint: type, limits, and where it lives in qpos/qvel."""
    info = _index()
    return _lookup('joint', joint, info['jointInfo'], info['joints'])

def joint_limits(joint):
    """(low, high) for a limited joint, or None when it is unlimited."""
    rng = joint_info(joint)['range']
    return tuple(rng) if rng else None

def joint_qpos_index(joint):
    """Index of this joint's first value in get_qpos().

    A free joint occupies 7 slots and a ball joint 4, so joint number and qpos index
    are not the same thing on any model with a floating base.
    """
    return joint_info(joint)['qposadr']

def actuator_info(actuator):
    """Name, driven joint, control range and qpos/dof addresses for one actuator."""
    info = _index()
    return _lookup('actuator', actuator, info['actuators'], [a['name'] for a in info['actuators']])

def actuator_joint(actuator):
    """Name of the joint this actuator drives, or None if it drives something else
    (a tendon, a site, ...)."""
    return actuator_info(actuator)['joint']

def actuator_range(actuator):
    """(low, high) control range, or None when the actuator is unlimited.

    Differs from get_actuator_ranges(), which fabricates (-1, 1) for unlimited
    actuators; that value is not real and should not be clamped against.
    """
    rng = actuator_info(actuator)['ctrlrange']
    return tuple(rng) if rng else None

def actuator_qpos_index(actuator):
    """Index in get_qpos() of the joint this actuator drives, or None.

    This is the correct way to pair an actuator with its measured position. Indexing
    qpos by actuator number happens to work on a 6-joint arm and is wrong the moment
    the model has a floating base or a gripper.
    """
    return actuator_info(actuator)['qposadr']

def sensors():
    """All sensors as {name: value}, each already sliced to its own width."""
    out = {}
    for s in window.getSensors().to_py():
        value = s['value']
        out[s['name']] = value[0] if s['dim'] == 1 else np.array(value)
    return out

def sensor(name):
    """One sensor's value: a float when it is scalar, else a numpy array.

    Sliced by sensor_adr/sensor_dim, so a framepos (3 values) or framequat (4) comes
    back whole rather than as a single misaligned number.
    """
    found = sensors()
    if name not in found:
        listing = ', '.join(found.keys()) if found else '(none)'
        raise ValueError(f'no sensor named {name!r}. Available: {listing}')
    return found[name]

def print_model():
    """Print the model: actuators with their joints and limits, then joints and sites."""
    info = _index()
    print("")
    print(f"nq={info['nq']} nv={info['nv']} nu={info['nu']} nbody={info['nbody']} "
          f"njnt={info['njnt']} nsite={info['nsite']} nsensor={info['nsensor']} "
          f"timestep={info['timestep']}")
    print("")
    print("actuators (index: name -> joint, ctrl range):")
    for i, a in enumerate(info['actuators']):
        rng = f"[{a['ctrlrange'][0]:.4g}, {a['ctrlrange'][1]:.4g}]" if a['ctrlrange'] else 'unlimited'
        print(f"  {i}: {a['name']} -> {a['joint'] or '(not a joint)'}, {rng}")
    print("")
    print("joints (qpos index: name, type, range):")
    for j in info['jointInfo']:
        rng = f"[{j['range'][0]:.4g}, {j['range'][1]:.4g}]" if j['range'] else 'unlimited'
        print(f"  {j['qposadr']}: {j['name']}, {j['typeName']}, {rng}")
    if info['sites']:
        print("")
        print("sites: " + ', '.join(info['sites']))
    if info['sensors']:
        print("")
        print("sensors: " + ', '.join(f"{s['name']}(dim {s['dim']})" for s in info['sensorInfo']))

# ─── task space ─────────────────────────────────────────────────────────────
# Everything here is in RAW MuJoCo coordinates: Z-up, metres, the same frame the scene
# XML is written in. The renderer swizzles to Y-up internally; that never leaks here.

def frame(kind, name):
    """World pose of a body, site, geom or camera.

    Returns {'pos': [x, y, z], 'quat': [w, x, y, z], 'mat': [9 row-major]}.
    'kind' is 'body', 'site', 'geom' or 'camera'; 'name' may be a name or an index.
    """
    info = _index()
    listing = {'body': info['bodies'], 'site': info['sites'],
               'geom': info['geoms'], 'camera': info['cameras']}
    if kind not in listing:
        raise ValueError(f"kind must be 'body', 'site', 'geom' or 'camera', not {kind!r}")
    names = listing[kind]
    if isinstance(name, int) and not isinstance(name, bool):
        idx = name
        if not (0 <= idx < len(names)):
            raise ValueError(f'{kind} index {idx} is out of range (0..{len(names) - 1}).')
    else:
        if name not in names:
            available = ', '.join(names) if names else '(none)'
            raise ValueError(f'no {kind} named {name!r}. Available: {available}')
        idx = names.index(name)
    pose = window.getFramePose(kind, idx)
    if pose is None:
        raise RuntimeError(f'could not read the pose of {kind} {name!r}.')
    out = pose.to_py()
    return {'pos': np.array(out['pos']), 'quat': np.array(out['quat']), 'mat': np.array(out['mat'])}

def site_pos(site):
    """World position of a site. Sites are how a scene marks a tool tip or grasp point."""
    return frame('site', site)['pos']

def site_quat(site):
    """World orientation of a site as [w, x, y, z].

    Derived from site_xmat, because MuJoCo stores no site_xquat.
    """
    return frame('site', site)['quat']

def site_mat(site):
    """World orientation of a site as a 3x3 row-major matrix (9 values)."""
    return frame('site', site)['mat']

def body_pos(body):
    """World position of a body's frame origin."""
    return frame('body', body)['pos']

def body_quat(body):
    """World orientation of a body as [w, x, y, z]."""
    return frame('body', body)['quat']

def geom_pos(geom):
    """World position of a geom."""
    return frame('geom', geom)['pos']

def com(body='world'):
    """Centre of mass of a body's subtree. Defaults to the whole model."""
    names = _index()['bodies']
    idx = body if isinstance(body, int) and not isinstance(body, bool) else (
        names.index(body) if body in names else None)
    if idx is None:
        raise ValueError(f'no body named {body!r}. Available: ' + ', '.join(names))
    value = window.getSubtreeCom(idx)
    if value is None:
        raise RuntimeError('could not read the centre of mass.')
    return np.array(value.to_py())

def axis(kind, name, which=2):
    """One axis of a frame, in world coordinates. which: 0=x, 1=y, 2=z.

    axis('site', 'attachment_site', 2) is the direction the tool points.
    """
    m = frame(kind, name)['mat']
    return np.array([m[which], m[3 + which], m[6 + which]])

# ─── writing state ──────────────────────────────────────────────────────────
# These teleport the model. They are for setting up and for analysis; control goes
# through set_control(), which the physics actually follows.

def set_qpos(q):
    """Write joint positions and recompute derived quantities. Teleports the model."""
    if isinstance(q, np.ndarray):
        q = q.tolist()
    return window.setQpos(to_js(list(q)))

def set_qvel(v):
    """Write joint velocities and recompute derived quantities."""
    if isinstance(v, np.ndarray):
        v = v.tolist()
    return window.setQvel(to_js(list(v)))

def get_joint(joint):
    """This joint's slice of qpos: a float for a hinge or slide, an array otherwise."""
    j = joint_info(joint)
    q = get_qpos()
    values = q[j['qposadr']:j['qposadr'] + j['nqpos']]
    return float(values[0]) if j['nqpos'] == 1 else values

def set_joint(joint, value):
    """Write one joint's position, leaving every other joint alone. Teleports it."""
    j = joint_info(joint)
    q = get_qpos()
    values = [value] if np.isscalar(value) else list(value)
    if len(values) != j['nqpos']:
        raise ValueError(f"joint {j['name']!r} is a {j['typeName']} joint and needs "
                         f"{j['nqpos']} value(s), got {len(values)}.")
    for k, v in enumerate(values):
        q[j['qposadr'] + k] = v
    return set_qpos(q)

def forward():
    """Run the full forward dynamics without integrating. Updates poses and sensors."""
    window.mjForward()

def kinematics():
    """Update body/site/geom poses only. Much cheaper than forward(); use it when
    probing poses for many candidate configurations."""
    window.mjKinematics()

def reset_keyframe(k=0):
    """Reset to keyframe k, including its recorded time.

    Note registry robots have their <keyframe> stripped at load time (it aborts
    mj_makeData once a scene adds any joint), so this applies to keyframes your own
    scene declares.
    """
    if not window.resetKeyframe(k):
        raise ValueError(f'no keyframe {k} in this model (nkey={_index()["nkey"]}).')

# ─── orientation helpers ────────────────────────────────────────────────────
# Quaternions are [w, x, y, z], MuJoCo's order.

def quat_mul(a, b):
    """Hamilton product. quat_mul(a, b) applies b first, then a."""
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return np.array([
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ])

def quat_conj(q):
    """Conjugate, i.e. the inverse rotation for a unit quaternion."""
    return np.array([q[0], -q[1], -q[2], -q[3]])

def quat_from_axis_angle(ax, angle):
    """Quaternion for a rotation of 'angle' radians about 'ax'. 'ax' need not be unit."""
    a = np.array(ax, dtype=float)
    n = np.linalg.norm(a)
    if n == 0:
        return np.array([1.0, 0.0, 0.0, 0.0])
    s = math.sin(angle / 2) / n
    return np.array([math.cos(angle / 2), a[0] * s, a[1] * s, a[2] * s])

def quat_angle(a, b):
    """Smallest angle in radians between two orientations."""
    d = quat_mul(b, quat_conj(a))
    w = min(1.0, abs(float(d[0])))
    return 2 * math.acos(w)

def tool_down(yaw=0.0):
    """Orientation whose z-axis points straight down, rotated by yaw about world Z.

    This is what almost every top-down pick wants. For an axis-aligned box, yaw=0
    closes a Panda's fingers along world Y.
    """
    return quat_mul(quat_from_axis_angle([0, 0, 1], yaw), np.array([0.0, 0.0, 1.0, 0.0]))

# ─── inverse kinematics ─────────────────────────────────────────────────────

def ik_solve(target, pos=None, quat=None, joints=None, seed=None,
             pos_weight=1.0, rot_weight=0.5, restarts=16, max_iters=60,
             max_ms=50.0, pos_tol=1e-4, rot_tol=1e-3, respect_limits=True):
    """Find joint values that put a frame at a pose. Does not move the robot.

        r = ik_solve('attachment_site', pos=[0.5, 0, 0.2], quat=tool_down())
        print(r['success'], r['pos_err'], r['ms'])

    'target' is a site name, or 'body:name' / 'geom:name' to aim at one of those
    instead. Give 'pos', 'quat', or both -- omitting one leaves that axis free, so
    "reach this point, any orientation" is a natural 3-DoF request rather than a hack.

    Returns a dict: success, reason, qpos (the full vector), joints ({name: value}),
    pos_err, rot_err, iters, seeds_tried, ms.

    Solves against the joints an actuator can actually drive, so the answer is always
    commandable. Synchronous and side-effect free: qpos and qvel are restored before it
    returns, so nothing you are looking at moves.
    """
    kind = 'site'
    name = target
    if isinstance(target, str) and ':' in target:
        kind, name = target.split(':', 1)

    info = _index()
    listing = {'site': info['sites'], 'body': info['bodies'], 'geom': info['geoms']}
    if kind not in listing:
        raise ValueError(f"target must be a site, or 'body:name' / 'geom:name', not {kind!r}")
    names = listing[kind]
    if isinstance(name, int) and not isinstance(name, bool):
        idx = name
    elif name in names:
        idx = names.index(name)
    else:
        available = ', '.join(names) if names else '(none)'
        raise ValueError(f'no {kind} named {name!r}. Available: {available}')

    joint_indices = None
    if joints is not None:
        joint_indices = []
        for j in joints:
            if isinstance(j, int) and not isinstance(j, bool):
                joint_indices.append(j)
            elif j in info['joints']:
                joint_indices.append(info['joints'].index(j))
            else:
                raise ValueError(f'no joint named {j!r}. Available: ' + ', '.join(info['joints']))

    spec = {
        'kind': kind, 'index': int(idx),
        'pos': None if pos is None else [float(v) for v in pos],
        'quat': None if quat is None else [float(v) for v in quat],
        'joints': joint_indices,
        'seed': None if seed is None else [float(v) for v in seed],
        'posWeight': float(pos_weight), 'rotWeight': float(rot_weight),
        'restarts': int(restarts), 'maxIters': int(max_iters), 'maxMs': float(max_ms),
        'posTol': float(pos_tol), 'rotTol': float(rot_tol),
        'respectLimits': bool(respect_limits),
    }
    # Passed as JSON so no PyProxy crosses the boundary; the solver reads plain numbers.
    raw = window.ikSolve(json.dumps(spec)).to_py()

    joint_names_all = info['joints']
    named = {joint_names_all[int(k)]: v for k, v in raw['jointValues'].items()}
    if raw['reason'] == 'stopped':
        raise KeyboardInterrupt('Stopped by user')
    return {
        'success': raw['success'], 'reason': raw['reason'],
        'qpos': np.array(raw['qpos']), 'joints': named,
        'pos_err': raw['posErr'], 'rot_err': raw['rotErr'],
        'iters': raw['iters'], 'seeds_tried': raw['seedsTried'], 'ms': raw['ms'],
    }

# ─── motion: synchronous, no await ──────────────────────────────────────────
#
# These run the physics to completion and return. No 'await', no coroutines.
#
# It works because stepping is far faster than real time -- 2 s of simulation is ~1000
# steps, which is tens of milliseconds of wall clock -- so a motion can simply run inside
# the call. Nothing repaints while it does, so each motion records itself and the render
# loop replays the recording at normal speed. You get correct physics immediately and
# still watch the robot move.
#
# If you would rather not wait for the replay, call skip_playback().

def run(seconds=1.0):
    """Let the simulation run for 'seconds', holding the current control targets.

        set_control([0.5] * get_num_actuators())
        run(2)
    """
    return window.robospaceRunMotion(json.dumps({'seconds': float(seconds)})).to_py()

# Older name for the same thing; 'wait' reads better in a sequence of motions.
wait = run

def skip_playback():
    """Jump straight to the current state instead of watching the recorded motion."""
    return bool(window.robospaceSkipPlayback())

def move_joints(mapping, seconds=1.0):
    """Move the actuators driving these joints to the given values.

        move_joints({'joint1': 0.5, 'joint2': -0.3}, seconds=1.5)

    Ramping over 'seconds' rather than jumping matters: these are stiff position
    actuators, and a step change snaps hard enough to fling whatever the robot was
    about to pick up.
    """
    info = _index()
    targets = {}
    missing = []
    for joint, value in mapping.items():
        found = None
        for i, a in enumerate(info['actuators']):
            if a['joint'] == joint:
                found = i
                break
        if found is None:
            missing.append(str(joint))
        else:
            targets[found] = float(value)
    if missing:
        raise ValueError('no position actuator drives ' + ', '.join(missing)
                         + '. Those joints cannot be commanded directly.')

    start = list(get_control())
    goal = list(start)
    for i, value in targets.items():
        goal[i] = value
    return window.robospaceRunMotion(json.dumps({
        'start': start, 'goal': goal, 'seconds': float(seconds),
    })).to_py()

def move_to(target, pos=None, quat=None, seconds=2.0, **ik_kwargs):
    """Move a frame to a pose, solving the joint angles for you. This is the one you want.

        move_to('body:hand', pos=[0.5, 0, 0.3], quat=tool_down())

    'target' is a site name, or 'body:name' / 'geom:name'. Give pos, quat, or both --
    omitting one leaves that free, so "reach this point, any orientation" is natural.

    Raises if the pose cannot be reached, rather than moving somewhere approximate: a
    silent near-miss makes the next step fail for a reason that looks like physics.
    """
    result = ik_solve(target, pos=pos, quat=quat, **ik_kwargs)
    if not result['success']:
        raise ValueError(
            f"could not reach that pose ({result['reason']}): position error "
            f"{result['pos_err'] * 1000:.1f} mm, orientation error {result['rot_err']:.3f} rad "
            f"after {result['seeds_tried']} attempt(s). Try a nearer target, or relax the "
            f"orientation by passing quat=None."
        )
    move_joints(result['joints'], seconds=seconds)
    return result

def set_gripper(opening, seconds=0.8):
    """Open or close the gripper. 1.0 is fully open, 0.0 fully closed.

        set_gripper(1.0)     # open
        set_gripper(0.0)     # close on the object

    Finds the gripper actuator by looking for one that drives no single joint (a
    parallel gripper is usually tendon-driven), and maps 0..1 onto its control range.
    Raise with the actuator list if it cannot tell which one it is.
    """
    acts = _index()['actuators']
    candidates = [i for i, a in enumerate(acts) if a['joint'] is None]
    if len(candidates) != 1:
        names = ', '.join(a['name'] for a in acts)
        raise ValueError(
            'could not identify a gripper actuator automatically'
            + (f' ({len(candidates)} candidates)' if candidates else '')
            + '. Drive it yourself with set_actuator(name, value) and run(seconds). '
            + 'Actuators: ' + names)
    idx = candidates[0]
    rng = acts[idx]['ctrlrange'] or (0.0, 1.0)
    value = rng[0] + max(0.0, min(1.0, float(opening))) * (rng[1] - rng[0])
    start = list(get_control())
    goal = list(start)
    goal[idx] = value
    return window.robospaceRunMotion(json.dumps({
        'start': start, 'goal': goal, 'seconds': float(seconds),
    })).to_py()

def open_gripper(seconds=0.5):
    """Open the gripper fully."""
    return set_gripper(1.0, seconds)

def close_gripper(seconds=0.8):
    """Close the gripper fully."""
    return set_gripper(0.0, seconds)

def help_api():
    """List every helper, generated from what is actually defined.

    Printed rather than hand-maintained because the old startup banner listed 9 of
    ~30 functions, omitted load_robot and load_scene entirely, and was wiped from the
    panel by the first Run and never came back.
    """
    groups = [
        ('model', ['print_model', 'model_info', 'actuator_names', 'joint_names',
                   'body_names', 'site_names', 'geom_names']),
        ('lookups', ['joint_info', 'joint_limits', 'joint_qpos_index', 'actuator_info',
                     'actuator_joint', 'actuator_range', 'actuator_qpos_index']),
        ('task space', ['frame', 'site_pos', 'site_quat', 'body_pos', 'body_quat',
                        'geom_pos', 'com', 'axis']),
        ('orientation', ['tool_down', 'quat_mul', 'quat_conj', 'quat_from_axis_angle',
                         'quat_angle']),
        ('move (no await needed)', ['move_to', 'move_joints', 'open_gripper', 'close_gripper',
                                    'set_gripper', 'run', 'wait', 'skip_playback', 'ik_solve']),
        ('live control (advanced, needs await)', ['control_loop', 'yield_control']),
        ('control', ['set_control', 'get_control', 'get_actuator_ranges']),
        ('state', ['get_qpos', 'get_qvel', 'set_qpos', 'set_qvel', 'get_joint',
                   'set_joint', 'reset', 'reset_keyframe', 'step', 'forward', 'kinematics']),
        ('time', ['get_time', 'get_steps', 'dt', 'is_paused']),
        ('scenes (these DO need await)', ['list_robots', 'load_robot', 'load_scene']),
        ('sensors', ['sensor', 'sensors', 'get_sensor_data', 'print_sensors']),
        ('cameras', ['get_camera_names', 'get_camera_info', 'print_cameras']),
    ]
    g = globals()
    print("")
    for title, names in groups:
        available = [n for n in names if n in g and callable(g[n])]
        if not available:
            continue
        print(f"{title}:")
        for name in available:
            doc = (g[name].__doc__ or '').strip().split('\\n')[0]
            marker = 'await ' if asyncio.iscoroutinefunction(g[name]) else ''
            print(f"  {marker}{name}()".ljust(34) + doc)
    print("")
    print("np, math and json are imported. window is the browser's window object.")

def get_num_cameras():
    """Get number of cameras in the model"""
    return window.getNumCameras()

def get_camera_names():
    """Get list of camera names"""
    return window.getCameraNames().to_py()

# Sensor functions
def get_sensor_data():
    """Get all sensor readings"""
    return window.getSensorData().to_py()

def get_num_sensors():
    """Get number of sensors"""
    return window.getNumSensors()

def get_sensor_names():
    """Get sensor names"""
    return window.getSensorNames().to_py()

def print_sensors():
    """Print all available sensors"""
    n_sensors = get_num_sensors()
    n_cameras = get_num_cameras()
    
    print(f"\\nSensors: {n_sensors}")
    if n_sensors > 0:
        names = get_sensor_names()
        data = get_sensor_data()
        for i in range(min(n_sensors, len(names))):
            value = data[i] if i < len(data) else 0
            print(f"  [{i}] {names[i]:20s} = {value:.4f}")
    
    print(f"\\nCameras: {n_cameras}")
    if n_cameras > 0:
        cam_names = get_camera_names()
        for i, name in enumerate(cam_names):
            print(f"  [{i}] {name}")

def camera_status():
    """Check camera status and availability"""
    n_cams = get_num_cameras()
    if n_cams > 0:
        print(f"✓ {n_cams} camera(s) available")
        names = get_camera_names()
        for i, name in enumerate(names):
            print(f"  [{i}] {name}")
        print("\\nCamera viewer is visible in top-left corner")
    else:
        print("✗ No cameras in this model")
        print("  Camera viewer is hidden")
    return n_cams

def get_camera_info(camera_id=0):
    """Get camera information"""
    info = window.getCameraInfo(camera_id)
    if info:
        return info.to_py()
    return None

def list_robots():
    """Names accepted by load_robot()."""
    return list(window.robospaceListRobots())

async def load_robot(name='franka_panda'):
    """Download a robot from MuJoCo Menagerie and stand it on a floor.

    Must be awaited:

        await load_robot('stretch_3')
        print(get_actuator_names())
        set_control([0.3, 0.3, 0.6, 0.1, 0, 0, 0, 0, 0, 0])   # drive the wheels

    The first call for a robot downloads its meshes (Panda about 33 MB,
    Stretch 3 about 73 MB) and caches them in the browser, so later calls are
    instant. The scene is stepped until it comes to rest before rendering, so the
    robot appears settled rather than dropping into place.

    See list_robots() for the available names.
    """
    result = await window.robospaceLoadRobot(name)
    if result is None:
        return None
    stats = result.modelStats
    print(f"Loaded {name}: nq={stats.nq} nv={stats.nv} nu={stats.nu} nbody={stats.nbody} ngeom={stats.ngeom}")
    print("Actuators: " + ", ".join(list(stats.actuatorNames)))
    return result

async def load_scene(xml, robot=None, name='python_scene'):
    """Compile and load a scene you author yourself. Must be awaited.

        SCENE = '''<mujoco model="pick">
          <include file="panda.xml"/>
          <worldbody>
            <geom name="floor" size="0 0 0.05" type="plane"/>
            <body name="cube" pos="0.5 0 0.025">
              <freejoint/>
              <geom type="box" size="0.025 0.025 0.025" density="300"/>
            </body>
          </worldbody>
        </mujoco>'''

        await load_scene(SCENE, robot='franka_panda', name='pick')

    The 'robot' argument names a registry pack (see list_robots()); its meshes
    are fetched and written beside your scene, so <include file="..."> resolves.
    The entry file to include is "panda.xml" for franka_panda and "stretch.xml"
    for stretch_3.

    Three rules the loader cannot fix for you:
      * <include> must be the FIRST element inside <mujoco>, or the robot's home
        pose lands on the wrong joints.
      * Emit exactly one horizontal ground plane; the renderer draws every plane
        as a fixed 100x100 mirror and ignores its size and rotation.
      * Image-file textures do not work in this build. Use builtin="checker",
        "flat" or "gradient".

    Raises on a compile error, with MuJoCo's diagnostic when it gave one.
    """
    result = await window.robospaceLoadScene(xml, robot or '', name)
    if result is None:
        return None
    stats = result.modelStats
    print(f"Loaded '{name}': nq={stats.nq} nv={stats.nv} nu={stats.nu} nbody={stats.nbody} ngeom={stats.ngeom}")
    print("Actuators: " + ", ".join(list(stats.actuatorNames)))
    return result

def print_cameras():
    """Print all camera information"""
    n_cams = get_num_cameras()
    print(f"\\nCameras: {n_cams}")
    
    if n_cams > 0:
        cam_names = get_camera_names()
        for i in range(n_cams):
            info = get_camera_info(i)
            if info:
                print(f"  [{i}] {info['name']:20s}")
                print(f"      Body ID: {info['bodyId']}")
                print(f"      FOV: {info['fov']:.1f}°")
                print(f"      Position: {info['position']}")
                print(f"      Offset: {info['offset']}")

def get_sensor_data():
    """Get all sensor readings"""
    data = window.getSensorData()
    if data:
        return data.to_py()
    return []

def print_sensors():
    """Print all available sensors"""
    n_sensors = get_num_sensors()
    print(f"\\nSensors: {n_sensors}")
    
    if n_sensors > 0:
        names = get_sensor_names()
        data = get_sensor_data()
        for i in range(min(n_sensors, len(names))):
            value = data[i] if i < len(data) else 0
            print(f"  [{i}] {names[i]:20s} = {value:.4f}")
    
    print_cameras()

print("RoboSpace")
print("Getting started:")
print("  await load_robot('franka_panda')      # only loading needs 'await'")
print("  print_model()                         # what is loaded, and its names")
print("  move_to('body:hand', pos=[.5,0,.3], quat=tool_down())")
print("  open_gripper();  close_gripper();  run(1)")
print("")
print("Motion is synchronous -- no 'await'. help_api() lists everything.")
print("Try the Examples menu for runnable scripts.")`);

        console.log("Python environment initialized");

    } catch (error) {
        console.error('Error initializing Python environment:', error);
    }
}

/**
 * Announces a new model to the output panel after a scene reload.
 *
 * Deliberately contains no Python. It used to call runPythonAsync("print_info()"),
 * which is reentrancy: load_scene() -> robospaceLoadScene -> writeGeneratedScene ->
 * demo.reloadScene() -> here, all while the user's own coroutine is still suspended at
 * `await load_scene(...)`. That nested run executed in the same globals dict as the
 * user's frame, printed into the middle of their output, and interacted
 * unpredictably with the interrupt and stop state.
 *
 * Nothing here needed Python, so scene reloading no longer depends on Python state at
 * all — which also means a user who shadows `print_info` can no longer break it.
 */
export async function updatePythonEnvironment(demo) {
    if (typeof window.pythonOutput !== 'function') return;

    try {
        const model = demo?.model;
        if (!model) return;
        const { actuatorNames } = readModelNames(model);
        window.pythonOutput(`\nModel updated: nq=${model.nq} nv=${model.nv} nu=${model.nu} `
            + `nbody=${model.nbody} ngeom=${model.ngeom}`);
        if (actuatorNames.length) {
            window.pythonOutput(`Actuators: ${actuatorNames.join(', ')}`);
        } else {
            window.pythonOutput('Actuators: (none)');
        }
    } catch (error) {
        console.error('Error reporting the updated model:', error);
    }
}

// Shared interrupt buffer — allows stopping Python from JS
let _interruptBuffer = null;

function _setupInterruptBuffer() {
    try {
        _interruptBuffer = new Uint8Array(new SharedArrayBuffer(1));
        window.pyodide.setInterruptBuffer(_interruptBuffer);
    } catch (e) {
        // SharedArrayBuffer unavailable (missing COOP/COEP headers) — stop button
        // will fall back to a best-effort approach without hard interrupts
        console.warn('SharedArrayBuffer not available; Stop button will use soft interrupt.', e);
        _interruptBuffer = null;
    }
}

/**
 * Reports a failed script run with the line numbers the user can act on.
 *
 * What this replaces threw the traceback away:
 *
 *     if (msg.includes('KeyboardInterrupt') || msg.includes('PythonError')) ...
 *     const errorMsg = msg.split('\n').slice(-1)[0] || msg;
 *
 * Two separate defects. The `'PythonError'` substring test matches the stringified
 * form of *every* Python exception, so genuine errors were reported as "Stopped by
 * user". And `slice(-1)` keeps only the final line, discarding every
 * `File "<exec>", line N` frame — so no error ever carried a line number, and a
 * SyntaxError lost its location entirely.
 *
 * The line numbers were always correct and simply unused: Pyodide compiles the
 * submitted code with the filename `<exec>` and prepends no wrapper, so `<exec>`
 * frames map 1:1 onto the editor's gutter. This keeps those frames and their source
 * lines, drops Pyodide's own internal frames, and sets `lastUserErrorLine` so the
 * editor can jump there.
 */
function reportPythonError(error) {
    // Unconditionally, and first: the live object is the only place the full trace
    // survives, and the old code did not log it at all.
    console.error(error);

    // Pyodide's PythonError carries the exception class name on `.type`. Use it
    // rather than substring-matching the message, which is what misclassified errors.
    if (error && error.type === 'KeyboardInterrupt') {
        window.pythonOutput('\n⏹ Stopped by user');
        return;
    }

    const message = (error && error.message) ? error.message : String(error);
    const lines = message.split('\n');

    // Keep: the traceback header, every frame in the user's own code and the source
    // line under it, the caret line a SyntaxError adds, and the final
    // "ExceptionType: message". Drop frames from Pyodide's own machinery.
    const kept = [];
    let lastLine = null;
    let userFrames = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const frame = /^\s*File "([^"]*)", line (\d+)/.exec(line);
        if (frame) {
            if (frame[1] === '<exec>') {
                userFrames++;
                lastLine = Number(frame[2]);
                kept.push(`  line ${frame[2]}:`);
                // The source line, and a caret line if one follows it.
                if (lines[i + 1] && !/^\s*File "/.test(lines[i + 1])) kept.push(`    ${lines[++i].trim()}`);
                if (lines[i + 1] && /^\s*\^/.test(lines[i + 1])) kept.push(`    ${lines[++i].trim()}`);
            }
            continue;
        }
        if (/^\s*$/.test(line)) continue;
        if (/^Traceback/.test(line)) continue;
        // The final, unindented "SomeError: message" line.
        if (!/^\s/.test(line)) kept.push(line);
    }

    // If nothing matched, the failure is in our own helper code rather than the
    // user's — show everything rather than nothing.
    const detail = userFrames > 0 || kept.length ? kept : lines.filter((l) => l.trim());

    window.pythonOutput('\n✗ Error');
    for (const line of detail) window.pythonOutput(line);
    window.lastUserErrorLine = lastLine;
    if (lastLine !== null) {
        window.pythonOutput(`  (in your script at line ${lastLine})`);
    }
}

function _setRunning(isRunning) {
    const runButton = document.getElementById('run-python');
    const stopButton = document.getElementById('stop-python');
    if (!runButton || !stopButton) return;
    if (isRunning) {
        runButton.style.display = 'none';
        stopButton.style.display = '';
    } else {
        runButton.style.display = '';
        stopButton.style.display = 'none';
    }
}

const STORAGE_KEY_SCRIPT = 'robospace_last_script';
const DEFAULT_SCRIPT = `# Get system information
n_actuators = get_num_actuators()
print(f"Number of actuators: {n_actuators}")

# Print actuator details
names = get_actuator_names()
ranges = get_actuator_ranges()
for i in range(n_actuators):
    print(f"  {i}: {names[i]} \\t [{ranges[i][0]:.2f}, {ranges[i][1]:.2f}]")
`;

export function setupPythonIDE(demo) {
    const runButton = document.getElementById('run-python');
    const clearButton = document.getElementById('clear-python');
    const codeArea = document.getElementById('python-code');        // hidden fallback
    const outputArea = document.getElementById('python-output');
    const editorHost = document.getElementById('python-code-editor');
    const stopButton = document.getElementById('stop-python');

    // ── CodeMirror editor ──────────────────────────────────────
    const savedScript = localStorage.getItem(STORAGE_KEY_SCRIPT);
    const initialScript = savedScript !== null ? savedScript : DEFAULT_SCRIPT;

    let _editor = null;
    try {
        _editor = createCodeEditor(editorHost, initialScript);
    } catch (e) {
        console.warn('CodeMirror failed to load, falling back to textarea:', e);
        editorHost.style.display = 'none';
        codeArea.style.display = '';
        codeArea.value = initialScript;
    }

    const getCode = () => _editor ? _editor.getValue() : codeArea.value;
    const setCode = (text) => {
        if (_editor) _editor.setValue(text);
        else codeArea.value = text;
        localStorage.setItem(STORAGE_KEY_SCRIPT, text);
    };

    // Expose getter/setter/reset for top-level controls (Save, Import, Reset)
    window.getPythonScript = getCode;
    window.setPythonScript = setCode;
    window.resetPythonScript = () => setCode(DEFAULT_SCRIPT);

    // Persist script on every keystroke (debounced 500 ms)
    let _saveTimer = null;
    const _onInput = () => {
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(() => {
            localStorage.setItem(STORAGE_KEY_SCRIPT, getCode());
            window._roboDemo?.parentBridge?.emitDirty('script');
        }, 500);
    };
    if (_editor) {
        editorHost.addEventListener('input', _onInput);
        _editor.addKeyHandler((e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runButton.click(); }
            if (e.key === 'Escape' && stopButton && stopButton.style.display !== 'none') stopButton.click();
        });
    } else {
        codeArea.addEventListener('input', _onInput);
    }

    // Clear output
    if (clearButton) clearButton.addEventListener('click', () => {
        outputArea.innerHTML = '';
    });

    // Stop button — sends SIGINT to Pyodide
    if (stopButton) stopButton.addEventListener('click', () => {
        if (_interruptBuffer) _interruptBuffer[0] = 2; // SIGINT
        window._pythonShouldStop = true; // soft fallback
    });

    // Run Python code
    runButton.addEventListener('click', async () => {
        if (!window.pyodide) {
            window.pythonOutput("Pyodide not loaded yet. Please wait...");
            return;
        }

        const code = getCode();
        if (!code.trim()) return;

        if (_interruptBuffer) _interruptBuffer[0] = 0;
        window._pythonShouldStop = false;

        outputArea.innerHTML = '';
        window.pythonOutput("Running...\n");
        _setRunning(true);
        if (window.setSimStatus) window.setSimStatus('running');

        try {
            try {
                await window.pyodide.loadPackagesFromImports(code);
            } catch (error) {
                // Distinguish "that package does not exist in Pyodide" from a bug in
                // the user's code; otherwise it surfaces as a mangled internal trace.
                console.error(error);
                window.pythonOutput(`\n✗ Could not load an imported package: ${error.message || error}`);
                window.pythonOutput('  Pyodide ships a fixed set of packages; numpy is available, most PyPI packages are not.');
                return;
            }
            await window.pyodide.runPythonAsync(code);
            window.pythonOutput("\n✓ Execution completed");
        } catch (error) {
            reportPythonError(error);
        } finally {
            // Flush a trailing partial line, e.g. print("x", end="") before a throw.
            try { window.pyodide.runPython('import sys; sys.stdout.flush(); sys.stderr.flush()'); } catch (_) {}
            _setRunning(false);
            window._pythonShouldStop = false;
            if (window.setSimStatus) window.setSimStatus('ready');
        }
    });

    // Keyboard shortcut for plain textarea fallback
    if (!_editor && stopButton) {
        codeArea.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runButton.click(); }
            if (e.key === 'Escape' && stopButton.style.display !== 'none') stopButton.click();
        });
    }
}

// Example code snippets for different scenarios
export const PYTHON_EXAMPLES = {
    basic_control: `# The smallest thing that moves a robot.
#
# set_control writes the targets; run() lets the physics play out. No await.
names = actuator_names()
print("actuators:", names)

# Everything to zero, then hold for a moment so it settles.
set_control([0.0] * len(names))
run(1.0)
print("at zero:", get_qpos().round(3))

# Now move one actuator by name. set_actuator leaves the others alone.
set_actuator(names[0], 0.5)
run(1.5)
print("after moving", names[0], ":", get_qpos().round(3))

print("")
print("Try 'Where things are' next to see WHERE the robot ended up.")`,

    info: `# What is loaded, and where everything lives.
print_model()

print("")
print(f"sim time {get_time():.3f}s, {get_steps()} steps, timestep {dt()}")
print(f"paused: {is_paused()}")
print("")
print("help_api() lists everything available.")`,

    task_space: `# Where things are -- in the same coordinates as your scene XML (Z-up, metres).
import numpy as np

print("bodies:", body_names())
print("sites: ", site_names() or "(this model declares none)")

# Watch a site if the model has one, otherwise the last body.
if site_names():
    kind, name = 'site', site_names()[0]
else:
    kind, name = 'body', body_names()[-1]

pose = frame(kind, name)
print("")
print(f"{kind} {name!r}:")
print("  position", np.round(pose['pos'], 4))
print("  z-axis  ", np.round(axis(kind, name, 2), 4), "(which way it points)")
print("  model centre of mass:", np.round(com(), 4))

# Poses update as the simulation runs. Unpause to see this move.
async def watch(t):
    if t % 1.0 < 0.02:
        print(f"  t={t:4.1f}s  {name} at {np.round(frame(kind, name)['pos'], 4)}")

await control_loop(watch, duration=5)`,

    sine_wave: `# A sine wave that actually oscillates.
#
# control_loop calls your function once per rendered frame and passes elapsed
# SIMULATION time, so the motion is identical at 60 fps and at 20 -- and it stops
# cleanly when you press Stop.
import math

n = get_num_actuators()
AMPLITUDE, FREQ = 0.4, 0.25

async def policy(t):
    phase = [i * math.pi / max(1, n) for i in range(n)]
    set_control(clamp_control(
        [AMPLITUDE * math.sin(2 * math.pi * FREQ * t + phase[i]) for i in range(n)]
    ))

print(f"driving {n} actuators for 12 s of simulation time")
await control_loop(policy, duration=12)
print("done")`,

    pd_control: `# A PD controller, with the qpos indices looked up properly.
#
# Indexing qpos by actuator number happens to work on a plain 6-joint arm and is wrong
# the moment the model has a floating base or a gripper: a free joint alone occupies 7
# qpos slots. Go through the joint each actuator drives instead.
import numpy as np

KP, KD = 8.0, 0.5

names = actuator_names()
joints = [joint_info(actuator_joint(n)) if actuator_joint(n) else None for n in names]
targets = []
for n in names:
    rng = actuator_range(n)
    targets.append(0.0 if rng is None else 0.5 * (rng[0] + rng[1]))

print("actuator -> qpos slot:")
for n, j in zip(names, joints):
    print(f"  {n} -> {j['qposadr'] if j else '(not a joint actuator)'}")

async def policy(t):
    q, v = get_qpos(), get_qvel()
    ctrl = []
    for i, j in enumerate(joints):
        if j is None:
            ctrl.append(get_control()[i])
        else:
            ctrl.append(KP * (targets[i] - q[j['qposadr']]) - KD * v[j['dofadr']])
    set_control(clamp_control(ctrl))

await control_loop(policy, duration=8)
print("settled at", np.round(get_qpos()[:6], 3))`,

    load_a_robot: `# Fetch a real robot from MuJoCo Menagerie and stand it on a floor.
#
# The first load downloads meshes (Panda about 33 MB, Stretch 3 about 73 MB) and caches
# them in your browser, so later loads are instant. Progress appears below.
print("available:", list_robots())

await load_robot('franka_panda')
print_model()

print("")
print("Now try the 'Build a scene' example to put objects around it.")`,

    build_scene: `# Build the Panda + block scene. Start here, then run a manipulation example.
#
# This is the workbench the 'Pick up a block', 'Pick and place' and 'Sweep a joint'
# examples expect: a Panda, a red block at (0.5, 0), and a green pad to place it on.
#
# Three rules the loader cannot fix for you:
#   * <include> must be FIRST inside <mujoco>, or the robot's home pose lands on the
#     wrong joints.
#   * exactly one horizontal ground plane -- every plane renders as a fixed 100x100
#     mirror and its size and rotation are ignored.
#   * no image-file textures in this build; use builtin="checker"/"flat"/"gradient".
SCENE = """<mujoco model="workbench">
  <include file="panda.xml"/>
  <compiler angle="radian" autolimits="true"/>
  <option integrator="implicitfast"/>
  <asset>
    <texture type="skybox" builtin="gradient" rgb1="0.3 0.5 0.7" rgb2="0 0 0"
             width="512" height="3072"/>
    <texture type="2d" name="grid" builtin="checker" mark="edge"
             rgb1="0.2 0.3 0.4" rgb2="0.1 0.2 0.3" markrgb="0.8 0.8 0.8"
             width="300" height="300"/>
    <material name="grid" texture="grid" texuniform="true" texrepeat="5 5"/>
  </asset>
  <worldbody>
    <light pos="0 0 3" dir="0 0 -1" directional="true"/>
    <geom name="floor" size="0 0 0.05" type="plane" material="grid"/>
    <geom name="target_pad" type="box" size="0.05 0.05 0.001" pos="0.4 0.25 0.001"
          rgba="0.25 0.6 0.35 1"/>
    <body name="cube" pos="0.5 0 0.025">
      <freejoint/>
      <geom type="box" size="0.025 0.025 0.025" rgba="0.85 0.3 0.3 1"
            density="300" friction="1.5 0.02 0.001"/>
    </body>
  </worldbody>
</mujoco>"""

await load_scene(SCENE, robot='franka_panda', name='workbench')
print_model()

print("")
print("cube at      ", body_pos('cube').round(3))
print("target pad at (0.4, 0.25)")
print("")
print("Now run 'Pick up a block' or 'Pick and place'.")`,

    pick_block: `# Pick the block up. Six lines of motion, no await anywhere.
#
# Needs the workbench: run 'Build the Panda + block scene' first.
if 'cube' not in body_names():
    raise SystemExit("Run 'Build the Panda + block scene' first -- this needs the block.")

# The Panda declares no site, so we aim its "hand" body; with the tool pointing down the
# hand frame sits 0.1034 m above the fingertips.
def tips(z):
    return [0.5, 0.0, z + 0.1034]

print("cube starts at z =", round(float(body_pos('cube')[2]), 4))

open_gripper()
move_to('body:hand', pos=tips(0.13), quat=tool_down())
move_to('body:hand', pos=tips(0.03), quat=tool_down())
close_gripper()
move_to('body:hand', pos=tips(0.28), quat=tool_down())
run(1.0)

cube_z = float(body_pos('cube')[2])
print(f"cube height    {cube_z:.4f} m")
print(f"finger opening {float(get_joint('finger_joint1')):.4f} m")
print("PICK SUCCEEDED" if cube_z > 0.15 else "PICK FAILED")`,

    pick_and_place: `# Pick the block up and set it down on the green pad.
#
# Needs the workbench: run 'Build the Panda + block scene' first.
if 'cube' not in body_names():
    raise SystemExit("Run 'Build the Panda + block scene' first -- this needs the block.")

def tips(x, y, z):
    """Hand position putting the fingertips at (x, y, z). Panda has no site, so we aim
    the hand body; with the tool down, that frame sits 0.1034 m above the tips."""
    return [x, y, z + 0.1034]

GRASP = 0.030
print("cube starts at", body_pos('cube').round(3))

open_gripper()
move_to('body:hand', pos=tips(0.5, 0.0, GRASP + 0.10), quat=tool_down())
move_to('body:hand', pos=tips(0.5, 0.0, GRASP), quat=tool_down())
close_gripper()

move_to('body:hand', pos=tips(0.5, 0.0, GRASP + 0.20), quat=tool_down())
move_to('body:hand', pos=tips(0.4, 0.25, GRASP + 0.20), quat=tool_down())
move_to('body:hand', pos=tips(0.4, 0.25, GRASP + 0.01), quat=tool_down())
open_gripper()
move_to('body:hand', pos=tips(0.4, 0.25, GRASP + 0.20), quat=tool_down())
run(1.0)

landed = body_pos('cube')
print("cube ended at", landed.round(3), "(target pad is at 0.4, 0.25)")
on_target = abs(float(landed[0]) - 0.4) < 0.08 and abs(float(landed[1]) - 0.25) < 0.08
print("PLACED ON THE PAD" if on_target else "released, but not on the pad")`,

    stack_blocks: `# Stack one block on another. The same four moves, twice.
#
# Builds its own scene because it needs a SECOND block -- the workbench only has one.
SCENE = """<mujoco model="stack">
  <include file="panda.xml"/>
  <compiler angle="radian" autolimits="true"/>
  <option integrator="implicitfast"/>
  <asset>
    <texture type="2d" name="grid" builtin="checker" mark="edge"
             rgb1="0.2 0.3 0.4" rgb2="0.1 0.2 0.3" markrgb="0.8 0.8 0.8"
             width="300" height="300"/>
    <material name="grid" texture="grid" texuniform="true" texrepeat="5 5"/>
  </asset>
  <worldbody>
    <light pos="0 0 3" dir="0 0 -1" directional="true"/>
    <geom name="floor" size="0 0 0.05" type="plane" material="grid"/>
    <body name="base_cube" pos="0.45 0.15 0.025">
      <freejoint/>
      <geom type="box" size="0.025 0.025 0.025" rgba="0.3 0.5 0.85 1"
            density="400" friction="1.5 0.02 0.001"/>
    </body>
    <body name="top_cube" pos="0.5 -0.1 0.025">
      <freejoint/>
      <geom type="box" size="0.025 0.025 0.025" rgba="0.85 0.3 0.3 1"
            density="300" friction="1.5 0.02 0.001"/>
    </body>
  </worldbody>
</mujoco>"""

await load_scene(SCENE, robot='franka_panda', name='stack')

def tips(x, y, z):
    return [x, y, z + 0.1034]

def grasp_at(x, y, z):
    """Approach from above, close, and lift clear."""
    move_to('body:hand', pos=tips(x, y, z + 0.10), quat=tool_down())
    move_to('body:hand', pos=tips(x, y, z), quat=tool_down())
    close_gripper()
    move_to('body:hand', pos=tips(x, y, z + 0.15), quat=tool_down())

def release_at(x, y, z):
    move_to('body:hand', pos=tips(x, y, z + 0.12), quat=tool_down())
    move_to('body:hand', pos=tips(x, y, z), quat=tool_down())
    open_gripper()
    move_to('body:hand', pos=tips(x, y, z + 0.15), quat=tool_down())

base = body_pos('base_cube')
top = body_pos('top_cube')
print("base at", base.round(3), " top at", top.round(3))

open_gripper()
grasp_at(float(top[0]), float(top[1]), 0.030)
# A cube is 0.05 tall, so the stacked one sits one full cube higher.
release_at(float(base[0]), float(base[1]), 0.030 + 0.05)
run(1.5)

final = body_pos('top_cube')
print("top cube ended at", final.round(3))
print("STACKED" if float(final[2]) > 0.06 else "NOT STACKED (it is still on the floor)")`,

    drive_stretch: `# Drive a mobile robot. Stretch 3 has a real differential-drive base.
#
# Its wheels are VELOCITY actuators, so a control value is a wheel speed, not a
# position -- set it, let time pass, and the robot travels.
await load_robot('stretch_3')
print_model()

start = body_pos('base_link')
print("")
print("base starts at", start.round(3))

# Equal speeds drive straight; opposite speeds spin in place.
set_actuator('left_wheel_vel', 2.0)
set_actuator('right_wheel_vel', 2.0)
run(2.0)
print("after driving forward:", body_pos('base_link').round(3))

set_actuator('left_wheel_vel', 1.5)
set_actuator('right_wheel_vel', -1.5)
run(1.5)
print("after spinning:      ", body_pos('base_link').round(3))

# Stop, then use the arm. lift and arm are POSITION actuators, so their control value
# is a target, not a speed. Addressed by actuator name rather than joint name, because
# the wheels above are the same API and this keeps the example uniform.
set_actuator('left_wheel_vel', 0.0)
set_actuator('right_wheel_vel', 0.0)
set_actuator('lift', 0.8)
run(2.0)
set_actuator('arm', 0.3)
run(1.5)

travelled = float(np.linalg.norm(body_pos('base_link')[:2] - start[:2]))
print("")
print(f"travelled {travelled:.3f} m")`,

    sweep_joint: `# Sweep a joint through its range and watch where the tool ends up.
#
# Works on whatever is loaded -- no scene setup needed.
#
# Nothing here is robot-specific: the joint, its limits and the frame to watch are all
# read from the model, so this runs unchanged on any robot you load.
import numpy as np

acts = model_info()['actuators']

joint = None
for name in joint_names():
    driven = any(a['joint'] == name for a in acts)
    if driven and joint_limits(name):
        joint = name
        break

if joint is None:
    print("this model has no limited joint with a position actuator driving it")
else:
    lo, hi = joint_limits(joint)
    watch_kind = 'site' if site_names() else 'body'
    watch = site_names()[0] if site_names() else body_names()[-1]
    print(f"sweeping {joint} over [{lo:.3f}, {hi:.3f}] rad")
    print(f"watching {watch_kind} {watch!r}")
    print("")
    for frac in [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]:
        value = lo + frac * (hi - lo)
        move_joints({joint: value}, seconds=0.5)
        print(f"  {value:7.3f} rad -> {np.round(frame(watch_kind, watch)['pos'], 3)}")
    print("")
    print("Those positions are the reachable arc of that one joint.")`,

    live_control: `# The advanced path: a closed loop that reacts every frame.
#
# Most scripts do not need this -- move_to() and run() are synchronous and simpler.
# Reach for control_loop when the command has to depend on what just happened.
#
# This is the one place 'await' is unavoidable: the loop has to hand the browser a frame
# between iterations, or the tab would freeze.
import math

n = get_num_actuators()

async def policy(t):
    # Recomputed every frame from the live state.
    q = get_qpos()
    set_control(clamp_control([0.3 * math.sin(2 * math.pi * 0.3 * t) for _ in range(n)]))

await control_loop(policy, duration=10)
print("done, final qpos:", get_qpos()[:4].round(3))`,
};

// Menu labels, beside the examples on purpose: an example missing from this map is
// silently absent from the UI, which is how load_robot and load_scene went unlisted
// while being two of the most useful things in the API.
export const EXAMPLE_LABELS = {
    // Roughly a learning path: what is loaded -> make it move -> where things are ->
    // load a real robot -> build a scene -> manipulate -> advanced.
    info:            'What is loaded',
    basic_control:   'Make it move',
    task_space:      'Where things are',
    sweep_joint:     'Sweep a joint',
    load_a_robot:    'Load a real robot',
    build_scene:     'Build the Panda + block scene',
    pick_block:      '└ Pick up a block',
    pick_and_place:  '└ Pick and place',
    stack_blocks:    'Stack two blocks',
    drive_stretch:   'Drive a mobile robot',
    pd_control:      'PD controller',
    sine_wave:       'Sine wave',
    live_control:    'Live control loop (advanced)',
};