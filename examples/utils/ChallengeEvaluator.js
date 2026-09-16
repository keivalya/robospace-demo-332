// examples/utils/ChallengeEvaluator.js
//
// Evaluates active challenge criteria (goals, distance, energy, time),
// renders 3D viewport beacons, and manages ghost replay trajectories.

import * as THREE from 'three';
import { CHALLENGES } from './challengeRegistry.js';

export class ChallengeEvaluator {
  constructor(demo) {
    this.demo = demo;
    this.activeChallenge = null;
    this.challengeState = {};
    this.status = 'idle'; // 'idle' | 'running' | 'completed' | 'failed'
    this.simStartTime = 0;
    this.energyAccumulator = 0;
    this.lastProgressEmit = 0;
    this.qposHistory = [];
    this.markerGroup = new THREE.Group();
    this.markerGroup.name = 'ChallengeMarkers';
    this.markers = [];
    this.onCompleteCallback = null;
    this.onProgressCallback = null;

    if (this.demo.scene) {
      this.demo.scene.add(this.markerGroup);
    }
  }

  start(challengeId, onProgress, onComplete) {
    const spec = CHALLENGES[challengeId];
    if (!spec) {
      console.warn(`[ChallengeEvaluator] Challenge ${challengeId} not found in registry`);
      return false;
    }

    this.stop(); // Clean any previous markers

    this.activeChallenge = spec;
    this.challengeState = {};
    this.onProgressCallback = onProgress;
    this.onCompleteCallback = onComplete;
    this.status = 'running';
    this.simStartTime = this.demo.simClock ? this.demo.simClock.time : 0;
    this.energyAccumulator = 0;
    this.qposHistory = [];
    this.lastProgressEmit = 0;

    this._spawnMarkers(spec);
    return true;
  }

  stop() {
    this.status = 'idle';
    this.activeChallenge = null;
    this.challengeState = {};
    this._clearMarkers();
  }

  sample(sim, model) {
    if (this.status !== 'running' || !this.activeChallenge) return;

    const dt = model.getOptions().timestep;
    const currentSimTime = (this.demo.simClock ? this.demo.simClock.time : 0) - this.simStartTime;

    // 1. Accumulate control effort (energy: integral of sum(ctrl^2) dt)
    if (sim.ctrl) {
      let frameEnergy = 0;
      for (let i = 0; i < sim.ctrl.length; i++) {
        frameEnergy += sim.ctrl[i] * sim.ctrl[i];
      }
      this.energyAccumulator += frameEnergy * dt;
    }

    // 2. Sample qpos at ~10Hz for ghost replays
    const nowMs = performance.now();
    if (this.lastProgressEmit === 0 || nowMs - this.lastProgressEmit >= 100) {
      if (sim.qpos && this.qposHistory.length < 600) {
        this.qposHistory.push(Array.from(sim.qpos));
      }

      // Evaluate challenge state
      const evalResult = this.activeChallenge.evaluate(
        sim,
        model,
        currentSimTime,
        this.energyAccumulator,
        this.challengeState
      );

      // Update beacon visuals based on current target
      this._updateMarkerVisuals(evalResult);

      this.onProgressCallback?.({
        challengeId: this.activeChallenge.id,
        elapsed: currentSimTime,
        energy: this.energyAccumulator,
        distanceToGoal: evalResult.distanceToGoal,
        waypointsRemaining: evalResult.waypointsRemaining,
      });

      this.lastProgressEmit = nowMs;

      // 3. Test for success
      if (evalResult.success && this.status === 'running') {
        this.status = 'completed';
        const stars = this._computeStars(currentSimTime, this.energyAccumulator);
        
        // Highlight all markers green
        this._highlightSuccess();

        this.onCompleteCallback?.({
          challengeId: this.activeChallenge.id,
          stars,
          timeSeconds: currentSimTime,
          energyTotal: this.energyAccumulator,
          qposTrajectory: this.qposHistory,
        });
      }
    }
  }

  _computeStars(time, energy) {
    let stars = 1; // 1 star for clearing the objective
    if (this.activeChallenge?.starTargets) {
      if (time <= this.activeChallenge.starTargets.time) stars++;
      if (energy <= this.activeChallenge.starTargets.energy) stars++;
    }
    return Math.min(3, stars);
  }

  _spawnMarkers(spec) {
    this._clearMarkers();

    spec.targetPositions.forEach((pos, idx) => {
      // Create glowing wireframe target sphere
      const geom = new THREE.SphereGeometry(spec.targetTolerance || 0.05, 16, 12);
      const mat = new THREE.MeshBasicMaterial({
        color: idx === 0 ? 0x00b0ff : 0x64748b, // Active cyan, pending muted
        wireframe: true,
        transparent: true,
        opacity: 0.8,
      });
      const mesh = new THREE.Mesh(geom, mat);

      // Coordinate change: MuJoCo (x, y, z) -> Three.js (x, z, -y)
      mesh.position.set(pos.x, pos.z, -pos.y);

      // Inner pulsating solid core
      const coreGeom = new THREE.SphereGeometry(0.012, 12, 12);
      const coreMat = new THREE.MeshBasicMaterial({
        color: idx === 0 ? 0x08d8c0 : 0x475569,
      });
      const coreMesh = new THREE.Mesh(coreGeom, coreMat);
      mesh.add(coreMesh);

      this.markerGroup.add(mesh);
      this.markers.push({ mesh, mat, coreMat, idx });
    });
  }

  _updateMarkerVisuals(evalResult) {
    const activeIdx = evalResult.currentTargetIndex || 0;
    this.markers.forEach((m) => {
      if (m.idx < activeIdx) {
        // Visited -> Emerald green
        m.mat.color.setHex(0x10b981);
        m.coreMat.color.setHex(0x10b981);
      } else if (m.idx === activeIdx) {
        // Current active -> Bright brand cyan
        m.mat.color.setHex(0x00b0ff);
        m.coreMat.color.setHex(0x08d8c0);
      } else {
        // Future -> Muted slate
        m.mat.color.setHex(0x64748b);
        m.coreMat.color.setHex(0x475569);
      }
    });
  }

  _highlightSuccess() {
    this.markers.forEach((m) => {
      m.mat.color.setHex(0x10b981);
      m.coreMat.color.setHex(0x34d399);
    });
  }

  _clearMarkers() {
    if (!this.markerGroup || !this.markerGroup.children) {
      this.markers = [];
      return;
    }
    while (this.markerGroup.children.length > 0) {
      const child = this.markerGroup.children[0];
      this.markerGroup.remove(child);
      if (child && child.geometry && child.geometry.dispose) child.geometry.dispose();
      if (child && child.material && child.material.dispose) child.material.dispose();
    }
    this.markers = [];
  }
}
