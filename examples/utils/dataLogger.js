// examples/utils/dataLogger.js
//
// Synchronized Observers & The Data Logger (The Recorder)
// Captures unprivileged real-world observations and actions at a fixed frequency
// (10Hz–30Hz) during robot execution for LeRobot dataset creation.

export class DataRecorder {
  /**
   * @param {object} [options]
   * @param {number} [options.fps=30] Recording frequency in Hz (default 30Hz)
   * @param {number} [options.imageWidth=224] Camera frame width
   * @param {number} [options.imageHeight=224] Camera frame height
   * @param {string} [options.cameraName=null] Camera to capture (or auto-detected)
   * @param {string} [options.robotType='franka_panda'] Robot type identifier
   * @param {string} [options.datasetName='robospace_dataset'] Name of dataset
   */
  constructor(options = {}) {
    this.fps = options.fps || 30;
    this.imageWidth = options.imageWidth || 224;
    this.imageHeight = options.imageHeight || 224;
    this.cameraName = options.cameraName || null;
    this.robotType = options.robotType || 'franka_panda';
    this.datasetName = options.datasetName || 'robospace_dataset';

    this.isRecording = false;
    this.currentEpisodeIndex = 0;
    this.currentTaskName = 'manipulation_task';
    this.currentTaskIndex = 0;
    this.currentEpisodeFrames = [];
    this.episodes = [];
    this.totalFrames = 0;
    this.successCount = 0;

    // Feature statistics accumulator for LeRobot stats.json
    this._featureStats = {
      action: { count: 0, min: [], max: [], sum: [], sumSq: [] },
      'observation.state': { count: 0, min: [], max: [], sum: [], sumSq: [] },
    };

    this._lastRecordedSimTime = -1;
    this._recordIntervalSec = 1.0 / this.fps;

    // Listener callbacks
    this._listeners = new Set();
  }

  addListener(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify(type, data) {
    for (const fn of this._listeners) {
      try { fn(type, data); } catch (e) { console.error('[DataRecorder] listener error:', e); }
    }
  }

  /**
   * Reset all recorded dataset data.
   */
  clear() {
    this.isRecording = false;
    this.currentEpisodeIndex = 0;
    this.currentEpisodeFrames = [];
    this.episodes = [];
    this.totalFrames = 0;
    this.successCount = 0;
    this._lastRecordedSimTime = -1;
    this._featureStats = {
      action: { count: 0, min: [], max: [], sum: [], sumSq: [] },
      'observation.state': { count: 0, min: [], max: [], sum: [], sumSq: [] },
    };
    this._notify('clear', {});
  }

  /**
   * Start recording a new episode.
   * @param {number} episodeIndex
   * @param {string} taskName
   * @param {number} [taskIndex=0]
   */
  startEpisode(episodeIndex, taskName = 'manipulation_task', taskIndex = 0) {
    this.currentEpisodeIndex = episodeIndex;
    this.currentTaskName = taskName;
    this.currentTaskIndex = taskIndex;
    this.currentEpisodeFrames = [];
    this._lastRecordedSimTime = -1;
    this.isRecording = true;
    this._notify('episode_start', { episodeIndex, taskName });
  }

  /**
   * Records a single synchronized observation-action frame from simulation state.
   *
   * @param {object} demo The RoboSpaceDemo instance
   * @param {boolean} [force=false] Force capture regardless of timestamp interval
   * @returns {object|null} The recorded frame, or null if skipped
   */
  recordFrame(demo, force = false) {
    if (!this.isRecording) return null;
    const sim = demo?.simulation;
    const model = demo?.model;
    if (!sim || !model) return null;

    const simTime = demo.simClock ? demo.simClock.time : 0;
    if (!force && this._lastRecordedSimTime >= 0 && (simTime - this._lastRecordedSimTime) < (this._recordIntervalSec * 0.95)) {
      return null;
    }
    this._lastRecordedSimTime = simTime;

    // 1. Unprivileged Kinematics: Joint positions & velocities
    // Only capture actuated joints (nu) or arm + gripper joints, not free joint coordinates of objects
    const nu = model.nu || 0;
    const ctrl = Array.from(sim.ctrl.subarray(0, nu));

    // Robot joint positions from actuators or first nu qpos elements
    const jointPos = [];
    const jointVel = [];
    for (let i = 0; i < nu; i++) {
      let qadr = i;
      if (model.actuator_trntype && model.actuator_trntype[i] === 0 && model.actuator_trnid) {
        const jntId = model.actuator_trnid[2 * i];
        if (jntId >= 0 && model.jnt_qposadr && model.jnt_dofadr) {
          qadr = model.jnt_qposadr[jntId];
          const dofadr = model.jnt_dofadr[jntId];
          jointPos.push(sim.qpos[qadr]);
          jointVel.push(sim.qvel[dofadr]);
          continue;
        }
      }
      jointPos.push(i < sim.qpos.length ? sim.qpos[i] : 0);
      jointVel.push(i < sim.qvel.length ? sim.qvel[i] : 0);
    }

    // 2. Unprivileged End-Effector 6-DoF Pose (pos + quat)
    let eePos = [0, 0, 0];
    let eeQuat = [1, 0, 0, 0];

    if (model.nsite > 0 && sim.site_xpos && sim.site_xmat) {
      // Find attachment site or tool site
      eePos = [sim.site_xpos[0], sim.site_xpos[1], sim.site_xpos[2]];
      // Convert 3x3 matrix to quaternion
      const m = sim.site_xmat.subarray(0, 9);
      eeQuat = this._matToQuat(m);
    } else if (model.nbody > 1 && sim.xpos && sim.xquat) {
      // Fallback: End body (e.g. hand or link7)
      const lastBody = model.nbody - 1;
      eePos = [sim.xpos[3 * lastBody], sim.xpos[3 * lastBody + 1], sim.xpos[3 * lastBody + 2]];
      eeQuat = [
        sim.xquat[4 * lastBody],
        sim.xquat[4 * lastBody + 1],
        sim.xquat[4 * lastBody + 2],
        sim.xquat[4 * lastBody + 3],
      ];
    }

    // Standardized observation.state vector: [jointPos (nu), jointVel (nu), eePos (3), eeQuat (4)]
    const state = new Float32Array(jointPos.length + jointVel.length + 3 + 4);
    let offset = 0;
    for (let i = 0; i < jointPos.length; i++) state[offset++] = jointPos[i];
    for (let i = 0; i < jointVel.length; i++) state[offset++] = jointVel[i];
    state[offset++] = eePos[0];
    state[offset++] = eePos[1];
    state[offset++] = eePos[2];
    state[offset++] = eeQuat[0];
    state[offset++] = eeQuat[1];
    state[offset++] = eeQuat[2];
    state[offset++] = eeQuat[3];

    // Standardized action vector: low-level actuator commands [ctrl (nu)]
    const action = new Float32Array(ctrl);

    // 3. Visuals: Attached robot camera frames
    let rgbImage = null;
    let cameraIdentifier = this.cameraName;
    if (!cameraIdentifier && demo.cameraViewer) {
      const gripIdx = typeof demo.cameraViewer.getGripperCameraIndex === 'function'
        ? demo.cameraViewer.getGripperCameraIndex()
        : 0;
      const gripCam = demo.cameraViewer.cameras?.[gripIdx] || demo.cameraViewer.activeCamera;
      cameraIdentifier = gripCam ? gripCam.name : 'gripper_camera';
      this.cameraName = cameraIdentifier;
    }
    if (demo.cameraViewer && demo.renderer && demo.scene) {
      try {
        const captured = demo.cameraViewer.captureImage(
          demo.renderer,
          demo.scene,
          sim,
          model,
          cameraIdentifier,
          this.imageWidth,
          this.imageHeight,
          'numpy',
        );
        if (captured && captured.data) {
          rgbImage = captured.data;
        }
      } catch (err) {
        // Fallback for headless or mock environments
      }
    }

    // Update feature stats
    this._accumulateStats('action', action);
    this._accumulateStats('observation.state', state);

    const frame = {
      timestamp: simTime,
      frame_index: this.currentEpisodeFrames.length,
      episode_index: this.currentEpisodeIndex,
      index: this.totalFrames + this.currentEpisodeFrames.length,
      task_index: this.currentTaskIndex,
      state,
      action,
      jointPos,
      jointVel,
      eePos,
      eeQuat,
      cameraName: cameraIdentifier || 'gripper_camera',
      image: rgbImage,
    };

    this.currentEpisodeFrames.push(frame);
    this._notify('frame', { frameIndex: frame.frame_index, totalFrames: this.totalFrames + this.currentEpisodeFrames.length });
    return frame;
  }

  /**
   * Complete the current episode.
   * @param {boolean} [success=true] Whether the task objective was achieved
   * @returns {object} Completed episode metadata
   */
  endEpisode(success = true) {
    if (!this.isRecording) return null;
    this.isRecording = false;

    const length = this.currentEpisodeFrames.length;
    const epData = {
      episodeIndex: this.currentEpisodeIndex,
      length,
      success: !!success,
      task: this.currentTaskName,
      taskIndex: this.currentTaskIndex,
      frames: this.currentEpisodeFrames,
    };

    this.episodes.push(epData);
    this.totalFrames += length;
    if (success) this.successCount++;

    this._notify('episode_end', {
      episodeIndex: this.currentEpisodeIndex,
      length,
      success: !!success,
      totalEpisodes: this.episodes.length,
      successRate: this.episodes.length > 0 ? (this.successCount / this.episodes.length) : 0,
    });

    return epData;
  }

  /**
   * Returns current statistics required for LeRobot stats.json.
   */
  getStats() {
    const out = {};
    for (const [key, stat] of Object.entries(this._featureStats)) {
      if (!stat.count) continue;
      const n = stat.count;
      const mean = stat.sum.map((s) => s / n);
      const std = stat.sumSq.map((sq, i) => {
        const variance = Math.max(0, sq / n - mean[i] * mean[i]);
        return Math.sqrt(variance);
      });
      out[key] = {
        min: stat.min.slice(),
        max: stat.max.slice(),
        mean,
        std,
      };
    }
    return out;
  }

  /**
   * Current overall collection progress.
   */
  getProgress() {
    const totalEpisodes = this.episodes.length;
    const successRate = totalEpisodes > 0 ? (this.successCount / totalEpisodes) : 0;
    return {
      isRecording: this.isRecording,
      currentEpisodeIndex: this.currentEpisodeIndex,
      totalEpisodes,
      successCount: this.successCount,
      successRate,
      totalFrames: this.totalFrames + (this.isRecording ? this.currentEpisodeFrames.length : 0),
    };
  }

  _accumulateStats(key, vector) {
    const stat = this._featureStats[key];
    if (!stat) return;
    const len = vector.length;
    if (stat.count === 0) {
      stat.min = Array.from(vector);
      stat.max = Array.from(vector);
      stat.sum = Array.from(vector);
      stat.sumSq = Array.from(vector).map((v) => v * v);
    } else {
      for (let i = 0; i < len; i++) {
        const v = vector[i];
        if (v < stat.min[i]) stat.min[i] = v;
        if (v > stat.max[i]) stat.max[i] = v;
        stat.sum[i] += v;
        stat.sumSq[i] += v * v;
      }
    }
    stat.count++;
  }

  _matToQuat(m) {
    const tr = m[0] + m[4] + m[8];
    let w, x, y, z;
    if (tr > 0) {
      const s = 0.5 / Math.sqrt(tr + 1.0);
      w = 0.25 / s;
      x = (m[7] - m[5]) * s;
      y = (m[2] - m[6]) * s;
      z = (m[3] - m[1]) * s;
    } else if (m[0] > m[4] && m[0] > m[8]) {
      const s = 2.0 * Math.sqrt(1.0 + m[0] - m[4] - m[8]);
      w = (m[7] - m[5]) / s;
      x = 0.25 * s;
      y = (m[1] + m[3]) / s;
      z = (m[2] + m[6]) / s;
    } else if (m[4] > m[8]) {
      const s = 2.0 * Math.sqrt(1.0 + m[4] - m[0] - m[8]);
      w = (m[2] - m[6]) / s;
      x = (m[1] + m[3]) / s;
      y = 0.25 * s;
      z = (m[5] + m[7]) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m[8] - m[0] - m[4]);
      w = (m[3] - m[1]) / s;
      x = (m[2] + m[6]) / s;
      y = (m[5] + m[7]) / s;
      z = 0.25 * s;
    }
    return [w, x, y, z];
  }
}
