// examples/utils/ParentBridge.js
//
// Bridges this standalone simulator to a parent window (e.g. the robospace-nextjs
// dashboard) over postMessage. When loaded directly at demo.robospace.app with no
// parent, the bridge waits 1500 ms for a HELLO; if none arrives, it stays dormant
// and the simulator continues using its existing localStorage-based persistence.
//
// Protocol envelope: { source: "robospace", v: 1, type, id, payload }
//   Parent → child: HELLO, LOAD_PROJECT, NEW_PROJECT, REQUEST_SNAPSHOT, PING
//   Child  → parent: READY, LOAD_PROJECT_OK, SNAPSHOT, DIRTY, THUMBNAIL, ERROR, PONG

const PROTOCOL_VERSION = 1;
const HELLO_TIMEOUT_MS = 1500;
const DIRTY_DEBOUNCE_MS = 750;
const THUMBNAIL_W = 320;
const THUMBNAIL_H = 200;

// Parent origins we trust. The first allowed origin we see in a HELLO becomes
// the locked-in counterparty for the rest of the session.
const PARENT_ORIGIN_ALLOWLIST = [
  'https://app.robospace.app',
  'https://robospace.app',
  /^https:\/\/.*\.vercel\.app$/,
  /^http:\/\/localhost:\d+$/,
  /^http:\/\/127\.0\.0\.1:\d+$/,
];

function originAllowed(origin) {
  return PARENT_ORIGIN_ALLOWLIST.some((entry) =>
    typeof entry === 'string' ? entry === origin : entry.test(origin)
  );
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
  constructor(demo) {
    this.demo = demo;
    this.standalone = false;
    this.parentOrigin = null;
    this.projectId = null;
    this.suppressCameraReset = false;
    this._dirtyTimer = null;
    this._handlers = new Map();

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

    if (!this.parentOrigin) {
      if (data.type !== 'HELLO') return;
      if (!originAllowed(event.origin)) {
        console.warn('[ParentBridge] HELLO from disallowed origin:', event.origin);
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
          this._send('SNAPSHOT', { projectId: this.projectId, snapshot, thumbnailDataUrl }, data.id);
        } catch (err) {
          this._send(
            'ERROR',
            { code: 'SNAPSHOT_FAILED', message: String(err?.message || err), recoverable: true },
            data.id,
          );
        }
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

    // Only walk custom_scenes/* — built-in scenes are re-downloaded on each
    // boot, so we don't need to ship them in every snapshot.
    if (entryXmlPath && entryXmlPath.startsWith('custom_scenes/')) {
      const sceneRoot = `/working/${entryXmlPath.split('/').slice(0, 2).join('/')}`; // /working/custom_scenes/<name>
      this._walkFS(sceneRoot, (full) => {
        const rel = full.replace(/^\/working\//, '');
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
      schemaVersion: 1,
      sceneName,
      entryXmlPath,
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

    if (snap.entryXmlPath.startsWith('custom_scenes/')) {
      const sceneRoot = `/working/${snap.entryXmlPath.split('/').slice(0, 2).join('/')}`;
      this._rmrf(sceneRoot);
      this._ensureDir(sceneRoot);
    }

    if (Array.isArray(snap.files)) {
      for (const f of snap.files) {
        const full = `/working/${f.path.replace(/^\/+/, '')}`;
        this._ensureParentDirs(full);
        const data = f.encoding === 'base64' ? base64ToUint8(f.content) : f.content;
        demo.mujoco.FS.writeFile(full, data);
      }
    }

    // Ensure the scene selector exposes this scene.
    this._ensureSceneOption(snap.sceneName, snap.entryXmlPath);
    demo.params.scene = snap.entryXmlPath;
    const sceneSelector = document.getElementById('scene-selector');
    if (sceneSelector) sceneSelector.value = snap.entryXmlPath;

    // Suppress the hardcoded camera reset for this one reload.
    this.suppressCameraReset = true;
    try {
      await demo.reloadScene();
    } finally {
      this.suppressCameraReset = false;
    }

    if (snap.sim && demo.simulation) {
      try {
        if (snap.sim.qpos) demo.simulation.qpos.set(snap.sim.qpos);
        if (snap.sim.qvel) demo.simulation.qvel.set(snap.sim.qvel);
        if (snap.sim.ctrl) demo.simulation.ctrl.set(snap.sim.ctrl);
        demo.simulation.forward();
      } catch (e) {
        console.warn('[ParentBridge] failed to restore sim state (size mismatch?):', e);
      }
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

  async _handleLoadProject(payload) {
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
    if (sceneSelector) sceneSelector.value = defaultScene;

    this.suppressCameraReset = false;
    await this.demo.reloadScene();

    if (typeof window.resetPythonScript === 'function') {
      window.resetPythonScript();
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
    const exists = [...sceneSelector.options].some((o) => o.value === xmlPath);
    if (exists) return;
    const option = document.createElement('option');
    option.value = xmlPath;
    option.textContent = xmlPath.startsWith('custom_scenes/') ? `Custom: ${sceneName}` : sceneName;
    sceneSelector.appendChild(option);
  }
}
