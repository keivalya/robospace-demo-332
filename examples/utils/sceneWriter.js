// examples/utils/sceneWriter.js
//
// Writes a generated scene into MEMFS and loads it. This is the single code path
// shared by the agent (ParentBridge → APPLY_SCENE) and the console helper
// window.robospaceLoadRobot(), so what you verify by hand is what the agent runs.

import { ensureRobotPack } from './robotPacks.js';
import { readModelNames } from '../mujocoUtils.js';

export function ensureDir(FS, dirPath) {
  if (!dirPath || dirPath === '/' || FS.analyzePath(dirPath).exists) return;
  ensureDir(FS, dirPath.substring(0, dirPath.lastIndexOf('/')));
  try { FS.mkdir(dirPath); } catch (e) {
    if (!FS.analyzePath(dirPath).exists) throw e;
  }
}

export function ensureParentDirs(FS, filePath) {
  const cut = filePath.lastIndexOf('/');
  if (cut > 0) ensureDir(FS, filePath.substring(0, cut));
}

export function rmrf(FS, dirPath) {
  if (!FS.analyzePath(dirPath).exists) return;
  for (const name of FS.readdir(dirPath).filter((n) => n !== '.' && n !== '..')) {
    const full = `${dirPath}/${name}`;
    if (FS.isDir(FS.stat(full).mode)) {
      rmrf(FS, full);
      try { FS.rmdir(full); } catch (_) { /* best effort */ }
    } else {
      try { FS.unlink(full); } catch (_) { /* best effort */ }
    }
  }
}

// ─── untrusted input ────────────────────────────────────────────────────────
// sceneName and file paths arrive from a model's tool call. They are used to build
// MEMFS paths that get rmrf'd and written, so they are the highest-consequence
// untrusted input in this module: a name that escapes its directory turns a scene
// write into a delete of whatever is above it.

const SAFE_SCENE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A scene name must be a single, ordinary directory name.
 *
 * The earlier check only rejected unexpected *characters*, which let "." and ".."
 * through — both are made entirely of allowed characters. `custom_scenes/..`
 * resolves to `custom_scenes`'s parent, and `custom_scenes/.` to the directory
 * holding every other saved scene, so either one aimed the rmrf at the wrong tree.
 * Reject path semantics, not just characters.
 */
export function assertSafeSceneName(sceneName) {
  if (typeof sceneName !== 'string' || !sceneName) {
    throw new Error('sceneName is required.');
  }
  if (sceneName.length > 64) {
    throw new Error(`sceneName "${sceneName.slice(0, 32)}…" is too long (max 64 characters).`);
  }
  if (!SAFE_SCENE_NAME.test(sceneName) || sceneName.includes('..')) {
    throw new Error(
      `Invalid sceneName "${sceneName}": must start with a letter or digit and contain only `
      + 'letters, digits, dot, dash or underscore. It is a single directory name, not a path.',
    );
  }
}

/**
 * Normalises a model-supplied file path to something guaranteed to stay inside the
 * scene directory. Rejects absolute paths, backslashes, and any "." or ".." segment
 * rather than pattern-matching on substrings — `a/../../b` contains no leading ".."
 * but still escapes.
 */
export function safeRelativePath(input) {
  const raw = String(input ?? '');
  if (!raw) throw new Error('File entry is missing a path.');
  if (raw.includes('\\')) {
    throw new Error(`Invalid file path "${raw}": use forward slashes.`);
  }
  if (raw.startsWith('/')) {
    throw new Error(`Invalid file path "${raw}": must be relative to the scene directory.`);
  }
  const segments = raw.split('/').filter((s) => s !== '');
  if (!segments.length) throw new Error(`Invalid file path "${raw}".`);
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new Error(`Refusing to write outside the scene directory: "${raw}".`);
    }
  }
  return segments.join('/');
}

/**
 * Resolves a caller-supplied entryXmlPath to a path inside this scene's directory.
 *
 * Callers legitimately pass any of three forms — "scene.xml",
 * "custom_scenes/<name>/scene.xml" (what a previous call returned), or the full
 * "/working/custom_scenes/<name>/scene.xml" — so all three are accepted by
 * trimming a recognised prefix and validating what remains.
 *
 * Note what is deliberately NOT done: a leading slash is not stripped in general.
 * An earlier version did, which defeated safeRelativePath's absolute-path check —
 * "/working/universal_robots_ur5e/scene.xml" was silently re-rooted to
 * "custom_scenes/<name>/working/universal_robots_ur5e/scene.xml" instead of being
 * refused. Confined, but wrong: it turns a caller mistake into a confusing
 * "entry file was not written" failure later. Only a prefix that actually names
 * this scene's directory is removed; anything else absolute is rejected.
 *
 * Exported so the tests exercise this function rather than a reimplementation of
 * it — the duplicate is how the bug above went unnoticed.
 */
export function resolveEntryXmlPath(entryXmlPath, sceneDir) {
  const raw = String(entryXmlPath ?? '');
  if (!raw) throw new Error('entryXmlPath is empty.');
  for (const prefix of [`${sceneDir}/`, `/${sceneDir}/`, `/working/${sceneDir}/`]) {
    if (raw.startsWith(prefix)) {
      return `${sceneDir}/${safeRelativePath(raw.slice(prefix.length))}`;
    }
  }
  return `${sceneDir}/${safeRelativePath(raw)}`;
}

/** Everything the agent needs to write a controller script against the real model
 *  rather than against guessed actuator names. */
export function readModelStats(model) {
  const { actuatorNames, jointNames } = readModelNames(model);
  return {
    nq: model.nq,
    nv: model.nv,
    nu: model.nu,
    nbody: model.nbody,
    ngeom: model.ngeom,
    actuatorNames,
    jointNames,
  };
}

/**
 * @param {RoboSpaceDemo} demo
 * @param {object} spec
 * @param {string} spec.sceneName            Directory name under custom_scenes/.
 * @param {string} [spec.robotPack]          Registry id, e.g. "stretch_3".
 * @param {{path:string,content:string|Uint8Array}[]} [spec.files]
 *                                           Generated files, paths relative to the scene dir.
 * @param {string} [spec.entryXmlPath]       Defaults to "<sceneName>/scene.xml".
 * @param {Function} [spec.onProgress]       Forwarded to ensureRobotPack.
 * @param {object|number} [spec.settle]      Passed to settle(); see below.
 * @returns {Promise<{ entryXmlPath: string, sceneDir: string, modelStats: object,
 *                    patched: object[], packPaths: string[] }>}
 *   packPaths are the robot's own files, relative to sceneDir. The caller needs them
 *   to keep the pack out of snapshots — a snapshot that inlines Stretch is 73 MB.
 */
export async function writeGeneratedScene(demo, spec) {
  const { sceneName, robotPack = null, files = [], onProgress = null } = spec;
  assertSafeSceneName(sceneName);

  const FS = demo.mujoco.FS;
  const sceneDir = `custom_scenes/${sceneName}`;
  const root = `/working/${sceneDir}`;

  // Start clean so a re-run cannot inherit a stale file from a previous attempt —
  // during a repair loop that would silently keep a scene compiling off an old
  // asset the model has already removed.
  rmrf(FS, root);
  ensureDir(FS, root);

  let patched = [];
  let homePose = null;
  let packPaths = [];
  if (robotPack) {
    ({ patched, homePose, paths: packPaths } =
      await ensureRobotPack(demo.mujoco, robotPack, sceneDir, { onProgress }));
  }

  for (const file of files) {
    const rel = safeRelativePath(file.path);
    const full = `${root}/${rel}`;
    ensureParentDirs(FS, full);
    FS.writeFile(full, typeof file.content === 'string'
      ? new TextEncoder().encode(file.content)
      : file.content);
  }

  // entryXmlPath decides what gets compiled and what params.scene points at, so it
  // has to be confined to this scene's directory too. Nothing passes it today, but
  // APPLY_SCENE will forward it straight from the agent's payload, and an
  // unvalidated "../../foo.xml" would aim the compile anywhere in MEMFS.
  const entryXmlPath = spec.entryXmlPath
    ? resolveEntryXmlPath(spec.entryXmlPath, sceneDir)
    : `${sceneDir}/scene.xml`;
  if (!FS.analyzePath(`/working/${entryXmlPath}`).exists) {
    throw new Error(`Entry file ${entryXmlPath} was not written.`);
  }

  demo.params.scene = entryXmlPath;
  await demo.reloadScene();      // throws MJCF_COMPILE_ERROR with the diagnostic

  applyHomePose(demo, homePose);
  const settled = settle(demo, spec.settle);

  return {
    entryXmlPath,
    sceneDir,
    modelStats: readModelStats(demo.model),
    patched,
    homePose,
    settled,
    robotPack,
    packPaths,
  };
}

/**
 * Runs the simulation forward before the first frame is drawn, so the scene
 * appears at rest instead of visibly lurching.
 *
 * Even from a correct home pose there is an unavoidable startup transient: a
 * fresh mjData has every joint exactly at its target with zero velocity, and the
 * first few steps resolve initial contact and gravity all at once. Measured on
 * Stretch 3, joint_wrist_pitch peaks at 24.6 rad/s on the second timestep and the
 * base yaws ~5° before coming to rest — all of it inside the first half second,
 * which reads as the robot twitching or spinning as it spawns. Panda's arm sags
 * onto its position targets over a similar window.
 *
 * Stepping headlessly is cheap (a few hundred steps of wall time) and makes the
 * first rendered frame the settled one.
 */
export function settle(demo, opts = {}) {
  const { maxSeconds = 3.0, restThreshold = 1e-2, chunk = 25 } =
    typeof opts === 'number' ? { maxSeconds: opts } : opts;
  if (!demo.simulation || !demo.model || !(maxSeconds > 0)) return { steps: 0, seconds: 0, atRest: false };

  const timestep = demo.model.getOptions().timestep || 0.002;
  const budget = Math.min(Math.round(maxSeconds / timestep), 5000);   // cap: never hang the tab

  // Stop as soon as it is actually at rest rather than after a fixed time: the
  // two robots need very different amounts. Panda quiets down in ~0.2 s, while
  // Stretch's lift has to travel 0.6 m to reach its home target and is still
  // moving at 0.5 s. A fixed window either wastes time or shows a moving robot.
  let steps = 0;
  let atRest = false;
  try {
    while (steps < budget) {
      const n = Math.min(chunk, budget - steps);
      for (let i = 0; i < n; i++) demo.simulation.step();
      steps += n;
      let peak = 0;
      const qvel = demo.simulation.qvel;
      for (let i = 0; i < qvel.length; i++) {
        const a = Math.abs(qvel[i]);
        if (a > peak) peak = a;
      }
      if (peak < restThreshold) { atRest = true; break; }
    }
    demo.simulation.forward();
  } catch (e) {
    console.warn('[sceneWriter] settling failed:', e);
    return { steps: 0, seconds: 0, atRest: false };
  }
  // Keep the demo's own clock in step with the simulation it is about to render,
  // otherwise render() sees a large gap and its catch-up loop resyncs instead of
  // stepping (examples/main.js render()).
  if (typeof demo.mujoco_time === 'number') demo.mujoco_time = 0.0;
  return { steps, seconds: steps * timestep, atRest };
}

/**
 * Puts the robot into its home pose by writing state, since the <keyframe> that
 * used to carry it has been removed (see robotPacks.extractAndStripKeyframes —
 * leaving it in aborts mj_makeData as soon as the scene adds a joint).
 *
 * Writing only the leading values is what makes this safe: an <include> placed
 * first means the robot's bodies are created first, so its qpos/ctrl occupy the
 * leading slots and anything the scene adds lands after them. That ordering is
 * why generated scenes must keep <include> as the first element.
 *
 * Without this, robots spawn at qpos0 and visibly lurch: Panda's arm starts
 * straight out and sags ~0.19 rad against its position actuators, and Stretch
 * drifts ~2.4° of yaw before settling.
 */
export function applyHomePose(demo, homePose) {
  if (!homePose || !demo.simulation || !demo.model) return false;
  const { qpos, ctrl } = homePose;
  try {
    if (qpos && qpos.length) {
      demo.simulation.qpos.set(qpos.slice(0, Math.min(qpos.length, demo.model.nq)), 0);
    }
    if (ctrl && ctrl.length) {
      demo.simulation.ctrl.set(ctrl.slice(0, Math.min(ctrl.length, demo.model.nu)), 0);
    }
    // qvel stays zero: mj_makeData zeroes it, and a fresh scene should start at rest.
    demo.simulation.forward();
    return true;
  } catch (e) {
    // A pose that no longer fits the model is not worth failing a load over.
    console.warn('[sceneWriter] could not apply home pose:', e);
    return false;
  }
}

/** A minimal scene that just stands a registry robot on a checkered floor.
 *  Mirrors examples/scenes/universal_robots_ur5e/scene.xml: no <compiler> here,
 *  because the included robot supplies it. */
export function defaultRobotScene(robotEntryXml, modelName = 'robospace scene') {
  return `<mujoco model="${modelName}">
  <include file="${robotEntryXml}"/>

  <statistic center="0.3 0 0.4" extent="1.2"/>

  <visual>
    <headlight diffuse="0.6 0.6 0.6" ambient="0.1 0.1 0.1" specular="0 0 0"/>
    <rgba haze="0.15 0.25 0.35 1"/>
    <global azimuth="120" elevation="-20"/>
  </visual>

  <asset>
    <texture type="skybox" builtin="gradient" rgb1="0.3 0.5 0.7" rgb2="0 0 0" width="512" height="3072"/>
    <texture type="2d" name="groundplane" builtin="checker" mark="edge" rgb1="0.2 0.3 0.4" rgb2="0.1 0.2 0.3"
      markrgb="0.8 0.8 0.8" width="300" height="300"/>
    <material name="groundplane" texture="groundplane" texuniform="true" texrepeat="5 5" reflectance="0.2"/>
  </asset>

  <worldbody>
    <light pos="0 0 3" dir="0 0 -1" directional="true"/>
    <geom name="floor" size="0 0 0.05" type="plane" material="groundplane"/>
  </worldbody>
</mujoco>
`;
}
