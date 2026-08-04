// examples/utils/mjmath.js
//
// Quaternion and rotation-matrix helpers, in MuJoCo's conventions.
//
// Two reasons this file exists rather than calling into the WASM:
//
// 1. `site_xquat` does not exist. MuJoCo stores site orientation only as `site_xmat`,
//    so a site's quaternion has to be derived — and sites are how a scene marks a tool
//    tip, which makes this the single most important pose to be able to read.
//
// 2. The `mju_*` quaternion helpers that *are* bound (`mju_mulQuat`, `mju_quat2Mat`,
//    `normalizeQuat`, `differentiatePos`, ...) take **raw wasm pointers**: the bindings
//    do `reinterpret_cast<mjtNum*>(v["byteOffset"])`. Handing them a JS-heap
//    Float64Array reads garbage out of wasm memory rather than throwing. Avoid them
//    entirely.
//
// CONVENTIONS, which differ from the renderer's on purpose:
//   * Quaternions are [w, x, y, z] — MuJoCo's order, not three.js's [x, y, z, w].
//   * Matrices are 9 elements, ROW-major, matching mjData.xmat / site_xmat.
//   * Frames are raw MuJoCo: Z-up, metres. `getPosition`/`getQuaternion` in
//     mujocoUtils.js swizzle to three.js's Y-up for rendering; nothing here does,
//     because a script's coordinates must agree with the scene XML's.

export function quatNormalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(n > 0)) return [1, 0, 0, 0];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function quatConj(q) {
  return [q[0], -q[1], -q[2], -q[3]];
}

/** Hamilton product. quatMul(a, b) applies b first, then a. */
export function quatMul(a, b) {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export function quatFromAxisAngle(axis, angle) {
  const n = Math.hypot(axis[0], axis[1], axis[2]);
  if (!(n > 0)) return [1, 0, 0, 0];
  const h = angle / 2;
  const s = Math.sin(h) / n;
  return [Math.cos(h), axis[0] * s, axis[1] * s, axis[2] * s];
}

/**
 * Rotation matrix (row-major 9) → quaternion.
 *
 * Shepperd's method: pick the branch with the largest denominator. The naive
 * trace-only formula divides by sqrt(1 + trace), which goes to zero at a 180° rotation
 * and loses all precision near it — and 180° is not exotic here, it is exactly the
 * orientation of a gripper pointing straight down.
 */
export function matToQuat(m) {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const trace = m00 + m11 + m22;

  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return quatNormalize([0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s]);
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return quatNormalize([(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s]);
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return quatNormalize([(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s]);
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return quatNormalize([(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s]);
}

/** Quaternion → rotation matrix (row-major 9). */
export function quatToMat(q) {
  const [w, x, y, z] = quatNormalize(q);
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** Column j (0,1,2) of a row-major 9 matrix — i.e. the frame's local axis in world. */
export function matCol(m, j) {
  return [m[j], m[3 + j], m[6 + j]];
}

/**
 * Quaternion → rotation vector (axis × angle).
 *
 * This is the form an IK residual needs: three numbers that go to zero as the
 * orientation error does. Negating a quaternion with w < 0 first picks the shorter of
 * the two arcs, without which the error can point the long way round and the solver
 * walks away from the target.
 */
export function quatToRotVec(q) {
  let [w, x, y, z] = quatNormalize(q);
  if (w < 0) { w = -w; x = -x; y = -y; z = -z; }
  const n = Math.hypot(x, y, z);
  if (n < 1e-12) return [0, 0, 0];
  const angle = 2 * Math.atan2(n, w);
  const s = angle / n;
  return [x * s, y * s, z * s];
}

/** Smallest angle in radians between two orientations. */
export function quatAngle(a, b) {
  const d = quatMul(b, quatConj(a));
  return Math.hypot(...quatToRotVec(d));
}

/**
 * Orientation for a top-down grasp: the frame's z-axis points at world -Z, rotated
 * `yaw` about world Z.
 *
 * Worth a named helper because it is the orientation almost every pick wants and it is
 * where people give up — writing this quaternion by hand is unpleasant, and getting it
 * wrong produces a gripper that approaches sideways with no obvious reason why.
 *
 * The base is a 180° rotation about Y, which maps z → -z and x → -x, leaving y alone.
 * For an axis-aligned box, yaw=0 closes the fingers along world Y.
 */
export function toolDownQuat(yaw = 0) {
  return quatMul(quatFromAxisAngle([0, 0, 1], yaw), [0, 0, 1, 0]);
}
