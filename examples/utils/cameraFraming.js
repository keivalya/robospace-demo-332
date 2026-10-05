// examples/utils/cameraFraming.js
//
// Works out where to put the synthetic "Overhead" and "Front" cameras for whatever
// model is loaded.
//
// These two views used to be hardcoded to the Franka workbench -- the overhead camera
// sat 1.25 m above (0.45, 0) and the front camera at (0.95, 0.65, 0) looking at
// (0.45, 0.08, 0), with no reference to the model at all. That frames a tabletop Panda
// and nothing else: for a Unitree G1, a Spot, a drone or any of the other ~70 Menagerie
// entries, two of the three camera entries in the dropdown showed empty space or a
// corner of the robot.
//
// MuJoCo computes exactly the statistics we want (mjStatistic: extent, center), but
// `model.stat_extent` and `model.stat_center` are UNBOUND in this WASM build -- they
// read back `undefined`, like the other embind gaps catalogued in CLAUDE.md. So the
// bounds are derived from geom world positions instead, which are bound and reliable.
//
// Pure and dependency-free (no three.js) so it can be tested in Node, where every
// rendering path is stubbed.

// mjtGeom values we must exclude. A plane is drawn as a hardcoded 100x100 Reflector
// regardless of its geom_size, so including it would swamp the bounds with a number
// that has nothing to do with the robot; an hfield draws nothing at all.
const GEOM_PLANE = 0;
const GEOM_HFIELD = 1;

// Matches the renderer: only geom_group < 3 is drawn, so anything above it is
// collision-only geometry the user never sees and must not frame the shot.
const MAX_VISIBLE_GROUP = 3;

/** Smallest half-extent we will frame, in metres. Stops a degenerate or single-point
 *  model putting the camera inside the robot. */
const MIN_RADIUS = 0.2;

/**
 * Axis-aligned bounds of the geometry a user can actually see, in MuJoCo world
 * coordinates (Z-up, metres).
 *
 * @returns {{center: number[], half: number[], radius: number} | null}
 *   null when the model exposes nothing drawable, so the caller can fall back.
 */
export function computeVisibleBounds(model, simulation) {
  const ngeom = model?.ngeom ?? 0;
  const xpos = simulation?.geom_xpos;
  if (!ngeom || !xpos || xpos.length < ngeom * 3) return null;

  const size = model.geom_size;
  const type = model.geom_type;
  const group = model.geom_group;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let counted = 0;

  for (let i = 0; i < ngeom; i++) {
    const t = type ? type[i] : -1;
    if (t === GEOM_PLANE || t === GEOM_HFIELD) continue;
    if (group && group[i] >= MAX_VISIBLE_GROUP) continue;

    // A scalar stand-in for the geom's own extent. Exact per-type half-extents are
    // not worth it here: this only pads a bounding box used to choose a camera
    // distance, and geom_size is meaningless for meshes anyway (they carry their
    // own bounds), where it reads 0 and the position alone carries the information.
    let r = 0;
    if (size && size.length >= 3 * i + 3) {
      r = Math.max(size[3 * i], size[3 * i + 1], size[3 * i + 2]);
      if (!Number.isFinite(r) || r < 0) r = 0;
    }

    for (let a = 0; a < 3; a++) {
      const p = xpos[3 * i + a];
      if (!Number.isFinite(p)) continue;
      if (p - r < min[a]) min[a] = p - r;
      if (p + r > max[a]) max[a] = p + r;
    }
    counted++;
  }

  if (!counted || !Number.isFinite(min[0]) || !Number.isFinite(max[0])) return null;

  const center = [0, 0, 0];
  const half = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    center[a] = (min[a] + max[a]) / 2;
    half[a] = Math.max((max[a] - min[a]) / 2, 0);
  }
  const radius = Math.max(Math.hypot(half[0], half[1], half[2]), MIN_RADIUS);
  return { center, half, radius };
}

/**
 * Distance at which a sphere of `radius` fits inside a camera's vertical field of view.
 *
 * Vertical is the binding constraint: the picture-in-picture panel is wider than it is
 * tall, so the horizontal fov is the more generous of the two and fitting the vertical
 * one fits both.
 */
export function fitDistance(radius, fovyDeg, margin = 1.35) {
  const fov = Number.isFinite(fovyDeg) && fovyDeg > 1 && fovyDeg < 179 ? fovyDeg : 60;
  const r = Number.isFinite(radius) && radius > 0 ? radius : MIN_RADIUS;
  const d = (r / Math.tan((fov / 2) * Math.PI / 180)) * margin;
  return Math.max(d, 0.15);
}

/** Elevation of the "Front" camera above the horizontal, in radians. Shallow enough to
 *  read as a spectator view rather than a second top-down. */
const FRONT_ELEVATION = 22 * Math.PI / 180;

/**
 * Camera placement for the two synthetic views, in MuJoCo world coordinates.
 *
 * @returns {{position: number[], target: number[]} | null}
 */
export function framingFor(virtualType, bounds, fovyDeg) {
  if (!bounds) return null;
  const { center, radius } = bounds;
  const d = fitDistance(radius, fovyDeg);

  if (virtualType === 'overhead') {
    return { position: [center[0], center[1], center[2] + d], target: [...center] };
  }
  if (virtualType === 'front') {
    // Along +X, which is the direction a Menagerie arm conventionally faces.
    return {
      position: [
        center[0] + d * Math.cos(FRONT_ELEVATION),
        center[1],
        center[2] + d * Math.sin(FRONT_ELEVATION),
      ],
      target: [...center],
    };
  }
  return null;
}
