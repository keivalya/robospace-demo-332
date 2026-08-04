// examples/utils/ik.js
//
// Inverse kinematics by finite differences, because no analytic Jacobian is available:
// of the whole mj_jac* family only `jacSubtreeCom` is bound in this WASM build, and the
// build cannot be regenerated. So the Jacobian is differenced numerically using
// `kinematics()`, which is ~16x cheaper than a full `forward()` (0.46 us vs 7.5 us on
// ur5e) and is what makes this affordable at all.
//
// WHY THIS LIVES IN JS AND NOT PYTHON
//
// A 6-DoF solve evaluates forward kinematics a few hundred times. Each evaluation from
// Python would cost three Pyodide<->JS crossings (write qpos, kinematics, read pose) at
// order 10-50 us each — roughly 20-40 ms of marshalling against ~0.2 ms of actual
// physics. Here it is two crossings per solve, total.
//
// It also means the solve is one synchronous call, so the render loop cannot interleave
// and draw a probe configuration. That is a correctness property, not a nicety:
// **nothing in this file may await.** The sub-millisecond cost is what makes that
// affordable; do not later "improve" it by yielding.
//
// MEASURED, on ur5e over 100 random reachable 6-D targets:
//
//     seeds=1   fail 29/100   worst pos 895.5 mm   mean 0.43 ms
//     seeds=4   fail  9/100   worst pos 431.3 mm   mean 0.71 ms
//     seeds=8   fail  4/100   worst pos 102.7 mm   mean 0.84 ms
//     seeds=16  fail  0/100   worst pos   0.001 mm mean 0.80 ms
//
// The failures are genuine local minima, not loose tolerances. Restarts are nearly free
// because the mean number actually tried is 1.92 — the insurance almost never fires — so
// 16 is the default. With one seed this feature would earn a reputation for flakiness.

import { matToQuat, quatConj, quatMul, quatToRotVec } from './mjmath.js';

const JNT_FREE = 0, JNT_BALL = 1, JNT_SLIDE = 2, JNT_HINGE = 3;
const TRN_JOINT = 0;

function enumValue(ns, name, fallback) {
  try { return ns[name].value; } catch (_) { return fallback; }
}

/** World pose of the target frame, in raw MuJoCo coordinates. */
function framePose(model, sim, kind, i) {
  if (kind === 'body') {
    return {
      pos: [sim.xpos[3 * i], sim.xpos[3 * i + 1], sim.xpos[3 * i + 2]],
      quat: [sim.xquat[4 * i], sim.xquat[4 * i + 1], sim.xquat[4 * i + 2], sim.xquat[4 * i + 3]],
    };
  }
  const posArr = kind === 'site' ? sim.site_xpos : sim.geom_xpos;
  const matArr = kind === 'site' ? sim.site_xmat : sim.geom_xmat;
  return {
    pos: [posArr[3 * i], posArr[3 * i + 1], posArr[3 * i + 2]],
    quat: matToQuat(Array.from(matArr.subarray(9 * i, 9 * i + 9))),
  };
}

/** Gaussian elimination with partial pivoting. Returns null on a singular system. */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

/**
 * Which joints the solver is allowed to move.
 *
 * Default: every hinge or slide joint driven by a joint-transmission actuator. That is
 * the useful default because a solution the robot cannot then be *commanded* to is
 * worthless — a free base or an unactuated joint would produce a pose nothing can reach.
 */
function defaultDofs(model, mujoco) {
  const slide = enumValue(mujoco?.mjtJoint, 'mjJNT_SLIDE', JNT_SLIDE);
  const hinge = enumValue(mujoco?.mjtJoint, 'mjJNT_HINGE', JNT_HINGE);
  const trnJoint = enumValue(mujoco?.mjtTrn, 'mjTRN_JOINT', TRN_JOINT);

  const actuated = new Set();
  for (let a = 0; a < model.nu; a++) {
    if (model.actuator_trntype[a] === trnJoint) {
      const j = model.actuator_trnid[2 * a];
      if (j >= 0) actuated.add(j);
    }
  }
  const dofs = [];
  for (const j of [...actuated].sort((x, y) => x - y)) {
    const type = model.jnt_type[j];
    if (type === slide || type === hinge) dofs.push(j);
  }
  return dofs;
}

/**
 * @param {object} demo             live demo; model/simulation are read fresh
 * @param {object} spec
 * @param {'site'|'body'|'geom'} spec.kind
 * @param {number} spec.index       target frame index
 * @param {number[]} [spec.pos]     desired world position; omit to leave position free
 * @param {number[]} [spec.quat]    desired world orientation [w,x,y,z]; omit to leave free
 * @param {number[]} [spec.joints]  joint indices to move; defaults to actuated hinge/slide
 * @param {number[]} [spec.seed]    starting qpos; defaults to the current one
 * @returns {{success:boolean, qpos:number[], joints:object, posErr:number, rotErr:number,
 *            iters:number, seedsTried:number, ms:number, reason:string, dofJoints:number[]}}
 */
export function solveIk(demo, spec) {
  const model = demo.model;
  const sim = demo.simulation;
  if (!model || !sim) throw new Error('No model is loaded.');

  const {
    kind = 'site', index = 0, pos = null, quat = null,
    joints = null, seed = null,
    posWeight = 1.0, rotWeight = 0.5,
    restarts = 16, maxIters = 60, maxMs = 50,
    posTol = 1e-4, rotTol = 1e-3,
    respectLimits = true,
  } = spec;

  if (!pos && !quat) throw new Error('ik needs a target position, a target orientation, or both.');

  const dofJoints = joints && joints.length ? joints.slice() : defaultDofs(model, demo.mujoco);
  if (!dofJoints.length) throw new Error('No movable joints found for IK.');

  // A free or ball joint occupies several qpos slots and cannot be treated as one
  // scalar, so refuse clearly rather than silently perturbing part of a quaternion.
  const free = enumValue(demo.mujoco?.mjtJoint, 'mjJNT_FREE', JNT_FREE);
  const ball = enumValue(demo.mujoco?.mjtJoint, 'mjJNT_BALL', JNT_BALL);
  for (const j of dofJoints) {
    if (model.jnt_type[j] === free || model.jnt_type[j] === ball) {
      throw new Error(`Joint ${j} is a free or ball joint; IK moves only hinge and slide joints.`);
    }
  }

  const addr = dofJoints.map((j) => model.jnt_qposadr[j]);
  const lo = [];
  const hi = [];
  for (const j of dofJoints) {
    const limited = respectLimits && !!model.jnt_limited[j];
    lo.push(limited ? model.jnt_range[2 * j] : -Math.PI);
    hi.push(limited ? model.jnt_range[2 * j + 1] : Math.PI);
  }
  const n = dofJoints.length;
  const rows = (pos ? 3 : 0) + (quat ? 3 : 0);

  // Save and restore everything we touch: the caller's scene must look untouched.
  const savedQpos = Array.from(sim.qpos);
  const savedQvel = Array.from(sim.qvel);

  const applyAndFk = (q) => {
    for (let k = 0; k < n; k++) sim.qpos[addr[k]] = q[k];
    sim.kinematics();
    return framePose(model, sim, kind, index);
  };

  /** Residual: target minus current, weighted. Goes to zero at the solution. */
  const residual = (q) => {
    const f = applyAndFk(q);
    const e = [];
    if (pos) {
      e.push((pos[0] - f.pos[0]) * posWeight,
        (pos[1] - f.pos[1]) * posWeight,
        (pos[2] - f.pos[2]) * posWeight);
    }
    if (quat) {
      // Differencing the *residual* rather than the pose is what sidesteps the +/-pi
      // quaternion wrap: the error is always measured against the same fixed target.
      const rv = quatToRotVec(quatMul(quat, quatConj(f.quat)));
      e.push(rv[0] * rotWeight, rv[1] * rotWeight, rv[2] * rotWeight);
    }
    return e;
  };

  const errorsOf = (q) => {
    const f = applyAndFk(q);
    return {
      posErr: pos ? Math.hypot(pos[0] - f.pos[0], pos[1] - f.pos[1], pos[2] - f.pos[2]) : 0,
      rotErr: quat ? Math.hypot(...quatToRotVec(quatMul(quat, quatConj(f.quat)))) : 0,
    };
  };

  const cost = (e) => e.reduce((s, v) => s + v * v, 0);
  const clamp = (q) => q.map((v, k) => Math.max(lo[k] + 1e-6, Math.min(hi[k] - 1e-6, v)));

  const startQpos = seed ? seed.slice() : savedQpos;
  const seeds = [addr.map((a, k) => (startQpos[a] ?? 0))];
  // Deterministic pseudo-random restarts: reproducible failures matter more than true
  // randomness, and a fixed sequence means a flaky report is investigable.
  let rng = 12345;
  const nextRandom = () => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    return rng / 0x7fffffff;
  };
  for (let s = 1; s < Math.max(1, restarts); s++) {
    seeds.push(lo.map((low, k) => low + nextRandom() * (hi[k] - low)));
  }

  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const elapsed = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;

  let best = null;
  let totalIters = 0;
  let seedsTried = 0;
  let reason = 'no solution';
  const h = 1e-6;

  try {
    for (const s of seeds) {
      seedsTried++;
      if (window?._pythonShouldStop) { reason = 'stopped'; break; }
      if (elapsed() > maxMs) { reason = 'time budget exhausted'; break; }

      let q = clamp(s.slice());
      let e = residual(q);
      let c = cost(e);
      let lambda = 1e-3;

      for (let iter = 0; iter < maxIters; iter++) {
        totalIters++;
        const errs = errorsOf(q);
        if (errs.posErr <= posTol && errs.rotErr <= rotTol) break;
        if (elapsed() > maxMs) { reason = 'time budget exhausted'; break; }
        if (iter % 10 === 0 && window?._pythonShouldStop) { reason = 'stopped'; break; }

        // Jacobian by forward differences: one kinematics() per column.
        const J = [];
        for (let k = 0; k < n; k++) {
          const qp = q.slice();
          qp[k] += h;
          const ep = residual(qp);
          J.push(ep.map((v, r) => (v - e[r]) / h));
        }

        // Levenberg-Marquardt in the n x n form, which works unchanged for a redundant
        // arm (7 joints against a 6-D task); the 6x6 J*J^T form does not generalise.
        let accepted = false;
        for (let attempt = 0; attempt < 8 && !accepted; attempt++) {
          const A = [];
          for (let r = 0; r < n; r++) {
            A.push([]);
            for (let cc = 0; cc < n; cc++) {
              let sum = 0;
              for (let row = 0; row < rows; row++) sum += J[r][row] * J[cc][row];
              A[r].push(sum + (r === cc ? lambda * (1 + sum) : 0));
            }
          }
          // Right-hand side is -Jᵀe, and the minus sign is load-bearing.
          //
          // J here is d(residual)/dq, and we want the residual driven to zero:
          //   e(q + dq) ~= e + J·dq = 0   =>   J·dq = -e   =>   JᵀJ·dq = -Jᵀe
          //
          // Getting this wrong does not merely slow convergence, it inverts the search
          // direction: every candidate step increases the cost, step rejection rejects
          // all of them, lambda saturates, and every restart is consumed without
          // improving. The symptom is a solver that reports 0% success with the seed
          // count pinned at its maximum — which is exactly what test/ik.test.mjs saw.
          //
          // Note this differs in sign from the more familiar dq = Jᵀ(JJᵀ + λ²I)⁻¹e,
          // which differences the *pose* rather than the residual.
          const g = [];
          for (let r = 0; r < n; r++) {
            let sum = 0;
            for (let row = 0; row < rows; row++) sum += J[r][row] * e[row];
            g.push(-sum);
          }
          const dq = solveLinear(A, g);
          if (!dq) { lambda *= 8; continue; }

          // Bound the step: an unbounded Newton step on a nearly-singular system throws
          // the arm across its workspace and the solve never recovers.
          const scale = Math.max(...dq.map(Math.abs));
          const limited = scale > 0.5 ? dq.map((v) => (v * 0.5) / scale) : dq;
          const candidate = clamp(q.map((v, k) => v + limited[k]));
          const eNew = residual(candidate);
          const cNew = cost(eNew);
          if (cNew < c) {
            q = candidate; e = eNew; c = cNew;
            lambda = Math.max(lambda * 0.5, 1e-9);
            accepted = true;
          } else {
            lambda *= 8;          // reject and try a smaller, more damped step
          }
        }
        if (!accepted) break;     // fully damped and still no improvement
      }

      const errs = errorsOf(q);
      const score = errs.posErr / Math.max(posTol, 1e-12) + errs.rotErr / Math.max(rotTol, 1e-12);
      if (!best || score < best.score) best = { q: q.slice(), ...errs, score };
      if (errs.posErr <= posTol && errs.rotErr <= rotTol) { reason = 'converged'; break; }
      if (reason === 'stopped' || reason === 'time budget exhausted') break;
    }
  } finally {
    // Whatever happened, put the scene back exactly as it was.
    for (let i = 0; i < savedQpos.length; i++) sim.qpos[i] = savedQpos[i];
    for (let i = 0; i < savedQvel.length; i++) sim.qvel[i] = savedQvel[i];
    sim.forward();
  }

  const success = !!best && best.posErr <= posTol && best.rotErr <= rotTol;
  const solvedQpos = Array.from(savedQpos);
  if (best) for (let k = 0; k < n; k++) solvedQpos[addr[k]] = best.q[k];

  const jointNamesOut = {};
  if (best) {
    for (let k = 0; k < n; k++) jointNamesOut[dofJoints[k]] = best.q[k];
  }

  return {
    success,
    reason: success ? 'converged' : reason,
    qpos: solvedQpos,
    jointValues: jointNamesOut,
    dofJoints,
    posErr: best ? best.posErr : Infinity,
    rotErr: best ? best.rotErr : Infinity,
    iters: totalIters,
    seedsTried,
    ms: elapsed(),
  };
}
