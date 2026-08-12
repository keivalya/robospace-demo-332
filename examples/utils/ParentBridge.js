// examples/utils/ParentBridge.js
//
// Bridges this standalone simulator to a parent window (e.g. the robospace-nextjs
// dashboard) over postMessage. When loaded directly at demo.robospace.app with no
// parent, the bridge waits 1500 ms for a HELLO; if none arrives, it stays dormant
// and the simulator continues using its existing localStorage-based persistence.
//
// Protocol envelope: { source: "robospace", v: 1, type, id, payload }
//   Parent → child: HELLO, LOAD_PROJECT, NEW_PROJECT, REQUEST_SNAPSHOT, PING,
//                   APPLY_SCENE, READ_SCENE
//   Child  → parent: READY, LOAD_PROJECT_OK, SNAPSHOT, DIRTY, THUMBNAIL, ERROR, PONG,
//                    SCENE_OK, SCENE_TEXT, SCENE_PROGRESS

import { resolveEntryXmlPath, snapshotSceneDir } from './safePath.js';

const PROTOCOL_VERSION = 1;
const HELLO_TIMEOUT_MS = 1500;
const DIRTY_DEBOUNCE_MS = 750;
const THUMBNAIL_W = 320;
const THUMBNAIL_H = 200;

// A cold Stretch 3 fetch fires onProgress ~97 times in a few seconds. Every one
// is a structured clone across an origin boundary, so coalesce them; the last
// file always reports regardless, so the bar still finishes at 100%.
const PROGRESS_THROTTLE_MS = 120;

// Parent origins we trust. The first allowed origin we see in a HELLO becomes
// the locked-in counterparty for the rest of the session.
//
// This allowlist is the ENTIRE framing control. The demo is served from GitHub
// Pages, so there is no way to send X-Frame-Options or frame-ancestors, and any
// page on the internet can put demo.robospace.app in an iframe. Whatever gets past
// this check can drive APPLY_SCENE, READ_SCENE and REQUEST_SNAPSHOT — i.e. read the
// user's scene files and Python script straight out of MEMFS, and write new ones.
//
// It previously contained /^https:\/\/.*\.vercel\.app$/, which is not a restriction:
// anyone can deploy to a *.vercel.app subdomain for free. localhost and 127.0.0.1
// were also live in production, which a malicious local process could use.
const PRODUCTION_HOST = 'demo.robospace.app';

const PARENT_ORIGIN_ALLOWLIST = [
  'https://app.robospace.app',
  'https://robospace.app',
];

// Dev/preview origins, permitted only when this page is NOT the production deploy.
//
// The private-network entries are for running the app on `next dev`'s Network URL
// rather than localhost — testing on a phone, or just using the LAN address the
// dev server prints. They are deliberately pinned to the RFC1918 ranges
// (10/8, 172.16/12, 192.168/16) and NOT written as a general
// /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/, which would trust any *public* IP — i.e.
// any page a stranger can host. Same trust level as localhost, same dev-only gate.
const DEV_ORIGIN_ALLOWLIST = [
  /^http:\/\/localhost:\d+$/,
  /^http:\/\/127\.0\.0\.1:\d+$/,
  /^http:\/\/10(?:\.\d{1,3}){3}:\d+$/,
  /^http:\/\/192\.168(?:\.\d{1,3}){2}:\d+$/,
  /^http:\/\/172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}:\d+$/,
  /^https:\/\/[a-z0-9-]+\.vercel\.app$/,
];

function isProductionDeploy() {
  try {
    return window.location.hostname === PRODUCTION_HOST;
  } catch (_) {
    return true;   // fail closed
  }
}

function originAllowed(origin) {
  const test = (entry) => (typeof entry === 'string' ? entry === origin : entry.test(origin));
  if (PARENT_ORIGIN_ALLOWLIST.some(test)) return true;
  return !isProductionDeploy() && DEV_ORIGIN_ALLOWLIST.some(test);
}

/**
 * Reads the nonce this page was framed with, if any.
 *
 * A Vercel preview deploy has an unpredictable origin, so it cannot be allowlisted
 * without a wildcard — and the wildcard is what made this exploitable. Instead the
 * parent generates a random nonce, puts it in the iframe URL it builds, and echoes
 * it in HELLO. Only a parent that could set this page's own URL knows it, which is
 * exactly the property we need: a stranger who frames us cannot guess it.
 *
 * When the page carries no nonce (direct visit, or an older parent), the origin
 * allowlist alone decides — so this strengthens preview deploys without breaking
 * the production origins above.
 */
function expectedNonce() {
  try {
    return new URLSearchParams(window.location.search).get('bridgeNonce');
  } catch (_) {
    return null;
  }
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToUint8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isTextFile(path) {
  return /\.(xml|txt|json)$/i.test(path);
}

export class ParentBridge {
  /**
   * @param {RoboSpaceDemo} demo
   * @param {object} [opts]
   * @param {(specifier: string) => string} [opts.versioned]
   *   main.js's cache-buster. The agent modules (sceneWriter → robotPacks →
   *   robotManifests) are imported lazily so a page that never runs the agent
   *   does not pay for them, and lazy imports need the ?v=N or they serve stale.
   */
  constructor(demo, opts = {}) {
    this.demo = demo;
    this.standalone = false;
    this.parentOrigin = null;
    this.projectId = null;
    this.suppressCameraReset = false;
    this._dirtyTimer = null;
    this._handlers = new Map();
    this._versioned = opts.versioned || ((s) => s);

    // The robot pack backing the current scene, once one has been written:
    // { id, commit, sceneDir, paths }. `paths` is what keeps a snapshot small —
    // see serializeSnapshot.
    this.robotPack = null;

    // In-flight scene work. Both kinds must be single-flight, but they want opposite
    // treatment on collision — see _handleApplyScene and the LOAD_PROJECT case.
    this._applyInFlight = false;
    this._loadInFlight = null;

    // Defensive: read projectId from query string so DIRTY events emitted
    // before a LOAD_PROJECT can still be tagged correctly.
    try {
      const params = new URLSearchParams(window.location.search);
      const qp = params.get('projectId');
      if (qp) this.projectId = qp;
    } catch (_) {}

    this._onMessage = this._onMessage.bind(this);
    window.addEventListener('message', this._onMessage);

    this._helloTimer = setTimeout(() => {
      if (!this.parentOrigin) {
        this.standalone = true;
        if (window.parent === window) return;
      }
    }, HELLO_TIMEOUT_MS);
  }

  // ─── postMessage I/O ──────────────────────────────────────────────────

  _send(type, payload, replyToId) {
    if (!this.parentOrigin) return;
    const msg = {
      source: 'robospace',
      v: PROTOCOL_VERSION,
      type,
      id: replyToId || `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      payload: payload || {},
    };
    try {
      window.parent.postMessage(msg, this.parentOrigin);
    } catch (e) {
      console.warn('[ParentBridge] postMessage failed:', e);
    }
  }

  _onMessage(event) {
    const data = event.data;
    if (!data || data.source !== 'robospace' || typeof data.type !== 'string') return;

    // Only our embedder may speak to us. Without this, any same-origin-allowlisted
    // window — an opener, or another frame in the same tab — could impersonate the
    // parent, since event.origin says nothing about which window sent the message.
    if (event.source !== window.parent) return;

    if (!this.parentOrigin) {
      if (data.type !== 'HELLO') return;
      if (!originAllowed(event.origin)) {
        console.warn('[ParentBridge] HELLO from disallowed origin:', event.origin);
        return;
      }
      // If this page was framed with a nonce, HELLO must echo it. See expectedNonce().
      const nonce = expectedNonce();
      if (nonce && data.payload?.bridgeNonce !== nonce) {
        console.warn('[ParentBridge] HELLO did not present the expected bridgeNonce; ignoring.');
        return;
      }
      this.parentOrigin = event.origin;
      clearTimeout(this._helloTimer);
      this.standalone = false;
      this._send('READY', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: ['snapshot', 'thumbnail', 'sim_state'],
      });
      return;
    }

    // After lock-in, only accept messages from the locked origin.
    if (event.origin !== this.parentOrigin) return;

    switch (data.type) {
      case 'PING':
        this._send('PONG', { uptimeMs: performance.now() }, data.id);
        break;
      case 'NEW_PROJECT':
        this.projectId = data.payload?.projectId || null;
        this._handleNewProject(data.payload || {})
          .then(() => this._send('LOAD_PROJECT_OK', { projectId: this.projectId }, data.id))
          .catch((err) => this._send(
            'ERROR',
            { code: 'NEW_PROJECT_FAILED', message: String(err?.message || err), recoverable: true },
            data.id,
          ));
        break;
      case 'LOAD_PROJECT':
        this.projectId = data.payload?.projectId || this.projectId;
        this._handleLoadProject(data.payload || {})
          .then(() => this._send('LOAD_PROJECT_OK', { projectId: this.projectId }, data.id))
          .catch((err) => this._send(
            'ERROR',
            { code: 'LOAD_PROJECT_FAILED', message: String(err?.message || err), recoverable: true },
            data.id,
          ));
        break;
      case 'REQUEST_SNAPSHOT': {
        const includeThumb = data.payload?.includeThumbnail !== false;
        try {
          const snapshot = this.serializeSnapshot();
          const thumbnailDataUrl = includeThumb ? this._captureThumbnail() : undefined;
          // heapBytes rides on the message envelope, deliberately NOT inside
          // `snapshot` — that object is persisted to Storage and its shape is a
          // schema, so a diagnostic has no business in it.
          this._send('SNAPSHOT', {
            projectId: this.projectId,
            snapshot,
            thumbnailDataUrl,
            heapBytes: this.demo.heapBytes ?? null,
          }, data.id);
        } catch (err) {
          this._send(
            'ERROR',
            { code: 'SNAPSHOT_FAILED', message: String(err?.message || err), recoverable: true },
            data.id,
          );
        }
        break;
      }
      case 'APPLY_SCENE':
        // The agent's main tool. Every failure here is reported rather than
        // thrown, because a compile error is the *expected* case in a repair
        // loop: the diagnostic is what the model uses to fix its own MJCF.
        this._handleApplyScene(data.payload || {}, data.id)
          .then((result) => this._send('SCENE_OK', result, data.id))
          .catch((err) => this._send('ERROR', {
            code: err?.code || 'APPLY_SCENE_FAILED',
            message: String(err?.message || err),
            // '' when MuJoCo compiled-and-failed silently, which is common in
            // this build — see compileModel() in mujocoUtils.js.
            mujocoDiagnostic: err?.mujocoDiagnostic ?? null,
            recoverable: true,
          }, data.id));
        break;
      case 'READ_SCENE':
        this._handleReadScene(data.payload || {})
          .then((result) => this._send('SCENE_TEXT', result, data.id))
          .catch((err) => this._send('ERROR', {
            code: 'READ_SCENE_FAILED',
            message: String(err?.message || err),
            recoverable: true,
          }, data.id));
        break;
      default:
        // Unknown but well-formed message — ignore.
        break;
    }
  }

  // ─── outbound events ──────────────────────────────────────────────────

  emitDirty(reason) {
    if (this.standalone || !this.parentOrigin) return;
    clearTimeout(this._dirtyTimer);
    this._dirtyTimer = setTimeout(() => {
      this._send('DIRTY', { projectId: this.projectId, reason });
    }, DIRTY_DEBOUNCE_MS);
  }

  emitThumbnail() {
    if (this.standalone || !this.parentOrigin) return;
    const dataUrl = this._captureThumbnail();
    if (dataUrl) this._send('THUMBNAIL', { projectId: this.projectId, thumbnailDataUrl: dataUrl });
  }

  _captureThumbnail() {
    const renderer = this.demo?.renderer;
    if (!renderer || !renderer.domElement) return undefined;
    try {
      const off = document.createElement('canvas');
      off.width = THUMBNAIL_W;
      off.height = THUMBNAIL_H;
      const ctx = off.getContext('2d');
      ctx.drawImage(renderer.domElement, 0, 0, THUMBNAIL_W, THUMBNAIL_H);
      return off.toDataURL('image/png', 0.7);
    } catch (e) {
      console.warn('[ParentBridge] thumbnail capture failed:', e);
      return undefined;
    }
  }

  // ─── snapshot serialize / apply ───────────────────────────────────────

  serializeSnapshot() {
    const demo = this.demo;
    const entryXmlPath = demo.params.scene;
    const files = [];
    let robotPack = null;

    // Only walk custom_scenes/* — built-in scenes are re-downloaded on each
    // boot, so we don't need to ship them in every snapshot.
    if (entryXmlPath && entryXmlPath.startsWith('custom_scenes/')) {
      const sceneDir = entryXmlPath.split('/').slice(0, 2).join('/');   // custom_scenes/<name>
      const sceneRoot = `/working/${sceneDir}`;

      // Schema v2: a robot is stored as a reference and re-fetched from the
      // pinned commit on load, never inlined. Base64ing Stretch 3 into every
      // autosave is 73 MB through postMessage and into Firebase Storage — the
      // whole reason the registry is CDN-backed.
      //
      // Scoped to the *current* scene dir: if the user has since switched to a
      // built-in scene, _packPathsFor returns empty and no reference is written.
      const packPaths = this._packPathsFor(sceneDir);
      if (packPaths.size) robotPack = this._packReference();

      this._walkFS(sceneRoot, (full) => {
        const rel = full.replace(/^\/working\//, '');
        if (packPaths.has(rel.slice(sceneDir.length + 1))) return;
        const isText = isTextFile(full);
        const content = isText
          ? demo.mujoco.FS.readFile(full, { encoding: 'utf8' })
          : uint8ToBase64(demo.mujoco.FS.readFile(full));
        files.push({ path: rel, encoding: isText ? 'utf8' : 'base64', content });
      });
    }

    const script = (typeof window.getPythonScript === 'function') ? window.getPythonScript() : '';
    let splitRatio = 0.6;
    try { splitRatio = parseFloat(localStorage.getItem('robospace_split_ratio')) || 0.6; } catch (_) {}

    const sceneName = entryXmlPath ? entryXmlPath.split('/').slice(-2, -1)[0] || entryXmlPath.split('/')[0] : 'scene';

    return {
      // v2 adds `robotPack`. The version is informational — what actually
      // changes behaviour on load is whether `robotPack` is present, so a v2
      // snapshot without one loads down exactly the v1 path.
      schemaVersion: 2,
      sceneName,
      entryXmlPath,
      robotPack,
      files,
      script,
      camera: {
        position: demo.camera.position.toArray(),
        target: demo.controls.target.toArray(),
      },
      sim: this._serializeSim(),
      ui: {
        paused: !!demo.params.paused,
        splitRatio,
      },
    };
  }

  _serializeSim() {
    const sim = this.demo?.simulation;
    if (!sim) return null;
    const safeArr = (a) => (a && a.length != null) ? Array.from(a) : null;
    return {
      qpos: safeArr(sim.qpos),
      qvel: safeArr(sim.qvel),
      ctrl: safeArr(sim.ctrl),
    };
  }

  async applySnapshot(snap) {
    const demo = this.demo;
    if (!snap || !snap.entryXmlPath) throw new Error('snapshot missing entryXmlPath');

    // Validate before anything is deleted. This path used to be derived with
    // split('/').slice(0, 2) behind nothing but a startsWith('custom_scenes/')
    // check, so `custom_scenes/../evil.xml` yielded the directory
    // `custom_scenes/..` — and the recursive delete below then pointed at the parent
    // of every saved scene. It is the one MEMFS write path that bypassed all of
    // sceneWriter's guards.
    const sceneDir = snapshotSceneDir(snap.entryXmlPath);

    if (sceneDir) {
      this._rmrf(`/working/${sceneDir}`);
      this._ensureDir(`/working/${sceneDir}`);
    }

    // Schema v2: the robot is a reference, so re-materialise it from the pinned
    // commit before overlaying files[] — pack first, so a generated file wins any
    // name collision. IndexedDB makes this local after the first fetch.
    //
    // A v1 snapshot has no robotPack and skips all of this, which is what keeps
    // projects saved before the agent existed loading unchanged.
    // Tell the parent we are alive before the slow part. LOAD_PROJECT's timeout is
    // idle-based and re-armed by SCENE_PROGRESS, but a fully cached pack emits no
    // progress at all — so without this beat there is nothing to re-arm it with and a
    // compile-plus-settle had to finish inside the original budget.
    this._send('SCENE_PROGRESS', { projectId: this.projectId, phase: 'load', done: 0, total: 1 });

    let homePose = null;
    if (snap.robotPack?.id && sceneDir) {
      const { robotPacks } = await this._agentModules();
      if (snap.robotPack.commit && snap.robotPack.commit !== robotPacks.MENAGERIE_COMMIT) {
        // Not fatal, but worth saying out loud: the registry is pinned in code,
        // and there are no manifests for historical commits to fetch instead.
        console.warn(
          `[ParentBridge] snapshot pins ${snap.robotPack.id} at menagerie `
          + `${snap.robotPack.commit.slice(0, 8)}, loading ${robotPacks.MENAGERIE_COMMIT.slice(0, 8)}`,
        );
      }
      let lastProgressAt = 0;
      const pack = await robotPacks.ensureRobotPack(demo.mujoco, snap.robotPack.id, sceneDir, {
        onProgress: (p) => {
          const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
          if (p.done !== p.total && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
          lastProgressAt = now;
          this._send('SCENE_PROGRESS', { projectId: this.projectId, phase: 'assets', ...p });
        },
      });
      homePose = pack.homePose;
      this.robotPack = {
        id: snap.robotPack.id,
        commit: robotPacks.MENAGERIE_COMMIT,
        sceneDir,
        paths: pack.paths,
      };
    } else {
      this.robotPack = null;
    }

    if (Array.isArray(snap.files)) {
      for (const f of snap.files) {
        // Was `f.path.replace(/^\/+/, '')`, which strips only *leading* slashes and
        // lets every ".." segment through, so a snapshot could write anywhere in
        // MEMFS. Confine to this snapshot's own scene directory instead. A built-in
        // scene (sceneDir === null) ships no files, so there is nothing to relax for.
        if (!sceneDir) {
          throw new Error(`Snapshot carries files but its entryXmlPath "${snap.entryXmlPath}" `
            + 'is not a custom scene, so there is nowhere safe to put them.');
        }
        const rel = resolveEntryXmlPath(f.path, sceneDir);   // returns sceneDir/<safe rel>
        const full = `/working/${rel}`;
        this._ensureParentDirs(full);
        const data = f.encoding === 'base64' ? base64ToUint8(f.content) : f.content;
        demo.mujoco.FS.writeFile(full, data);
      }
    }

    // params.scene decides what gets compiled, and READ_SCENE reads it straight back
    // out to the parent, so it gets the same treatment rather than being trusted.
    const entryXmlPath = sceneDir
      ? resolveEntryXmlPath(snap.entryXmlPath, sceneDir)
      : snap.entryXmlPath;

    // Ensure the scene selector exposes this scene.
    this._ensureSceneOption(snap.sceneName, entryXmlPath);
    const sceneSelector = document.getElementById('scene-selector');
    if (sceneSelector) sceneSelector.value = entryXmlPath;

    // Suppress the hardcoded camera reset for this one reload.
    this.suppressCameraReset = true;
    try {
      await demo.reloadScene(entryXmlPath);
    } finally {
      this.suppressCameraReset = false;
    }

    let restoredSim = false;
    if (snap.sim && demo.simulation) {
      try {
        if (snap.sim.qpos) demo.simulation.qpos.set(snap.sim.qpos);
        if (snap.sim.qvel) demo.simulation.qvel.set(snap.sim.qvel);
        if (snap.sim.ctrl) demo.simulation.ctrl.set(snap.sim.ctrl);
        demo.simulation.forward();
        restoredSim = true;
      } catch (e) {
        console.warn('[ParentBridge] failed to restore sim state (size mismatch?):', e);
      }
    }

    // The saved state is the better pose when we have it — it is where the user
    // actually left the scene. The home pose is the fallback, and it matters:
    // robotPacks strips the <keyframe> that used to carry it (it aborts
    // mj_makeData once a scene adds any joint), so without one of the two the
    // robot spawns at qpos0 with its arm out and visibly sags.
    if (!restoredSim && homePose) {
      const { sceneWriter } = await this._agentModules();
      sceneWriter.applyHomePose(demo, homePose);
    }

    if (snap.camera && demo.camera && demo.controls) {
      if (snap.camera.position && snap.camera.position.length === 3) {
        demo.camera.position.fromArray(snap.camera.position);
      }
      if (snap.camera.target && snap.camera.target.length === 3) {
        demo.controls.target.fromArray(snap.camera.target);
      }
      demo.controls.update();
    }

    if (typeof snap.script === 'string' && typeof window.setPythonScript === 'function') {
      window.setPythonScript(snap.script);
    }

    if (snap.ui) {
      if (typeof snap.ui.paused === 'boolean') demo.params.paused = snap.ui.paused;
      if (typeof snap.ui.splitRatio === 'number') {
        try { localStorage.setItem('robospace_split_ratio', snap.ui.splitRatio.toFixed(4)); } catch (_) {}
      }
    }
  }

  // ─── handlers for parent commands ─────────────────────────────────────

  /**
   * Coalesced rather than rejected, which is the opposite of APPLY_SCENE.
   *
   * React 18 StrictMode double-effects and fast refresh can legitimately fire this
   * twice for one project, and the second caller wants the same outcome as the first
   * — so returning the in-flight promise is right. Running applySnapshot twice
   * concurrently would rmrf the scene directory out from under the first.
   */
  async _handleLoadProject(payload) {
    if (this._loadInFlight) return this._loadInFlight;
    this._loadInFlight = this._loadProject(payload);
    try {
      return await this._loadInFlight;
    } finally {
      this._loadInFlight = null;
    }
  }

  async _loadProject(payload) {
    let snapshot = payload.snapshot;
    if (!snapshot && payload.snapshotUrl) {
      const res = await fetch(payload.snapshotUrl);
      if (!res.ok) throw new Error(`snapshot fetch failed: ${res.status}`);
      snapshot = await res.json();
    }
    if (!snapshot) throw new Error('LOAD_PROJECT missing snapshot or snapshotUrl');
    await this.applySnapshot(snapshot);
  }

  async _handleNewProject(_payload) {
    // Reset to the default built-in scene + default script. This matches the
    // empty-state UX without forcing the user to refresh the page.
    const defaultScene = 'universal_robots_ur5e/scene.xml';
    this.demo.params.scene = defaultScene;
    const sceneSelector = document.getElementById('scene-selector');
    if (sceneSelector) {
      sceneSelector.innerHTML = '';
      const option = document.createElement('option');
      option.value = defaultScene;
      option.textContent = 'Universal Robots UR5e';
      sceneSelector.appendChild(option);
      sceneSelector.value = defaultScene;
    }

    this.suppressCameraReset = false;
    await this.demo.reloadScene();

    if (typeof window.resetPythonScript === 'function') {
      window.resetPythonScript();
    }

    // A fresh project is not backed by a robot pack until one is applied.
    this.robotPack = null;
  }

  // ─── agent scene authoring ────────────────────────────────────────────

  /** Lazily pulls in sceneWriter → robotPacks → robotManifests, which are ~30 KB
   *  of manifest that a page never running the agent should not download. Cached
   *  so a repair loop's later iterations do not re-resolve the graph. */
  _agentModules() {
    return (this._agentModulesPromise ||= (async () => ({
      sceneWriter: await import(this._versioned('./sceneWriter.js')),
      robotPacks: await import(this._versioned('./robotPacks.js')),
    }))());
  }

  /**
   * APPLY_SCENE — write a generated scene into MEMFS, compile it, settle it.
   *
   * Two shapes, because two agent tools land here:
   *   { sceneName, robotPack?, files, entryXmlPath?, script? } → full scene write
   *   { script }                                               → controller only
   *
   * The script-only form deliberately does not recompile. write_script runs after
   * a successful apply_scene, and reloading the scene would throw away the settled
   * state the user is already looking at — and pay for settling a second time.
   *
   * Everything is delegated to sceneWriter.writeGeneratedScene, which is also what
   * window.robospaceLoadRobot() calls. That shared path is deliberate: it is the
   * only way a by-hand browser check exercises the same code as the agent,
   * including rendering, which no Node test covers.
   */
  async _handleApplyScene(payload, requestId) {
    const { sceneName, robotPack = null, files, script, entryXmlPath, settle } = payload;
    const hasFiles = Array.isArray(files) && files.length > 0;

    // Reject rather than queue. writeGeneratedScene begins with rmrf of the scene
    // directory, so two concurrent applies delete each other's files: the first then
    // either compiles the second's scene or dies with "entry file was not written",
    // and demo.params.scene / this.robotPack become last-writer-wins. Queueing would
    // also hand the caller a diagnostic about a scene it can no longer reason about.
    // Overlap is likely rather than theoretical, because sendApplyScene's timeout is
    // idle-based and a cold pack makes a single apply take minutes.
    if (hasFiles && this._applyInFlight) {
      const err = new Error('A scene is already being applied. Wait for it to finish and retry.');
      err.code = 'SCENE_BUSY';
      throw err;
    }
    if (hasFiles) this._applyInFlight = true;
    try {
      return await this._applyScene({ sceneName, robotPack, files, script, entryXmlPath, settle, hasFiles }, requestId);
    } finally {
      if (hasFiles) this._applyInFlight = false;
    }
  }

  async _applyScene({ sceneName, robotPack, files, script, entryXmlPath, settle, hasFiles }, requestId) {

    if (!hasFiles) {
      if (typeof script !== 'string') {
        throw new Error('APPLY_SCENE needs files[] to build a scene, or script to set the controller.');
      }
      if (!this._setScript(script)) {
        throw new Error('The Python editor is not ready yet, so the script was not saved.');
      }
      this.emitDirty('agent-script');
      return {
        projectId: this.projectId,
        scriptOnly: true,
        entryXmlPath: this.demo.params.scene,
        modelStats: await this._currentModelStats(),
      };
    }

    const { sceneWriter, robotPacks } = await this._agentModules();

    let lastProgressAt = 0;
    const onProgress = (p) => {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (p.done !== p.total && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
      lastProgressAt = now;
      // Sent WITHOUT replyToId on purpose. simBridge resolves any inbound message
      // whose id matches a pending request, so echoing requestId here would settle
      // the APPLY_SCENE promise early with a progress payload and the real result
      // would arrive with nowhere to go. Correlate in the body instead.
      this._send('SCENE_PROGRESS', { projectId: this.projectId, requestId, phase: 'assets', ...p });
    };

    const result = await sceneWriter.writeGeneratedScene(this.demo, {
      sceneName, robotPack, files, entryXmlPath, settle, onProgress,
    });

    // Remember the pack so snapshots can reference it instead of inlining it.
    this.robotPack = robotPack
      ? {
        id: robotPack,
        commit: robotPacks.MENAGERIE_COMMIT,
        sceneDir: result.sceneDir,
        paths: result.packPaths,
      }
      : null;

    this._ensureSceneOption(sceneName, result.entryXmlPath);
    const sceneSelector = document.getElementById('scene-selector');
    if (sceneSelector) sceneSelector.value = result.entryXmlPath;

    if (typeof script === 'string' && !this._setScript(script)) {
      console.warn('[ParentBridge] scene applied but the Python editor was not ready for the script');
    }

    // Hands the result to the parent's existing DIRTY → autosave chain; the agent
    // needs no save path of its own.
    this.emitDirty('agent');

    return {
      projectId: this.projectId,
      entryXmlPath: result.entryXmlPath,
      modelStats: result.modelStats,
      patched: result.patched,
      settled: result.settled,
      robotPack: this._packReference(),
      // This build never frees mjModel/mjData, so the heap only grows — roughly
      // 55 MB per reload. Reporting it lets the agent's repair loop notice it is
      // approaching the 2 GB cap instead of dying at an uncatchable abort.
      heapBytes: this.demo.heapBytes ?? null,
    };
  }

  /**
   * READ_SCENE — the current scene's XML, for refinement turns.
   *
   * Reads demo.params.scene rather than a caller-supplied path. The agent has no
   * legitimate reason to name a different file (it just applied this one), and
   * accepting a path here would add a second model-controlled MEMFS path to
   * validate for no gain — see the entryXmlPath notes in sceneWriter.
   *
   * `files` lists only what the agent authored. The pack's ~97 meshes are excluded:
   * they are not the agent's to rewrite, and listing them buries the scene.
   */
  async _handleReadScene(_payload) {
    const demo = this.demo;
    const entryXmlPath = demo.params.scene;
    if (!entryXmlPath) throw new Error('No scene is currently loaded.');

    const FS = demo.mujoco.FS;
    const full = `/working/${entryXmlPath}`;
    if (!FS.analyzePath(full).exists) {
      throw new Error(`Scene file ${entryXmlPath} is not present in the simulator filesystem.`);
    }
    const content = FS.readFile(full, { encoding: 'utf8' });

    const files = [];
    if (entryXmlPath.startsWith('custom_scenes/')) {
      const sceneDir = entryXmlPath.split('/').slice(0, 2).join('/');
      const packPaths = this._packPathsFor(sceneDir);
      this._walkFS(`/working/${sceneDir}`, (path) => {
        const rel = path.slice(`/working/${sceneDir}/`.length);
        if (!packPaths.has(rel)) files.push(rel);
      });
    }

    return {
      projectId: this.projectId,
      entryXmlPath,
      content,
      files,
      robotPack: this._packReference(),
    };
  }

  /** The snapshot-sized view of the active pack: an id and a commit, never bytes. */
  _packReference() {
    return this.robotPack ? { id: this.robotPack.id, commit: this.robotPack.commit } : null;
  }

  /** Pack-owned paths (relative to sceneDir) for the scene dir being asked about,
   *  or an empty set if the active pack belongs to some other scene. */
  _packPathsFor(sceneDir) {
    const pack = this.robotPack;
    if (!pack || pack.sceneDir !== sceneDir) return new Set();
    return new Set(pack.paths);
  }

  _setScript(script) {
    if (typeof window.setPythonScript !== 'function') return false;
    window.setPythonScript(script);
    return true;
  }

  async _currentModelStats() {
    if (!this.demo.model) return null;
    try {
      const { sceneWriter } = await this._agentModules();
      return sceneWriter.readModelStats(this.demo.model);
    } catch (e) {
      console.warn('[ParentBridge] could not read model stats:', e);
      return null;
    }
  }

  // ─── MEMFS helpers ────────────────────────────────────────────────────

  _walkFS(dir, onFile) {
    const FS = this.demo.mujoco.FS;
    if (!FS.analyzePath(dir).exists) return;
    const entries = FS.readdir(dir).filter((n) => n !== '.' && n !== '..');
    for (const name of entries) {
      const full = `${dir}/${name}`;
      const stat = FS.stat(full);
      if (FS.isDir(stat.mode)) this._walkFS(full, onFile);
      else onFile(full);
    }
  }

  _rmrf(dir) {
    const FS = this.demo.mujoco.FS;
    if (!FS.analyzePath(dir).exists) return;
    const entries = FS.readdir(dir).filter((n) => n !== '.' && n !== '..');
    for (const name of entries) {
      const full = `${dir}/${name}`;
      const stat = FS.stat(full);
      if (FS.isDir(stat.mode)) {
        this._rmrf(full);
        try { FS.rmdir(full); } catch (_) {}
      } else {
        try { FS.unlink(full); } catch (_) {}
      }
    }
  }

  _ensureDir(path) {
    const FS = this.demo.mujoco.FS;
    if (!path || path === '/' || FS.analyzePath(path).exists) return;
    const parent = path.substring(0, path.lastIndexOf('/'));
    if (parent && parent !== path) this._ensureDir(parent);
    try { FS.mkdir(path); } catch (e) {
      if (!FS.analyzePath(path).exists) throw e; // re-throw if it really failed
    }
  }

  _ensureParentDirs(path) {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash <= 0) return;
    this._ensureDir(path.substring(0, lastSlash));
  }

  _ensureSceneOption(sceneName, xmlPath) {
    const sceneSelector = document.getElementById('scene-selector');
    if (!sceneSelector) return;
    
    // Clear all existing options to ensure only one robot is visible!
    sceneSelector.innerHTML = '';

    // Extract robot name from XML if possible
    let robotName = null;
    try {
      const FS = this.demo.mujoco.FS;
      const fullXmlPath = `/working/${xmlPath.replace(/^\/+/, '')}`;
      if (FS.analyzePath(fullXmlPath).exists) {
        const xmlContent = FS.readFile(fullXmlPath, { encoding: 'utf8' });
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlContent, 'text/xml');
        const mujocoElement = xmlDoc.querySelector('mujoco');
        if (mujocoElement && mujocoElement.getAttribute('model')) {
          robotName = mujocoElement.getAttribute('model').trim();
        }
      }
    } catch (e) {
      console.warn('[ParentBridge] failed to parse XML for robot name:', e);
    }

    if (!robotName) {
      robotName = xmlPath.startsWith('custom_scenes/') ? `Custom: ${sceneName}` : sceneName;
    }

    const option = document.createElement('option');
    option.value = xmlPath;
    option.textContent = robotName;
    sceneSelector.appendChild(option);
  }
}
