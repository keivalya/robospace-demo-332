// Quaternion / rotation-matrix helpers.
//
//   npm run test:mjmath
//
// Pure functions with no MuJoCo or three.js involvement, so this is the one part of the
// task-space work that is fully verifiable offline. Worth testing carefully because
// every error here is silent: a wrong sign yields a gripper that approaches from the
// wrong side, and the naive matrix→quaternion formula loses all precision at exactly
// the 180° rotation a downward-pointing tool needs.

import {
  quatNormalize, quatConj, quatMul, quatFromAxisAngle,
  matToQuat, quatToMat, matCol, quatToRotVec, quatAngle, toolDownQuat,
} from '../examples/utils/mjmath.js';

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));
const close = (a, b, m, tol = 1e-9) => check(Math.abs(a - b) < tol, `${m} (${a} vs ${b})`);
const vclose = (a, b, m, tol = 1e-9) => {
  const worst = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  check(worst < tol, `${m} (max diff ${worst.toExponential(1)})`);
};
/** Quaternions are double-covered: q and -q are the same rotation. */
const qclose = (a, b, m, tol = 1e-9) => {
  const d1 = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  const d2 = Math.max(...a.map((v, i) => Math.abs(v + b[i])));
  check(Math.min(d1, d2) < tol, `${m} (min diff ${Math.min(d1, d2).toExponential(1)})`);
};

const IDENTITY_Q = [1, 0, 0, 0];
const IDENTITY_M = [1, 0, 0, 0, 1, 0, 0, 0, 1];

console.log('basics');
{
  vclose(quatNormalize([2, 0, 0, 0]), IDENTITY_Q, 'normalize scales to unit length');
  vclose(quatNormalize([0, 0, 0, 0]), IDENTITY_Q, 'a zero quaternion degrades to identity');
  vclose(quatConj([1, 2, 3, 4]), [1, -2, -3, -4], 'conjugate negates the vector part');
  vclose(quatMul(IDENTITY_Q, [0.5, 0.5, 0.5, 0.5]), [0.5, 0.5, 0.5, 0.5], 'identity is neutral');
  vclose(quatMul([0, 1, 0, 0], quatConj([0, 1, 0, 0])), IDENTITY_Q, 'q * conj(q) is identity');
  vclose(quatToMat(IDENTITY_Q), IDENTITY_M, 'identity quaternion is the identity matrix');
  qclose(matToQuat(IDENTITY_M), IDENTITY_Q, 'identity matrix is the identity quaternion');
}

console.log('\naxis-angle');
{
  // 90 deg about Z takes +X to +Y.
  const q = quatFromAxisAngle([0, 0, 1], Math.PI / 2);
  const m = quatToMat(q);
  vclose(matCol(m, 0), [0, 1, 0], '90 deg about Z maps x to +y');
  vclose(matCol(m, 1), [-1, 0, 0], 'and y to -x');
  vclose(matCol(m, 2), [0, 0, 1], 'leaving z alone');

  vclose(quatFromAxisAngle([0, 0, 0], 1), IDENTITY_Q, 'a zero axis degrades to identity');
  // The axis need not be normalised.
  qclose(quatFromAxisAngle([0, 0, 7], Math.PI / 2), q, 'an unnormalised axis gives the same rotation');
}

console.log('\nmatrix <-> quaternion round-trips, including the 180 deg branches');
{
  // The whole reason for Shepperd's branching: sqrt(1 + trace) collapses at 180 deg,
  // and a tool pointing straight down IS a 180 deg rotation.
  const cases = [
    ['identity', [1, 0, 0, 0]],
    ['180 about X', [0, 1, 0, 0]],
    ['180 about Y', [0, 0, 1, 0]],
    ['180 about Z', [0, 0, 0, 1]],
    ['90 about X', quatFromAxisAngle([1, 0, 0], Math.PI / 2)],
    ['120 about (1,1,1)', quatFromAxisAngle([1, 1, 1], (2 * Math.PI) / 3)],
    ['179.9 about Y', quatFromAxisAngle([0, 1, 0], Math.PI * 0.99944)],
    ['tiny, 1e-7 about Z', quatFromAxisAngle([0, 0, 1], 1e-7)],
  ];
  for (const [label, q] of cases) {
    qclose(matToQuat(quatToMat(q)), q, `${label} survives quat -> mat -> quat`, 1e-7);
  }

  // Deterministic sweep, so this cannot pass by luck of the chosen cases.
  let worst = 0;
  for (let i = 0; i < 400; i++) {
    const t = i / 400;
    const q = quatNormalize([
      Math.cos(t * 11), Math.sin(t * 7), Math.cos(t * 5) * 0.5, Math.sin(t * 13) * 0.25,
    ]);
    const back = matToQuat(quatToMat(q));
    const d = Math.min(
      Math.max(...q.map((v, k) => Math.abs(v - back[k]))),
      Math.max(...q.map((v, k) => Math.abs(v + back[k]))),
    );
    if (d > worst) worst = d;
  }
  check(worst < 1e-9, `400-orientation sweep round-trips (worst ${worst.toExponential(1)})`);
}

console.log('\nrotation vectors');
{
  vclose(quatToRotVec(IDENTITY_Q), [0, 0, 0], 'no rotation is a zero vector');
  vclose(quatToRotVec(quatFromAxisAngle([0, 0, 1], 0.4)), [0, 0, 0.4], 'axis times angle');
  // Shortest arc: -q is the same rotation and must give the same vector.
  const q = quatFromAxisAngle([0, 1, 0], 0.3);
  vclose(quatToRotVec(q.map((v) => -v)), quatToRotVec(q),
    'a negated quaternion gives the same rotation vector');
  // A rotation past 180 deg must come back as the short way round, not the long one.
  const big = quatFromAxisAngle([0, 0, 1], Math.PI * 1.5);
  close(Math.hypot(...quatToRotVec(big)), Math.PI * 0.5, 'a 270 deg rotation reads as 90 deg');

  close(quatAngle(IDENTITY_Q, IDENTITY_Q), 0, 'angle to itself is zero');
  close(quatAngle(IDENTITY_Q, quatFromAxisAngle([1, 0, 0], 0.75)), 0.75, 'angle recovers the rotation');
  close(quatAngle(quatFromAxisAngle([0, 1, 0], 1.0), quatFromAxisAngle([0, 1, 0], 1.3)), 0.3,
    'angle between two rotations about the same axis');
}

console.log('\ntoolDownQuat');
{
  // The property that matters: the frame's own z-axis points at world -Z, so a gripper
  // in this orientation approaches from above.
  for (const yaw of [0, 0.3, Math.PI / 2, -1.1, Math.PI]) {
    const m = quatToMat(toolDownQuat(yaw));
    vclose(matCol(m, 2), [0, 0, -1], `yaw=${yaw.toFixed(2)}: local z points down`, 1e-9);
    // Still a proper rotation, not a reflection.
    const [x, y, z] = [matCol(m, 0), matCol(m, 1), matCol(m, 2)];
    const det = x[0] * (y[1] * z[2] - y[2] * z[1])
      - y[0] * (x[1] * z[2] - x[2] * z[1])
      + z[0] * (x[1] * y[2] - x[2] * y[1]);
    close(det, 1, `yaw=${yaw.toFixed(2)}: determinant is +1`);
  }
  // yaw=0 closes the fingers along world Y (the Panda hand slides its fingers on
  // local y), which is what the verified top-down grasp relies on.
  vclose(matCol(quatToMat(toolDownQuat(0)), 1), [0, 1, 0], 'yaw=0 puts local y along world +y');
  vclose(matCol(quatToMat(toolDownQuat(Math.PI / 2)), 1), [-1, 0, 0],
    'yaw=90 deg rotates the grasp axis to world -x');
}

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
