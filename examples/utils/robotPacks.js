// examples/utils/robotPacks.js
//
// Fetches a robot's MJCF and meshes from mujoco_menagerie into the simulator's
// MEMFS, so a generated scene can `<include>` a real robot instead of an
// approximation built from primitives.
//
// Three things here are load-bearing and easy to get wrong:
//
// 1. WHERE the files land. MuJoCo resolves <compiler assetdir="assets"> relative
//    to the directory of the *main* model file, so the robot XML and the
//    generated scene.xml must be siblings, with assets/ beside them. That is
//    exactly how examples/scenes/universal_robots_ur5e/scene.xml works.
//
// 2. Bytes, not text. Every file is written as a Uint8Array from arrayBuffer().
//    downloadExampleScenesFolder() keeps an extension allowlist for this and it
//    misses .jpg/.msh, which then load corrupted. Treating everything as bytes
//    removes the whole class of bug — .obj and .xml are equally happy as bytes.
//
// 3. jsDelivr has a 20 MB per-file cap and 403s above it. stretch_3's
//    assets/base_link_8.obj is 21.1 MB, so it must come from raw.githubusercontent
//    instead. The manifest pre-marks those with `viaRaw`; we also fall back on
//    any unexpected CDN failure rather than losing the whole pack to one file.
//
// Packs are large (Panda 32.7 MB, Stretch 3 72.8 MB), so decoded bytes are cached
// in IndexedDB keyed by the pinned commit — the second load of a robot is local.

import { MENAGERIE_COMMIT, ROBOT_MANIFESTS } from './robotManifests.js';

const REPO = 'google-deepmind/mujoco_menagerie';
const CONCURRENCY = 8;
const DB_NAME = 'robospace_robot_packs';
const STORE = 'files';

export { MENAGERIE_COMMIT, ROBOT_MANIFESTS };

export function listRobotPacks() {
  return Object.keys(ROBOT_MANIFESTS);
}

function cdnUrl(upstreamDir, filePath) {
  return `https://cdn.jsdelivr.net/gh/${REPO}@${MENAGERIE_COMMIT}/${upstreamDir}/${filePath}`;
}

// Same commit, different host: raw.githubusercontent has no file-size cap and
// also sends access-control-allow-origin: *, so it works cross-origin.
function rawUrl(upstreamDir, filePath) {
  return `https://raw.githubusercontent.com/${REPO}/${MENAGERIE_COMMIT}/${upstreamDir}/${filePath}`;
}

// ─── IndexedDB cache ────────────────────────────────────────────────────────
// Deliberately best-effort: any failure (private browsing, quota, no IndexedDB)
// degrades to re-fetching rather than breaking the load.

function openDb() {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (_) { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function idbGet(db, key) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}

function idbPut(db, key, value) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch (_) { resolve(false); }
  });
}

/** IndexedDB-backed byte cache. Swap for a Map in tests via opts.cache. */
export function createIdbCache() {
  let dbPromise = null;
  const db = () => (dbPromise ||= openDb());
  return {
    async get(key) {
      const handle = await db();
      if (!handle) return null;
      const stored = await idbGet(handle, key);
      return stored ? new Uint8Array(stored) : null;
    },
    async set(key, bytes) {
      const handle = await db();
      if (!handle) return;
      // Store a plain ArrayBuffer — structured clone of a typed-array view can
      // drag the whole backing buffer along with it.
      await idbPut(handle, key, bytes.slice().buffer);
    },
  };
}

// ─── per-pack XML patches ───────────────────────────────────────────────────

/**
 * Removes image-file textures and de-references them from materials.
 *
 * Why this is necessary: the shipped MuJoCo WASM build cannot load a texture
 * from an image file. Every `<texture file="...">` fails to compile — verified
 * across all 11 of stretch_3's PNGs and against ur5e.png, at several sizes and
 * both RGB and RGBA — while procedural `builtin` textures work. The bundled
 * ur5e.xml happens to declare no file textures, which is why the limitation was
 * never noticed. Without this patch stretch_3 simply cannot be loaded.
 *
 * The visual cost is small and confined: Stretch's PNGs are ArUco fiducial
 * stickers and two label decals. The affected materials keep their geometry and
 * fall back to flat shading. Kinematics, actuators and dynamics are untouched.
 *
 * Regex rather than DOMParser on purpose: this runs against a commit-pinned
 * upstream file, so the input is fixed, and it keeps the module usable outside a
 * browser (the pack tests run under Node). test/robot-packs.test.mjs asserts the
 * patched XML actually compiles, so a silent mismatch cannot slip through.
 */
export function stripFileTextures(xml) {
  const dropped = new Set();

  const handleTextureTag = (tag) => {
    const file = /\bfile\s*=\s*"([^"]*)"/.exec(tag);
    if (!file) return tag;                       // builtin/procedural: keep as-is
    const explicit = /\bname\s*=\s*"([^"]*)"/.exec(tag);
    const name = explicit
      ? explicit[1]
      : (file[1].split(/[\\/]/).pop() || '').replace(/\.[^.]+$/, '');
    if (name) dropped.add(name);
    return `<!-- robospace: removed <texture file="${file[1]}"> (image-file textures are unsupported by this MuJoCo build) -->`;
  };

  let out = xml
    .replace(/<texture\b[^>]*?\/>/g, handleTextureTag)
    .replace(/<texture\b[^>]*?>[\s\S]*?<\/texture>/g, handleTextureTag);

  if (dropped.size) {
    // A material pointing at a texture we just removed would itself fail to
    // resolve, so drop only that attribute and leave the material intact.
    out = out.replace(/<material\b[^>]*?\/?>/g, (tag) => {
      const ref = /\btexture\s*=\s*"([^"]*)"/.exec(tag);
      if (!ref || !dropped.has(ref[1])) return tag;
      return tag.replace(/\s*\btexture\s*=\s*"[^"]*"/, '');
    });
  }

  return { xml: out, dropped: [...dropped] };
}

/**
 * Extracts the first <key> pose, then removes the whole <keyframe> block.
 *
 * This is not an optimisation — it is required for correctness. A keyframe's qpos
 * is sized for the robot's own nq. If a scene includes the robot and then adds any
 * joint of its own, MuJoCo compiles happily with the larger nq but mj_makeData
 * then overruns the keyframe buffer and aborts the entire WASM module
 * ("mj_stackAlloc: out of memory, stack overflow", max = 0). Reproduced with
 * Panda plus a single hinge joint (nq 9 → 10), and with a free-jointed cube
 * (nq → 16); stripping the keyframe fixes both. In the browser that abort kills
 * the simulator until the page is reloaded, and it would fire for any generated
 * scene containing a movable object — which is most of them.
 *
 * The pose itself is still worth having: starting from qpos0 leaves Panda's arm
 * extended straight out, where gravity sags it ~0.19 rad against the position
 * actuators' zero targets, and leaves Stretch settling ~2.4° of yaw. So we keep
 * the values and apply them as state after loading instead (see
 * sceneWriter.writeGeneratedScene), which is equivalent for a fresh scene and
 * safe no matter how many bodies the scene adds.
 */
export function extractAndStripKeyframes(xml) {
  let homePose = null;

  const blocks = xml.match(/<keyframe\b[\s\S]*?<\/keyframe>/g) || [];
  for (const block of blocks) {
    const key = /<key\b([^>]*)>/.exec(block) || /<key\b([^>]*)\/>/.exec(block);
    if (!key) continue;
    const attrs = key[1];
    const nums = (name) => {
      const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
      if (!m) return null;
      const parsed = m[1].trim().split(/\s+/).filter(Boolean).map(Number);
      return parsed.some((n) => !Number.isFinite(n)) ? null : parsed;
    };
    // A keyframe may specify qpos, ctrl, or both. Stretch 3's "home" and "stow"
    // keys carry ctrl only — the pose is expressed as actuator targets (lift
    // 0.6, arm 0.1) that the position actuators then drive to. Requiring qpos
    // here silently dropped Stretch's home pose entirely.
    const qpos = nums('qpos');
    const ctrl = nums('ctrl');
    if (!qpos && !ctrl) continue;
    const nameMatch = /\bname\s*=\s*"([^"]*)"/.exec(attrs);
    homePose = { name: nameMatch ? nameMatch[1] : null, qpos: qpos || [], ctrl: ctrl || [] };
    break;   // first keyframe only — conventionally "home"
  }

  const stripped = xml.replace(
    /<keyframe\b[\s\S]*?<\/keyframe>/g,
    '<!-- robospace: <keyframe> removed; its pose is applied as state after load, because a keyframe sized for the robot\'s nq aborts mj_makeData once the scene adds any joint -->',
  );
  return { xml: stripped, homePose };
}

/** Applies every patch a pack needs. Returns the rewritten XML plus what changed. */
function patchRobotXml(packId, xml) {
  const notes = [];
  let out = xml;

  if (PACKS_NEEDING_TEXTURE_STRIP.has(packId)) {
    const res = stripFileTextures(out);
    out = res.xml;
    if (res.dropped.length) notes.push(`removed ${res.dropped.length} image-file texture(s)`);
  }

  // Applies to every pack: the crash is a property of keyframes, not of a robot.
  const kf = extractAndStripKeyframes(out);
  out = kf.xml;
  if (kf.homePose) notes.push(`captured home pose "${kf.homePose.name || 'unnamed'}" and removed <keyframe>`);

  return { xml: out, notes, homePose: kf.homePose, dropped: [] };
}

const PACKS_NEEDING_TEXTURE_STRIP = new Set(['stretch_3']);

const isXml = (path) => /\.xml$/i.test(path);

// ─── MEMFS helpers ──────────────────────────────────────────────────────────

function ensureDir(FS, dirPath) {
  if (!dirPath || dirPath === '/' || FS.analyzePath(dirPath).exists) return;
  ensureDir(FS, dirPath.substring(0, dirPath.lastIndexOf('/')));
  try { FS.mkdir(dirPath); } catch (e) {
    if (!FS.analyzePath(dirPath).exists) throw e;
  }
}

// ─── fetching ───────────────────────────────────────────────────────────────

async function fetchBytes(fetchImpl, upstreamDir, file) {
  const attempts = file.viaRaw
    ? [rawUrl(upstreamDir, file.path)]
    : [cdnUrl(upstreamDir, file.path), rawUrl(upstreamDir, file.path)];

  let lastError = null;
  for (const url of attempts) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) { lastError = new Error(`HTTP ${res.status} for ${url}`); continue; }
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`Could not download ${file.path}: ${lastError ? lastError.message : 'unknown error'}`);
}

/**
 * Writes a robot pack into `/working/<sceneDir>/`, fetching whatever is not cached.
 *
 * @param {object} mujoco                The mujoco module (for mujoco.FS).
 * @param {string} packId                Key into ROBOT_MANIFESTS.
 * @param {string} sceneDir              MEMFS dir relative to /working, e.g. "custom_scenes/kitchen".
 * @param {object} [opts]
 * @param {(p: {done:number,total:number,bytes:number,totalBytes:number,path:string}) => void} [opts.onProgress]
 * @param {{get:Function,set:Function}} [opts.cache]   Defaults to IndexedDB.
 * @param {Function} [opts.fetchImpl]                  Defaults to global fetch.
 * @returns {Promise<{ entry: string, paths: string[] }>} entry is relative to sceneDir.
 */
export async function ensureRobotPack(mujoco, packId, sceneDir, opts = {}) {
  // Own-property lookup only: packId comes from a model tool call, and a bare index
  // would resolve "__proto__" or "constructor" to something truthy, sailing past
  // the guard below and then failing deeper in with a confusing error.
  const manifest = Object.prototype.hasOwnProperty.call(ROBOT_MANIFESTS, packId)
    ? ROBOT_MANIFESTS[packId]
    : null;
  if (!manifest) {
    throw new Error(`Unknown robot pack "${packId}". Available: ${listRobotPacks().join(', ')}`);
  }
  const {
    onProgress = null,
    cache = createIdbCache(),
    fetchImpl = (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null),
  } = opts;
  if (!fetchImpl) throw new Error('No fetch implementation available');

  const FS = mujoco.FS;
  const root = `/working/${sceneDir}`.replace(/\/+$/, '');
  ensureDir(FS, root);

  const { files, upstreamDir } = manifest;
  let done = 0;
  let bytes = 0;
  const patched = [];
  let homePose = null;

  const writeOne = async (file) => {
    const key = `${MENAGERIE_COMMIT}/${upstreamDir}/${file.path}`;
    let data = null;
    try { data = await cache.get(key); } catch (_) { /* cache miss is not fatal */ }
    if (!data) {
      data = await fetchBytes(fetchImpl, upstreamDir, file);
      try { await cache.set(key, data); } catch (_) { /* nor is a failed write */ }
    }
    const full = `${root}/${file.path}`;
    ensureDir(FS, full.substring(0, full.lastIndexOf('/')));

    // Patch XML on the way out of the cache, not into it, so the cache stays a
    // faithful copy of upstream and a changed patch takes effect without
    // requiring every user to re-download 73 MB.
    if (isXml(file.path)) {
      const text = new TextDecoder('utf-8').decode(data);
      const result = patchRobotXml(packId, text);
      if (result.notes.length) patched.push({ path: file.path, notes: result.notes });
      // The entry XML is the one that carries the robot's home pose.
      if (result.homePose && file.path === manifest.entry) homePose = result.homePose;
      FS.writeFile(full, new TextEncoder().encode(result.xml));
    } else {
      FS.writeFile(full, data);
    }

    done += 1;
    bytes += data.byteLength;
    if (onProgress) {
      onProgress({ done, total: files.length, bytes, totalBytes: manifest.totalBytes, path: file.path });
    }
  };

  // Bounded parallelism: ~97 files for Stretch 3, and MuJoCo's own XML compiler
  // would otherwise open them one at a time — serial fetching costs one RTT each.
  const queue = files.slice();
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      await writeOne(next);
    }
  });
  await Promise.all(workers);

  return { entry: manifest.entry, paths: files.map((f) => f.path), patched, homePose };
}
