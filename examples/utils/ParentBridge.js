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
import { CHALLENGES } from './challengeRegistry.js';

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
    this._hasLoadedProjectScript = false;

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

    // Fired once the handshake completes / times out. Analytics uses these to
    // drain or drop its queue: events are emitted at module top level, long
    // before this object exists, so something has to tell it when the wire is
    // live. See utils/analytics.js.
    this._onConnectedCbs = [];
    this._onStandaloneCbs = [];

    this._onMessage = this._onMessage.bind(this);
    window.addEventListener('message', this._onMessage);

    this._helloTimer = setTimeout(() => {
      if (!this.parentOrigin) {
        this.standalone = true;
        this._fire(this._onStandaloneCbs);
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

  /** @param {() => void} cb */
  onConnected(cb) {
    if (this.parentOrigin) { cb(); return; }
    this._onConnectedCbs.push(cb);
  }

  /** @param {() => void} cb */
  onStandalone(cb) {
    if (this.standalone) { cb(); return; }
    this._onStandaloneCbs.push(cb);
  }

  _fire(list) {
    for (const cb of list.splice(0)) {
      try { cb(); } catch (e) { console.warn('[ParentBridge] callback threw:', e); }
    }
  }

  /**
   * Relay one analytics event to the parent, which owns the GA4 tag.
   *
   * @returns {boolean} false when there is no parent yet, so the caller can keep
   *          the event queued rather than losing it.
   */
  sendAnalytics(name, params) {
    if (!this.parentOrigin) return false;
    this._send('ANALYTICS_EVENT', { name, params: params || {} });
    return true;
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
      this._fire(this._onConnectedCbs);
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
          .then(() => {
            this._send('LOAD_PROJECT_OK', { projectId: this.projectId }, data.id);
            setTimeout(() => this.emitThumbnail(), 1200);
          })
          .catch((err) => this._send(
            'ERROR',
            { code: 'NEW_PROJECT_FAILED', message: String(err?.message || err), recoverable: true },
            data.id,
          ));
        break;
      case 'LOAD_PROJECT':
        this.projectId = data.payload?.projectId || this.projectId;
        this._handleLoadProject(data.payload || {})
          .then(() => {
            this._send('LOAD_PROJECT_OK', { projectId: this.projectId }, data.id);
            setTimeout(() => this.emitThumbnail(), 1200);
          })
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
      case 'LOAD_MENAGERIE_ROBOT':
        this._handleLoadMenagerieRobot(data.payload || {}, data.id)
          .then((result) => {
            this._send('MENAGERIE_ROBOT_OK', result, data.id);
            this.emitDirty('menagerie_robot_loaded');
            setTimeout(() => this.emitThumbnail(), 1200);
          })
          .catch((err) => this._send('ERROR', {
            code: 'LOAD_MENAGERIE_ROBOT_FAILED',
            message: String(err?.message || err),
            recoverable: true,
          }, data.id));
        break;
      case 'TOGGLE_CAMERA': {
        const { visible, camera } = data.payload || {};
        if (visible === true) this.demo.cameraViewer?.show(camera);
        else if (visible === false) this.demo.cameraViewer?.hide();
        else this.demo.cameraViewer?.toggle();
        this._send('CAMERA_STATUS', {
          visible: !!this.demo.cameraViewer?.visible,
          activeCamera: this.demo.cameraViewer?.activeCamera?.name || null,
          cameras: this.demo.cameraViewer?.cameras?.map((c) => c.name) || [],
        }, data.id);
        break;
      }
      case 'START_CHALLENGE': {
        const { challengeId, resetScript } = data.payload || {};
        const spec = CHALLENGES[challengeId];
        if (!spec) {
          this._send('ERROR', { code: 'CHALLENGE_NOT_FOUND', message: `Challenge "${challengeId}" not found` }, data.id);
          break;
        }
        const started = this.demo.startChallenge(
          challengeId,
          (progress) => this._send('CHALLENGE_PROGRESS', progress),
          (result) => this._send('CHALLENGE_COMPLETE', result)
        );
        if (started) {
          if (spec.starterPython && typeof window.setPythonScript === 'function') {
            const currentScript = (typeof window.getPythonScript === 'function') ? window.getPythonScript().trim() : '';
            if (resetScript || !currentScript || (!this._hasLoadedProjectScript && currentScript.includes('Moving UR5e arm to target'))) {
              window.setPythonScript(spec.starterPython);
              this.emitDirty('challenge_started');
            }
          }
          this._send('CHALLENGE_STARTED', {
            challengeId,
            title: spec.title,
            starterPython: spec.starterPython,
            challenge: {
              id: spec.id,
              title: spec.title,
              subtitle: spec.subtitle,
              difficulty: spec.difficulty,
              robotName: spec.robotName,
              xpReward: spec.xpReward,
              starTargets: spec.starTargets,
              targetPositions: spec.targetPositions,
            },
          }, data.id);
        } else {
          this._send('ERROR', { code: 'CHALLENGE_START_FAILED', message: 'Failed to start challenge evaluator' }, data.id);
        }
        break;
      }
      case 'STOP_CHALLENGE': {
        this.demo.stopChallenge();
        this._send('CHALLENGE_STOPPED', {}, data.id);
        break;
      }
      case 'GET_CHALLENGES': {
        const list = Object.values(CHALLENGES).map((c) => ({
          id: c.id,
          title: c.title,
          subtitle: c.subtitle,
          difficulty: c.difficulty,
          robotName: c.robotName,
          xpReward: c.xpReward,
          starTargets: c.starTargets,
          starterPython: c.starterPython,
        }));
        this._send('CHALLENGES_LIST', { challenges: list }, data.id);
        break;
      }
      case 'TOGGLE_DATASET_PANEL': {
        const ui = this.demo.datasetPipelineUI;
        if (!ui) {
          this._send('ERROR', { code: 'DATASET_UI_NOT_AVAILABLE', message: 'Dataset pipeline UI not initialized' }, data.id);
          break;
        }
        ui.toggle();
        this._send('DATASET_PANEL_TOGGLED', {}, data.id);
        break;
      }
      case 'OPEN_DATASET_PANEL': {
        const ui = this.demo.datasetPipelineUI;
        if (!ui) {
          this._send('ERROR', { code: 'DATASET_UI_NOT_AVAILABLE', message: 'Dataset pipeline UI not initialized' }, data.id);
          break;
        }
        ui.show();
        this._send('DATASET_PANEL_OPENED', {}, data.id);
        break;
      }
      case 'START_DATASET_GENERATION': {
        const ui = this.demo.datasetPipelineUI;
        if (!ui) {
          this._send('ERROR', { code: 'DATASET_UI_NOT_AVAILABLE', message: 'Dataset pipeline UI not initialized' }, data.id);
          break;
        }
        ui.show();
        ui.startGeneration()
          .then(() => this._send('DATASET_STARTED', {}, data.id))
          .catch((err) => this._send('ERROR', { code: 'DATASET_START_FAILED', message: String(err?.message || err) }, data.id));
        break;
      }
      case 'STOP_DATASET_GENERATION': {
        if (this.demo.datasetPipelineUI) {
          this.demo.datasetPipelineUI.stopGeneration();
        }
        this._send('DATASET_STOPPED', {}, data.id);
        break;
      }
      case 'GET_DATASET_STATUS': {
        const progress = this.demo.dataRecorder ? this.demo.dataRecorder.getProgress() : null;
        this._send('DATASET_STATUS', { progress }, data.id);
        break;
      }
      case 'DOWNLOAD_DATASET': {
        if (!this.demo.datasetPipelineUI) {
          this._send('ERROR', { code: 'DATASET_UI_NOT_AVAILABLE', message: 'Dataset pipeline UI not initialized' }, data.id);
          break;
        }
        this.demo.datasetPipelineUI.downloadZip()
          .then(() => this._send('DATASET_DOWNLOAD_STARTED', {}, data.id))
          .catch((err) => this._send('ERROR', { code: 'DATASET_DOWNLOAD_FAILED', message: String(err?.message || err) }, data.id));
        break;
      }
      case 'PUSH_DATASET_TO_HF': {
        const { repoId, token, isPrivate } = data.payload || {};
        if (!this.demo.datasetPipelineUI?.exporter) {
          this._send('ERROR', { code: 'EXPORTER_NOT_AVAILABLE', message: 'Exporter not initialized' }, data.id);
          break;
        }
        this.demo.datasetPipelineUI.exporter.pushToHuggingFace({
          repoId,
          token,
          isPrivate,
          onProgress: (p) => this._send('DATASET_HF_PROGRESS', p),
        })
          .then((res) => this._send('DATASET_HF_COMPLETE', res, data.id))
          .catch((err) => this._send('ERROR', { code: 'HF_PUSH_FAILED', message: String(err?.message || err) }, data.id));
        break;
      }
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
    const demo = this.demo;
    const renderer = demo?.renderer;
    const scene = demo?.scene;
    const camera = demo?.camera;
    if (!renderer || !renderer.domElement || !scene || !camera) return undefined;
    try {
      // Force a synchronous render pass so the WebGL drawing buffer contains active 3D pixels
      if (typeof demo.render === 'function') {
        demo.render();
      } else {
        renderer.render(scene, camera);
      }

      const off = document.createElement('canvas');
      off.width = THUMBNAIL_W;
      off.height = THUMBNAIL_H;
      const ctx = off.getContext('2d');
      ctx.drawImage(renderer.domElement, 0, 0, THUMBNAIL_W, THUMBNAIL_H);

      // Validate that captured image is not blank/transparent
      const imgData = ctx.getImageData(0, 0, THUMBNAIL_W, THUMBNAIL_H);
      const data = imgData.data;
      let nonZeroAlpha = 0;
      let nonBlackPixels = 0;
      for (let i = 0; i < data.length; i += 64) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a > 20) nonZeroAlpha++;
        if (r > 15 || g > 15 || b > 15) nonBlackPixels++;
      }

      if (nonZeroAlpha < 10 && nonBlackPixels < 10) {
        console.warn('[ParentBridge] Captured thumbnail canvas is blank/transparent, skipping.');
        return undefined;
      }

      return off.toDataURL('image/png', 0.85);
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

    if (entryXmlPath) {
      if (entryXmlPath.startsWith('custom_scenes/')) {
        const sceneDir = entryXmlPath.split('/').slice(0, 2).join('/');
        const sceneRoot = `/working/${sceneDir}`;
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
      } else if (entryXmlPath.includes('/') && entryXmlPath !== 'universal_robots_ur5e/scene.xml') {
        const packId = entryXmlPath.split('/')[0];
        robotPack = this.robotPack || { id: packId, commit: 'main' };
      }
    }

    const script = (typeof window.getPythonScript === 'function') ? window.getPythonScript() : '';
    let splitRatio = 0.6;
    try { splitRatio = parseFloat(localStorage.getItem('robospace_split_ratio')) || 0.6; } catch (_) {}

    const sceneName = entryXmlPath ? entryXmlPath.split('/').slice(-2, -1)[0] || entryXmlPath.split('/')[0] : 'scene';

    return {
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

    let sceneDir = snapshotSceneDir(snap.entryXmlPath);
    const packId = snap.robotPack?.id || (
      snap.entryXmlPath &&
      snap.entryXmlPath.includes('/') &&
      !snap.entryXmlPath.startsWith('custom_scenes/') &&
      snap.entryXmlPath !== 'universal_robots_ur5e/scene.xml'
        ? snap.entryXmlPath.split('/')[0]
        : null
    );

    if (!sceneDir && packId) {
      sceneDir = packId;
    }

    if (sceneDir) {
      this._rmrf(`/working/${sceneDir}`);
      this._ensureDir(`/working/${sceneDir}`);
    }

    this._send('SCENE_PROGRESS', { projectId: this.projectId, phase: 'load', done: 0, total: 1 });

    let homePose = null;
    if (packId && sceneDir) {
      const { robotPacks } = await this._agentModules();
      const isKnown = !robotPacks.ROBOT_MANIFESTS || Object.prototype.hasOwnProperty.call(robotPacks.ROBOT_MANIFESTS, packId);
      if (isKnown) {
        let lastProgressAt = 0;
        const pack = await robotPacks.ensureRobotPack(demo.mujoco, packId, sceneDir, {
          onProgress: (p) => {
            const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            if (p.done !== p.total && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
            lastProgressAt = now;
            this._send('SCENE_PROGRESS', { projectId: this.projectId, phase: 'assets', ...p });
          },
        });
        homePose = pack.homePose;
        this.robotPack = {
          id: packId,
          commit: robotPacks.MENAGERIE_COMMIT,
          sceneDir,
          paths: pack.paths,
        };
      } else {
        const result = await this._fetchAndWriteMenagerieRobot(sceneDir, snap.entryXmlPath, (p) => {
          this._send('SCENE_PROGRESS', { projectId: this.projectId, phase: 'assets', ...p });
        });
        homePose = result.homePose;
        this.robotPack = null;
      }
    } else {
      this.robotPack = null;
    }

    if (Array.isArray(snap.files) && sceneDir && sceneDir.startsWith('custom_scenes/')) {
      for (const f of snap.files) {
        const rel = resolveEntryXmlPath(f.path, sceneDir);
        const full = `/working/${rel}`;
        this._ensureParentDirs(full);
        const data = f.encoding === 'base64' ? base64ToUint8(f.content) : f.content;
        demo.mujoco.FS.writeFile(full, data);
      }
    }

    const entryXmlPath = (sceneDir && sceneDir.startsWith('custom_scenes/'))
      ? resolveEntryXmlPath(snap.entryXmlPath, sceneDir)
      : snap.entryXmlPath;

    this._ensureSceneOption(snap.sceneName || packId, entryXmlPath);
    const sceneSelector = document.getElementById('scene-selector');
    if (sceneSelector) sceneSelector.value = entryXmlPath;

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
      window.setPythonScript(snap.script, { silent: true });
      this._hasLoadedProjectScript = true;
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
    this._hasLoadedProjectScript = false;
    // Reset to the default built-in scene + default script.
    const defaultScene = 'universal_robots_ur5e/scene.xml';
    this.demo.params.scene = defaultScene;
    this._ensureSceneOption('Universal Robots UR5e', defaultScene);

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

  /**
   * LOAD_MENAGERIE_ROBOT — dynamic on-demand loading of any MuJoCo Menagerie robot model.
   */
  async _handleLoadMenagerieRobot(payload, requestId) {
    const model = payload.robot || payload;
    const robotId = model.robotId || model.id;
    const name = model.name;
    const xml_path = model.xml_path;
    const makerDir = model.dir || model.maker_folder || (xml_path ? xml_path.split('/')[0] : null);

    if (!xml_path || !makerDir) {
      throw new Error('LOAD_MENAGERIE_ROBOT requires xml_path and dir in payload.');
    }

    const { sceneWriter, robotPacks } = await this._agentModules();
    const demo = this.demo;

    this._send('SCENE_PROGRESS', { projectId: this.projectId, requestId, phase: 'load', done: 0, total: 1 });

    let entryXmlPath = xml_path;
    let homePose = null;

    const packId = robotId || makerDir;
    if (Object.prototype.hasOwnProperty.call(robotPacks.ROBOT_MANIFESTS, packId)) {
      const pack = await robotPacks.ensureRobotPack(demo.mujoco, packId, makerDir, {
        onProgress: (p) => {
          this._send('SCENE_PROGRESS', { projectId: this.projectId, requestId, phase: 'assets', ...p });
        },
      });
      homePose = pack.homePose;
      entryXmlPath = `${makerDir}/${pack.entry}`;
      this.robotPack = {
        id: packId,
        commit: robotPacks.MENAGERIE_COMMIT,
        sceneDir: makerDir,
        paths: pack.paths,
      };
    } else {
      const result = await this._fetchAndWriteMenagerieRobot(makerDir, xml_path, (p) => {
        this._send('SCENE_PROGRESS', { projectId: this.projectId, requestId, phase: 'assets', ...p });
        if (typeof window.pythonOutput === 'function') {
          window.pythonOutput(`[RoboSpace] Downloading asset ${p.done}/${p.total}: ${p.path}`);
        }
      });
      homePose = result.homePose;
      entryXmlPath = xml_path;
      this.robotPack = null;
    }

    this._ensureSceneOption(name || makerDir, entryXmlPath);
    const sceneSelector = document.getElementById('scene-selector');
    if (sceneSelector) sceneSelector.value = entryXmlPath;

    this.suppressCameraReset = false;
    await demo.reloadScene(entryXmlPath);
    if (typeof window.pythonOutput === 'function') {
      window.pythonOutput(`✓ [RoboSpace] Loaded robot "${name || makerDir}" successfully.`);
    }

    if (homePose) {
      sceneWriter.applyHomePose(demo, homePose);
    }

    if (typeof window.resetPythonScript === 'function') {
      window.resetPythonScript();
    }

    return {
      projectId: this.projectId,
      entryXmlPath,
      name: name || makerDir,
      modelStats: await this._currentModelStats(),
    };
  }

  async _fetchAndWriteMenagerieRobot(makerDir, xmlRelPath, onProgress) {
    const { robotPacks } = await this._agentModules();
    const demo = this.demo;
    const FS = demo.mujoco.FS;

    const entryFileName = xmlRelPath.includes('/')
      ? xmlRelPath.split('/').slice(1).join('/')
      : xmlRelPath;

    const fetchedFiles = new Map();
    const pendingXmls = [entryFileName];
    const visitedXmls = new Set();
    const assetFiles = new Set();
    let homePose = null;

    const cache = robotPacks.createIdbCache();

    const fetchBytes = async (relPath) => {
      const cacheKey = `menagerie/${makerDir}/${relPath}`;
      try {
        const cached = await cache.get(cacheKey);
        if (cached) return cached;
      } catch (_) {}

      const githubUrl = `https://raw.githubusercontent.com/google-deepmind/mujoco_menagerie/main/${makerDir}/${relPath}`;
      const cdnUrl = `https://cdn.jsdelivr.net/gh/google-deepmind/mujoco_menagerie@main/${makerDir}/${relPath}`;
      const localUrl = `/menagerie/${makerDir}/${relPath}`;
      const parentUrl = this.parentOrigin ? `${this.parentOrigin}/menagerie/${makerDir}/${relPath}` : null;

      const attempts = [githubUrl, cdnUrl];
      if (parentUrl) attempts.push(parentUrl);
      attempts.push(localUrl);

      for (const url of attempts) {
        try {
          const res = await fetch(url);
          if (res.ok) {
            const bytes = new Uint8Array(await res.arrayBuffer());
            try { await cache.set(cacheKey, bytes); } catch (_) {}
            return bytes;
          }
        } catch (_) {}
      }
      throw new Error(`Could not fetch asset ${makerDir}/${relPath}`);
    };

    while (pendingXmls.length > 0) {
      const xmlFile = pendingXmls.shift();
      if (visitedXmls.has(xmlFile)) continue;
      visitedXmls.add(xmlFile);

      const bytes = await fetchBytes(xmlFile);
      const rawText = new TextDecoder('utf-8').decode(bytes);

      const patchedTex = robotPacks.stripFileTextures(rawText);
      const patchedKf = robotPacks.extractAndStripKeyframes(patchedTex.xml);
      if (patchedKf.homePose && !homePose) {
        homePose = patchedKf.homePose;
      }

      fetchedFiles.set(xmlFile, new TextEncoder().encode(patchedKf.xml));

      const parser = new DOMParser();
      const doc = parser.parseFromString(rawText, 'text/xml');

      const includes = doc.querySelectorAll('include');
      for (const inc of includes) {
        const fileAttr = inc.getAttribute('file');
        if (fileAttr && !visitedXmls.has(fileAttr)) {
          pendingXmls.push(fileAttr);
        }
      }

      let meshDir = '';
      const compiler = doc.querySelector('compiler');
      if (compiler) {
        meshDir = compiler.getAttribute('meshdir') || compiler.getAttribute('assetdir') || '';
      }

      const resolveAssetPath = (fileAttr) => {
        if (!fileAttr) return null;
        if (meshDir && !fileAttr.startsWith(meshDir)) {
          return `${meshDir}/${fileAttr}`.replace(/\/+/g, '/');
        }
        return fileAttr;
      };

      const meshes = doc.querySelectorAll('mesh');
      for (const m of meshes) {
        const f = resolveAssetPath(m.getAttribute('file'));
        if (f) assetFiles.add(f);
      }

      const skins = doc.querySelectorAll('skin');
      for (const s of skins) {
        const f = resolveAssetPath(s.getAttribute('file'));
        if (f) assetFiles.add(f);
      }

      const hfields = doc.querySelectorAll('hfield');
      for (const h of hfields) {
        const f = resolveAssetPath(h.getAttribute('file'));
        if (f) assetFiles.add(f);
      }
    }

    let doneCount = visitedXmls.size;
    const totalCount = visitedXmls.size + assetFiles.size;

    // Bounded parallelism (8 workers) for ultra-fast asset downloading
    const CONCURRENCY = 8;
    const queue = Array.from(assetFiles);
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const assetFile = queue.shift();
        if (!assetFile) return;
        try {
          const data = await fetchBytes(assetFile);
          fetchedFiles.set(assetFile, data);
        } catch (e) {
          console.warn(`[ParentBridge] could not fetch asset ${makerDir}/${assetFile}:`, e);
        }
        doneCount++;
        if (onProgress) {
          onProgress({ done: doneCount, total: totalCount, path: assetFile });
        }
      }
    });
    await Promise.all(workers);

    const rootDir = `/working/${makerDir}`;
    this._rmrf(rootDir);
    this._ensureDir(rootDir);

    for (const [relPath, fileData] of fetchedFiles.entries()) {
      const fullPath = `${rootDir}/${relPath}`;
      this._ensureParentDirs(fullPath);
      FS.writeFile(fullPath, fileData);
    }

    return { homePose };
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

    let existingOption = sceneSelector.querySelector(`option[value="${CSS.escape(xmlPath)}"]`);
    if (existingOption) {
      sceneSelector.value = xmlPath;
      return;
    }

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

    let customGroup = sceneSelector.querySelector('optgroup[label="Uploaded / Custom"]');
    if (!customGroup) {
      customGroup = document.createElement('optgroup');
      customGroup.label = 'Uploaded / Custom';
      sceneSelector.appendChild(customGroup);
    }

    const option = document.createElement('option');
    option.value = xmlPath;
    option.textContent = robotName;
    customGroup.appendChild(option);
    sceneSelector.value = xmlPath;
  }
}
