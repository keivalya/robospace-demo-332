// main.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DragStateManager } from './utils/DragStateManager.js';
import { downloadExampleScenesFolder, loadSceneFromURL, compileModel, getPosition, getQuaternion, toMujocoPos, standardNormal } from './mujocoUtils.js';
import load_mujoco from '../dist/mujoco_wasm.js';
import { FileUploadManager } from './utils/FileUploadManager.js';
import { LivePlotter } from './utils/LivePlotter.js';
import { ParentBridge } from './utils/ParentBridge.js';
import { mujocoLogHooks } from './utils/mujocoLog.js';
import { resolveInitialScene, readStoredScene, forgetStoredScene, DEFAULT_SCENE } from './utils/initialScene.js';
import { SimClock } from './utils/simClock.js';

// index.html loads this module as `main.js?v=N`. Propagate that N to every
// dynamic import() below so bumping the single number in index.html invalidates
// the whole lazily-loaded graph, instead of leaving pythonIntegration.js,
// sceneWriter.js and robotPacks.js served from cache after an edit.
// (Statically imported modules still resolve without the query — for local dev
// use `npm run dev`, which sends Cache-Control: no-store.)
const MODULE_VERSION = (() => {
  try { return new URL(import.meta.url).searchParams.get('v') || ''; } catch { return ''; }
})();
const versioned = (specifier) => (MODULE_VERSION ? `${specifier}?v=${MODULE_VERSION}` : specifier);

// Upper bound on physics steps in a single animation frame. The catch-up loop is
// driven by wall clock, so with a small enough timestep one frame can ask for tens
// of thousands of steps and the tab stops responding. 35 ms of sim time at the
// default 2 ms timestep is ~18 steps, so this is ~50x headroom for fast machines
// and a hard stop for pathological models. settle() caps itself the same way.
const MAX_STEPS_PER_FRAME = 1000;

// ─── bootstrap diagnostics ───────────────────────────────────────────────────
// Everything below runs at module top level, so a single throw or a fetch that
// never settles leaves the page blank with nothing to go on — which is a
// miserable thing to debug and has already cost real time. Track the current
// stage, surface any failure in the page itself, and time out rather than hang.

let bootStage = 'starting';
let bootDone = false;
const setStage = (stage) => { bootStage = stage; window.__robospaceBootStage = stage; };

function showBootError(what, detail) {
  console.error(`[robospace] boot failed during "${bootStage}":`, detail);
  const existing = document.getElementById('robospace-boot-error');
  if (existing) return;
  const box = document.createElement('div');
  box.id = 'robospace-boot-error';
  box.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#161a1f;color:#ffb4b4;'
    + 'font:13px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;padding:28px 32px;overflow:auto;';
  const title = document.createElement('div');
  title.style.cssText = 'font-size:15px;color:#fff;margin-bottom:14px;font-weight:600;';
  title.textContent = `RoboSpace failed to start (during: ${bootStage})`;
  const msg = document.createElement('pre');
  msg.style.cssText = 'white-space:pre-wrap;word-break:break-word;margin:0 0 16px;';
  msg.textContent = `${what}\n\n${detail && detail.stack ? detail.stack : String(detail)}`;
  const hint = document.createElement('div');
  hint.style.cssText = 'color:#9aa4b2;';
  hint.textContent = 'If this mentions a blocked or failed script, check that the page is being served '
    + 'without a Cross-Origin-Embedder-Policy header (python3 -m http.server sends none), and that no '
    + 'older server is still bound to the port.';
  // Dismissable: this panel covers the whole viewport, so if it ever fires while
  // the simulator is actually usable the user must be able to get back to it.
  const close = document.createElement('button');
  close.textContent = 'Dismiss';
  close.style.cssText = 'margin-top:18px;padding:6px 14px;background:#2c3540;color:#dfe6ee;'
    + 'border:1px solid #3d4854;border-radius:6px;cursor:pointer;font:inherit;';
  close.addEventListener('click', () => box.remove());
  box.append(title, msg, hint, close);
  (document.body || document.documentElement).appendChild(box);
}

/**
 * Routes an uncaught error to whichever surface is appropriate.
 *
 * Before boot finishes, a failure means a blank page with nothing to go on, so it
 * earns the full-screen treatment — that panel exists because a silent blank screen
 * cost real debugging time.
 *
 * After boot, the situation is inverted. An uncaught error is usually one bad scene
 * or one bad script, the simulator is still there, and painting an undismissable
 * full-screen overlay over a working app hides it for the rest of the session. That
 * is what a failed MJCF compile did — and a failed compile is the *expected* case
 * when the agent repairs a scene.
 */
function reportUncaught(what, detail) {
  if (bootDone) {
    console.error(`[robospace] ${what}:`, detail);
    const demo = window._roboDemo;
    if (demo && typeof demo.showError === 'function') {
      const text = detail && detail.message ? detail.message : String(detail);
      demo.showError(`${what}: ${text}`);
      return;
    }
  }
  showBootError(what, detail);
}

window.addEventListener('error', (e) => reportUncaught('Uncaught error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportUncaught('Unhandled promise rejection', e.reason));

/** Rejects instead of hanging forever, so a stalled fetch is reported. */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} did not finish within ${ms / 1000}s. `
          + 'Check the Network tab for a request that is still pending.')),
        ms,
      );
    }),
  ]);
}

const loadPyodide = window.loadPyodide;
// Load the MuJoCo Module. The log hooks capture stdout/stderr, which is where
// the XML compiler's diagnostics land — see utils/mujocoLog.js.
setStage('loading MuJoCo WebAssembly');
const mujoco = await load_mujoco(mujocoLogHooks);

// Set up Emscripten's Virtual File System
const STORAGE_KEY_SCENE = 'robospace_last_scene';
var initialScene = resolveInitialScene(readStoredScene(localStorage));
setStage('setting up the virtual filesystem');
mujoco.FS.mkdir('/working');
mujoco.FS.mount(mujoco.MEMFS, { root: '.' }, '/working');

// 23 parallel same-origin fetches. If the server is wedged or a response never
// settles, this is where the page used to freeze silently and forever.
setStage('downloading the bundled example scenes');
await withTimeout(downloadExampleScenesFolder(mujoco), 30000, 'Downloading the bundled example scenes');

setStage(`fetching the initial scene (${initialScene})`);
async function fetchScene(name) {
  const res = await withTimeout(fetch("./examples/scenes/" + name), 15000, `Fetching ${name}`);
  if (!res.ok) throw new Error(`Could not fetch examples/scenes/${name}: HTTP ${res.status}`);
  return res.text();
}

let initialSceneText;
try {
  initialSceneText = await fetchScene(initialScene);
} catch (err) {
  // A scene we cannot load must cost one degraded boot, never a permanent brick.
  // This used to throw at module top level with nothing clearing the stored key,
  // so the page then failed to boot on every subsequent load.
  console.error(`[robospace] falling back to ${DEFAULT_SCENE}:`, err);
  forgetStoredScene(localStorage);
  if (initialScene === DEFAULT_SCENE) throw err;
  initialScene = DEFAULT_SCENE;
  setStage(`fetching the default scene (${initialScene})`);
  initialSceneText = await fetchScene(initialScene);
}
mujoco.FS.writeFile("/working/" + initialScene, initialSceneText);

export class RoboSpaceDemo {
  constructor() {
    this.mujoco = mujoco;
    this._loadQueue = Promise.resolve();

    // Deliberately NOT loaded here. init() calls loadSceneFromURL for this very
    // same scene moments later, so compiling it in the constructor built an entire
    // mjModel + mjData that was then thrown away — and thrown away is literal: this
    // build's Simulation::free() releases only the two 8-byte wrapper structs, so
    // mj_deleteModel/mj_deleteData never run and the whole allocation leaks. That
    // was ~55 MB of unreclaimable heap on every page load.
    //
    // Safe because render() now returns early while these are null (see
    // _renderFrame), and pythonIntegration's bridge functions already null-guard.
    this.model = null;
    this.state = null;
    this.simulation = null;

    // Define Random State Variables
    this.params = { scene: initialScene, paused: false, help: false, ctrlnoiserate: 0.0, ctrlnoisestd: 0.0, keyframeNumber: 0 };
    this.mujoco_time = 0.0;     // wall-clock catch-up accumulator for render(); NOT sim time
    this.simClock = new SimClock();
    this.bodies = {}, this.lights = {};
    this.tmpVec = new THREE.Vector3();
    this.tmpQuat = new THREE.Quaternion();
    this._frameCount = 0;      // monotonic; the stall watchdog reads it
    this._renderFaults = 0;    // reset on every successful scene load
    // Resolved at the end of each rendered frame. This is what lets a Python control
    // loop advance exactly one simulation frame per iteration — see robospaceNextFrame.
    this._frameWaiters = [];
    // Recorded qpos frames awaiting playback. A synchronous script steps the physics far
    // faster than real time and records as it goes; the render loop then plays the
    // recording back at wall-clock speed, which is what lets the whole motion API be
    // await-free without the user losing sight of the motion.
    this.playback = null;
    this._sceneReady = false;
    this._pythonReady = false;
    this.setupStatusIndicator();
    this.setupToolbar();
    this.setupProgramControls();
    this.setupPythonIntegration();

    // this.container = document.createElement( 'div' );
    // document.body.appendChild( this.container );
    this.container = document.getElementById('appbody');

    this.scene = new THREE.Scene();
    this.scene.name = 'scene';

    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.001, 100);
    this.camera.name = 'PerspectiveCamera';
    this.camera.position.set(2.0, 1.7, 1.7);
    this.scene.add(this.camera);

    this.scene.background = new THREE.Color(0.15, 0.25, 0.35);
    this.scene.fog = new THREE.Fog(this.scene.background, 15, 25.5);

    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.1);
    this.ambientLight.name = 'AmbientLight';
    this.scene.add(this.ambientLight);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    // Cap at 2× to avoid excessive GPU load on very high-DPI screens
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Initial size — will be corrected by onWindowResize() called below.
    // false = don't touch canvas inline style; CSS fills appbody via position:absolute.
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap; // default THREE.PCFShadowMap
    this.renderer.setAnimationLoop(this.render.bind(this));
    this._startRenderWatchdog();

    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.7, 0);
    this.controls.panSpeed = 2;
    this.controls.zoomSpeed = 1;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.10;
    this.controls.screenSpacePanning = true;
    this.controls.update();

    window.addEventListener('resize', this.onWindowResize.bind(this));
    window.addEventListener('keydown', this.onKeyDown.bind(this));

    // Initialize the Drag State Manager.
    this.dragStateManager = new DragStateManager(this.scene, this.renderer, this.camera, this.container.parentElement, this.controls);
    this.onWindowResize();

    this.fileUploadManager = new FileUploadManager(this.mujoco, this);

    this.livePlotter = new LivePlotter();

    // versioned() is passed in because ParentBridge lazily imports sceneWriter /
    // robotPacks for APPLY_SCENE, and a lazy import without the ?v=N serves stale.
    this.parentBridge = new ParentBridge(this, { versioned });
    window._roboDemo = this;
  }

  setupStatusIndicator() {
    const el = document.getElementById('sim-status');
    const label = el ? el.querySelector('.sim-status-label') : null;
    const STATE_LABELS = {
      loading: 'Simulation Loading…',
      ready:   'Simulation Ready',
      running: 'Running script',
      error:   'Error',
    };
    const setStatus = (state, customLabel) => {
      if (!el) return;
      el.classList.remove('loading', 'ready', 'running', 'error');
      el.classList.add(state);
      if (label) label.textContent = customLabel || STATE_LABELS[state] || state;
    };
    this.setSimStatus = setStatus;
    window.setSimStatus = setStatus;
    setStatus('loading');
  }

  _markReady(which) {
    if (which === 'scene') this._sceneReady = true;
    if (which === 'python') this._pythonReady = true;
    if (this._sceneReady && this._pythonReady && this.setSimStatus) {
      this.setSimStatus('ready');
    }
  }

  setupToolbar() {
    // Scene selector
    const sceneSelector = document.getElementById('scene-selector');
    const scenes = {
      "Universal Robots UR5e": "universal_robots_ur5e/scene.xml",
    };

    // Populate scene selector (guard against double-init)
    if (sceneSelector.options.length === 0) {
      Object.entries(scenes).forEach(([name, file]) => {
        const option = document.createElement('option');
        option.value = file;
        option.textContent = name;
        if (file === this.params.scene) option.selected = true;
        sceneSelector.appendChild(option);
      });
    } else {
      sceneSelector.value = this.params.scene;
    }

    sceneSelector.addEventListener('change', async (e) => {
      this.params.scene = e.target.value;
      // Guarded for the same reason the read is: localStorage throws outright when
      // storage is partitioned, which is how this page runs inside the dashboard.
      try { localStorage.setItem(STORAGE_KEY_SCENE, this.params.scene); } catch (_) { /* not worth failing a load over */ }
      try {
        await this.reloadScene();
        this.parentBridge?.emitDirty('scene');
      } catch (err) { /* status handled in reloadScene */ }
    });

    // Live plot toggle (floating overlay button)
    const plotBtn = document.getElementById('plot-toggle-button');
    if (plotBtn) plotBtn.addEventListener('click', () => {
      this.livePlotter.toggle();
      plotBtn.classList.toggle('active', !!this.livePlotter.visible);
    });

    // Pause / Play toggle
    const pauseButton = document.getElementById('pause-button');
    if (pauseButton) pauseButton.addEventListener('click', () => {
      this.params.paused = !this.params.paused;
      pauseButton.textContent = this.params.paused ? '▶' : '⏸';
      pauseButton.classList.toggle('active', this.params.paused);
      pauseButton.setAttribute('title', this.params.paused ? 'Play (Space)' : 'Pause (Space)');
    });

    // Reset robot
    const resetBtn = document.getElementById('reset-button');
    if (resetBtn) resetBtn.addEventListener('click', () => {
      if (this.simulation) {
        this.simulation.resetData();
        this.simulation.forward();
        this.simClock.reset(0);
      }
    });

    // Upload Robot (next to scene selector)
    const uploadBtn = document.getElementById('upload-robot-btn');
    if (uploadBtn) uploadBtn.addEventListener('click', () => {
      if (this.fileUploadManager) this.fileUploadManager.openDialog();
    });
  }

  setupProgramControls() {
    // Kebab dropdown menu (Examples / Reset code / Reload Env)
    const menuBtn = document.getElementById('ide-menu-btn');
    const dropdown = document.getElementById('ide-menu-dropdown');
    const importBtn = document.getElementById('ide-import-btn');
    const importInput = document.getElementById('ide-import-file');
    const saveBtn = document.getElementById('save-python');

    const closeMenu = () => {
      if (!dropdown) return;
      dropdown.hidden = true;
      if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
    };
    const openMenu = () => {
      if (!dropdown) return;
      dropdown.hidden = false;
      if (menuBtn) menuBtn.setAttribute('aria-expanded', 'true');
    };

    if (menuBtn && dropdown) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.hidden ? openMenu() : closeMenu();
      });
      document.addEventListener('click', (e) => {
        if (!dropdown.hidden && !dropdown.contains(e.target) && e.target !== menuBtn) closeMenu();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !dropdown.hidden) closeMenu();
      });

      // Dropdown actions
      dropdown.addEventListener('click', async (e) => {
        const item = e.target.closest('[data-action]');
        if (!item) return;
        closeMenu();
        const action = item.dataset.action;
        if (action === 'reset-code') {
          if (window.resetPythonScript) window.resetPythonScript();
        } else if (action === 'reload-env') {
          try { await this.reloadScene(); } catch (err) { /* status handled in reloadScene */ }
        }
      });
    }

    // Populate Examples list (deferred until pythonIntegration loads)
    this._populateExamplesWhenReady();

    // Import Script
    if (importBtn && importInput) {
      importBtn.addEventListener('click', () => importInput.click());
      importInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          if (window.setPythonScript) window.setPythonScript(text);
        } catch (err) {
          this.showError(`Failed to import "${file.name}": ${this.formatError(err)}`);
        } finally {
          importInput.value = ''; // allow re-selecting the same file
        }
      });
    }

    // Save Script — download current editor content as .py
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const code = window.getPythonScript ? window.getPythonScript() : '';
        const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15); // YYYYMMDD-HHMMSS
        const filename = `robospace-script-${ts.slice(0, 8)}-${ts.slice(9, 15)}.py`;
        const blob = new Blob([code], { type: 'text/x-python;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });
    }
  }

  async _populateExamplesWhenReady() {
    try {
      const { PYTHON_EXAMPLES, EXAMPLE_LABELS } = await import(versioned('./pythonIntegration.js'));
      const host = document.getElementById('ide-examples-list');
      if (!host || !PYTHON_EXAMPLES) return;
      // Ordered roughly easiest-first. Any example missing from this map is silently
      // absent from the menu, so EXAMPLE_LABELS lives beside the examples themselves —
      // two lists in two files is how load_robot and load_scene stayed unlisted.
      Object.entries(EXAMPLE_LABELS).forEach(([key, label]) => {
        if (!PYTHON_EXAMPLES[key]) return;
        const btn = document.createElement('button');
        btn.className = 'ide-dropdown-item';
        btn.setAttribute('role', 'menuitem');
        btn.textContent = label;
        btn.addEventListener('click', () => {
          if (window.setPythonScript) window.setPythonScript(PYTHON_EXAMPLES[key]);
        });
        host.appendChild(btn);
      });
    } catch (e) {
      console.warn('Failed to populate Examples list:', e);
    }
  }

  async setupPythonIntegration() {
    // Initialize Pyodide
    if (window.pyodide) { this._markReady('python'); return; }

    try {
      window.pyodide = await loadPyodide({
        indexURL: "https://cdn.jsdelivr.net/pyodide/v0.23.4/full/"
      });
      console.log("Pyodide loaded successfully");

      // Load numpy package
      await window.pyodide.loadPackage(["numpy"]);
      console.log("NumPy package loaded");

      // Initialize Python environment
      await this.initializePythonEnvironment();
    } catch (error) {
      console.error("Failed to load Pyodide:", error);
    } finally {
      this._markReady('python');
    }
  }

  /**
   * @param {string} [sceneOverride] Scene to load. Defaults to params.scene *as it
   *   is now*, captured here rather than read inside the queued job below.
   *
   *   The queue serialises execution but not intent: params.scene has five writers
   *   (the selector, sceneWriter, ParentBridge's snapshot apply, the uploader), so a
   *   job that read it at run time would load whatever the last writer set — and
   *   then resolve successfully, leaving the caller believing its own scene loaded.
   */
  async reloadScene(sceneOverride) {
    const scene = sceneOverride ?? this.params.scene;
    this.clearError();
    if (this.setSimStatus) this.setSimStatus('loading');

    const nextPromise = this._loadQueue.then(async () => {
      try {
        [this.model, this.state, this.simulation, this.bodies, this.lights] =
          await loadSceneFromURL(this.mujoco, scene, this);
        this.simulation.forward();
        this.params.scene = scene;    // source of truth now matches what loaded
        this._renderFaults = 0;       // a good scene earns a clean slate
        this.simClock.reset(0);       // a new model means a new clock
      } catch (error) {
        this.showError(`Failed to load scene "${scene}": ${this.formatError(error)}`);
        if (this.setSimStatus) this.setSimStatus('error');
        throw error;
      }

      // Update Python environment
      if (window.pyodide) {
        await this.updatePythonEnvironment();
      }

      // Update plotter labels from joint names
      if (this.livePlotter && this.model) {
        const decoder = new TextDecoder('utf-8');
        const labels = [];
        for (let i = 0; i < Math.min(this.model.njnt, 8); i++) {
          const addr = this.model.name_jntadr[i];
          const raw  = decoder.decode(this.model.names.subarray(addr));
          labels.push(raw.split('\0')[0] || `j${i}`);
        }
        this.livePlotter.setLabels(labels);
      }

      // Camera reset — skipped when the parent bridge is restoring a saved camera
      if (!this.parentBridge?.suppressCameraReset) {
        this.camera.position.set(2.0, 1.7, 1.7);
        this.controls.target.set(0, 0.7, 0);
        this.controls.update();
      }

      if (this.setSimStatus) this.setSimStatus('ready');
    });

    this._loadQueue = nextPromise.catch(() => {});
    await nextPromise;
  }

  async init() {
    // Download the the examples to MuJoCo's virtual file system
    await downloadExampleScenesFolder(mujoco);

    // If the scene has already been changed to a custom scene by a snapshot load,
    // do NOT load the default scene!
    if (this.params.scene !== initialScene) {
      this._markReady('scene');
      return;
    }

    const nextPromise = this._loadQueue.then(async () => {
      try {
        // Initialize the three.js Scene using the .xml Model in initialScene
        [this.model, this.state, this.simulation, this.bodies, this.lights] =
          await loadSceneFromURL(mujoco, initialScene, this);
        this.clearError();
        this._markReady('scene');
      } catch (error) {
        this.showError(`Failed to initialize scene "${initialScene}": ${this.formatError(error)}`);
        if (this.setSimStatus) this.setSimStatus('error');
        throw error;
      }
    });

    this._loadQueue = nextPromise.catch(() => {});
    await nextPromise;
  }

  async initializePythonEnvironment() {
    try {
      const pythonModule = await import(versioned('./pythonIntegration.js'));
      await pythonModule.initializePythonEnvironment(this);
      pythonModule.setupPythonIDE(this);
    } catch (error) {
      console.error("Error setting up Python environment:", error);
    }
  }

  async updatePythonEnvironment() {
    const { updatePythonEnvironment } = await import(versioned('./pythonIntegration.js'));
    await updatePythonEnvironment(this);
  }

  showError(message) {
    const errorLog = document.getElementById('error-log');
    if (!errorLog) return;

    const entry = document.createElement('div');
    entry.className = 'error-entry';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Build nodes rather than interpolating into innerHTML: `message` now
    // carries MuJoCo's compiler diagnostic, which quotes names straight out of
    // the scene XML. An uploaded or generated model containing markup in a
    // name attribute would otherwise execute here.
    const stamp = document.createElement('span');
    stamp.className = 'error-time';
    stamp.textContent = time;
    const body = document.createElement('span');
    body.className = 'error-text';   // white-space: pre-wrap, so multi-line diagnostics keep their shape
    body.textContent = message;
    entry.append(stamp, document.createTextNode(' '), body);

    errorLog.appendChild(entry);
    errorLog.scrollTop = errorLog.scrollHeight;

    const panel = document.getElementById('error-panel');
    if (panel) panel.style.display = 'flex';
  }

  clearError() {
    // no-op: errors remain in the log until user clears them
  }

  formatError(error) {
    if (!error) {
      return 'Unknown error';
    }

    if (typeof error === 'string') {
      return error;
    }

    return error.message || String(error);
  }

  onKeyDown(e) {
    // Don't hijack keys when the user is typing in the Python editor
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    if (document.getElementById('python-ide')?.contains(e.target)) return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        document.getElementById('pause-button')?.click();
        break;
      case 'r': case 'R':
        document.getElementById('reset-button')?.click();
        break;
      case 'e': case 'E':
        this.reloadScene().catch(() => { /* status handled in reloadScene */ });
        break;
    }
  }

  onWindowResize() {
    const appbody = document.getElementById('appbody');
    const width  = appbody.offsetWidth;
    const height = appbody.offsetHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  /**
   * Crash boundary around the frame.
   *
   * three.js's animation driver re-requests the frame *after* this callback
   * returns (WebGLAnimation.onAnimationFrame), so a throw here does not drop one
   * frame — it ends rendering for the rest of the session, and `isAnimating` stays
   * true so start() refuses to restart it. A failed MJCF compile used to land
   * exactly here, which made the agent's expected case fatal.
   *
   * This reports through two channels rather than swallowing: the error panel, and
   * window.onerror via a fresh task so the rAF chain above stays intact.
   */
  render(timeMS) {
    try {
      this._renderFrame(timeMS);
      this._frameCount++;
    } catch (err) {
      this._onRenderFault(err);
    }
  }

  /**
   * Last-resort recovery for a stopped animation loop.
   *
   * three.js cannot restart one by itself: once the callback throws, the frame is
   * never re-requested and `isAnimating` stays true, so `setAnimationLoop(cb)`
   * early-returns. Passing null first is the only sequence that revives it. The
   * crash boundary above should mean this never fires — it is here because a frozen
   * viewport with no explanation is the single worst outcome for this app.
   */
  _startRenderWatchdog() {
    let lastSeen = -1;
    setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        lastSeen = this._frameCount;
        return;
      }
      /*
       * An unrendered iframe gets no rAF callbacks at all, yet its document still
       * reports visibilityState 'visible' — visibility tracks the top-level
       * browsing context, not this frame's layout — so the guard above misses it.
       *
       * This is not hypothetical: the editor keeps the iframe display:none until
       * the bridge handshake completes (ProjectEditorShell renders it with
       * `display: phase === 'ready' ? 'block' : 'none'`). Without this check the
       * watchdog fired every 2s during startup, and forever if the handshake
       * failed — each time restarting a loop that cannot possibly produce a frame.
       *
       * Zero layout size is the reliable signal: a display:none iframe reports
       * innerWidth/innerHeight of 0.
       */
      if (typeof window !== 'undefined' && (window.innerWidth === 0 || window.innerHeight === 0)) {
        lastSeen = this._frameCount;
        return;
      }
      if (this._frameCount === lastSeen) {
        console.warn('[robospace] render loop stalled; restarting it');
        try {
          this.renderer.setAnimationLoop(null);
          this.renderer.setAnimationLoop(this.render.bind(this));
        } catch (e) {
          console.error('[robospace] could not restart the render loop:', e);
        }
      }
      lastSeen = this._frameCount;
    }, 2000);
  }

  _onRenderFault(err) {
    this._renderFaults++;
    console.error(`[robospace] render fault ${this._renderFaults}:`, err);
    if (this._renderFaults === 1) {
      this.showError(`Rendering error: ${this.formatError(err)}`);
      setTimeout(() => { throw err; });     // reaches window.onerror without unwinding rAF
    }
    if (this._renderFaults >= 3 && !this.params.paused) {
      this.params.paused = true;
      if (this.setSimStatus) this.setSimStatus('error');
      this.showError('Rendering paused after repeated errors. Load a scene to resume.');
    }
  }

  /**
   * A drag captured before a scene reload still holds a bodyID from the old model.
   * Indexing the new model with it returns undefined, which becomes a NaN force and
   * takes the entire simulation non-finite with no error anywhere. Validate instead
   * of trusting, and drop the stale drag when it does not fit.
   */
  _validDragBody() {
    const dragged = this.dragStateManager?.physicsObject;
    if (!dragged || !dragged.bodyID) return -1;
    const b = dragged.bodyID;
    if (b > 0 && b < this.model.nbody) return b;
    if (typeof this.dragStateManager.end === 'function') this.dragStateManager.end();
    return -1;
  }

  /** Cheap periodic tripwire. A silent NaN is the worst failure mode in this app:
   *  the scene simply stops responding and nothing is logged. */
  _checkFinite() {
    if (!this.simulation || Number.isFinite(this.simulation.qpos[0])) return;
    console.error('[robospace] simulation state went non-finite; pausing and resetting');
    this.params.paused = true;
    try {
      this.simulation.resetData();
      this.simulation.forward();
      this.simClock.reset(0);
    } catch (_) { /* best effort */ }
    if (this.setSimStatus) this.setSimStatus('error');
    this.showError('The simulation became numerically unstable (NaN) and has been paused and reset. '
      + 'This usually means interpenetrating geometry or an extreme applied force.');
  }

  _renderFrame(timeMS) {
    this.controls.update();

    // A failed compile leaves BOTH model and simulation null, because
    // loadSceneFromURL frees the old simulation before it compiles the new one.
    // Keep drawing so the camera still orbits; the error panel carries the reason.
    if (!this.model || !this.simulation) {
      this.renderer.render(this.scene, this.camera);
      return;
    }

    // Playing back a recording takes precedence over stepping. A synchronous script has
    // already advanced the physics to its end state; replaying the frames it recorded is
    // how the user sees the motion that got there. Stepping as well would race it.
    if (!this.params["paused"] && this.playback) {
      const { frames } = this.playback;
      const q = frames[this.playback.index++];
      if (q) {
        this.simulation.qpos.set(q);
        this.simulation.qvel.fill(0);      // a replay is kinematic, not re-simulated
        this.simulation.forward();
      }
      if (this.playback.index >= frames.length) {
        // Restore the true dynamic state the script actually left behind, so anything
        // read after playback matches what the script computed.
        const final = this.playback.finalState;
        if (final) {
          this.simulation.qpos.set(final.qpos);
          this.simulation.qvel.set(final.qvel);
          this.simulation.forward();
        }
        this.playback = null;
        this.mujoco_time = 0;              // force one resync rather than a catch-up burst
      }
      this._syncTransforms();
      this.renderer.render(this.scene, this.camera);
      this._releaseFrameWaiters();
      return;
    }

    if (!this.params["paused"]) {
      let timestep = this.model.getOptions().timestep;
      if (!(timestep > 0)) {
        // `mujoco_time += 0` never reaches timeMS, so the loop below would spin
        // forever and hang the tab rather than failing.
        throw new Error(`Refusing to step: model timestep is ${timestep}.`);
      }
      if (timeMS - this.mujoco_time > 35.0) { this.mujoco_time = timeMS; }
      let budget = MAX_STEPS_PER_FRAME;
      while (this.mujoco_time < timeMS && budget-- > 0) {

        // Jitter the control state with gaussian random noise
        if (this.params["ctrlnoisestd"] > 0.0) {
          let rate = Math.exp(-timestep / Math.max(1e-10, this.params["ctrlnoiserate"]));
          let scale = this.params["ctrlnoisestd"] * Math.sqrt(1 - rate * rate);
          let currentCtrl = this.simulation.ctrl;
          for (let i = 0; i < currentCtrl.length; i++) {
            currentCtrl[i] = rate * currentCtrl[i] + scale * standardNormal();
            this.params["Actuator " + i] = currentCtrl[i];
          }
        }

        for (let i = 0; i < this.simulation.qfrc_applied.length; i++) { this.simulation.qfrc_applied[i] = 0.0; }
        const bodyID = this._validDragBody();
        if (bodyID > 0) {
          for (let b = 0; b < this.model.nbody; b++) {
            if (this.bodies[b]) {
              getPosition(this.simulation.xpos, b, this.bodies[b].position);
              getQuaternion(this.simulation.xquat, b, this.bodies[b].quaternion);
              this.bodies[b].updateWorldMatrix();
            }
          }
          this.dragStateManager.update(); // Update the world-space force origin
          const mass = this.model.body_mass[bodyID];
          if (Number.isFinite(mass)) {
            let force = toMujocoPos(this.dragStateManager.currentWorld.clone().sub(this.dragStateManager.worldHit).multiplyScalar(mass * 250));
            let point = toMujocoPos(this.dragStateManager.worldHit.clone());
            this.simulation.applyForce(force.x, force.y, force.z, 0, 0, 0, point.x, point.y, point.z, bodyID);
          } else if (typeof this.dragStateManager.end === 'function') {
            this.dragStateManager.end();
          }
        }

        this.simulation.step();
        this.simClock.advance(1, timestep);

        // Feed live plotter (first 8 qpos values)
        if (this.livePlotter) {
          this.livePlotter.sample(Array.from(this.simulation.qpos).slice(0, 8));
        }

        this.mujoco_time += timestep * 1000.0;
      }
      if ((this._frameCount & 63) === 0) this._checkFinite();

    } else if (this.params["paused"]) {
      this.dragStateManager.update(); // Update the world-space force origin
      const b = this._validDragBody();
      if (b > 0) {
        getPosition(this.simulation.xpos, b, this.tmpVec, false); // Get raw coordinate from MuJoCo
        getQuaternion(this.simulation.xquat, b, this.tmpQuat, false); // Get raw coordinate from MuJoCo

        let offset = toMujocoPos(this.dragStateManager.currentWorld.clone()
          .sub(this.dragStateManager.worldHit).multiplyScalar(0.3));
        if (this.model.body_mocapid[b] >= 0) {
          // Set the root body's mocap position...
          console.log("Trying to move mocap body", b);
          let addr = this.model.body_mocapid[b] * 3;
          let pos = this.simulation.mocap_pos;
          pos[addr + 0] += offset.x;
          pos[addr + 1] += offset.y;
          pos[addr + 2] += offset.z;
        } else {
          // Set the root body's position directly...
          let root = this.model.body_rootid[b];
          let addr = this.model.jnt_qposadr[this.model.body_jntadr[root]];
          // A body with no joint gives body_jntadr === -1, so addr is undefined and
          // `pos[NaN] += x` writes nothing while silently poisoning nothing — but a
          // partially-valid addr would corrupt qpos. Only write a real slot.
          if (Number.isInteger(addr) && addr >= 0 && addr + 2 < this.simulation.qpos.length) {
            let pos = this.simulation.qpos;
            pos[addr + 0] += offset.x;
            pos[addr + 1] += offset.y;
            pos[addr + 2] += offset.z;
          }
        }
      }

      this.simulation.forward();
    }

    this._syncTransforms();

    // Render!
    this.renderer.render(this.scene, this.camera);
    this._releaseFrameWaiters();
  }

  /** Copies MuJoCo's poses onto the three.js objects. Shared by the stepping path and
   *  the playback path, which is why it is not inline. */
  _syncTransforms() {
    // Update body transforms.
    for (let b = 0; b < this.model.nbody; b++) {
      if (this.bodies[b]) {
        getPosition(this.simulation.xpos, b, this.bodies[b].position);
        getQuaternion(this.simulation.xquat, b, this.bodies[b].quaternion);
        this.bodies[b].updateWorldMatrix();
      }
    }

    // Update light transforms.
    for (let l = 0; l < this.model.nlight; l++) {
      if (this.lights[l]) {
        getPosition(this.simulation.light_xpos, l, this.lights[l].position);
        getPosition(this.simulation.light_xdir, l, this.tmpVec);
        this.lights[l].lookAt(this.tmpVec.add(this.lights[l].position));
      }
    }

    // Update tendon transforms.
    let numWraps = 0;
    if (this.mujocoRoot && this.mujocoRoot.cylinders) {
      let mat = new THREE.Matrix4();
      for (let t = 0; t < this.model.ntendon; t++) {
        let startW = this.simulation.ten_wrapadr[t];
        let r = this.model.tendon_width[t];
        for (let w = startW; w < startW + this.simulation.ten_wrapnum[t] - 1; w++) {
          let tendonStart = getPosition(this.simulation.wrap_xpos, w, new THREE.Vector3());
          let tendonEnd = getPosition(this.simulation.wrap_xpos, w + 1, new THREE.Vector3());
          let tendonAvg = new THREE.Vector3().addVectors(tendonStart, tendonEnd).multiplyScalar(0.5);

          let validStart = tendonStart.length() > 0.01;
          let validEnd = tendonEnd.length() > 0.01;

          if (validStart) { this.mujocoRoot.spheres.setMatrixAt(numWraps, mat.compose(tendonStart, new THREE.Quaternion(), new THREE.Vector3(r, r, r))); }
          if (validEnd) { this.mujocoRoot.spheres.setMatrixAt(numWraps + 1, mat.compose(tendonEnd, new THREE.Quaternion(), new THREE.Vector3(r, r, r))); }
          if (validStart && validEnd) {
            mat.compose(tendonAvg, new THREE.Quaternion().setFromUnitVectors(
              new THREE.Vector3(0, 1, 0), tendonEnd.clone().sub(tendonStart).normalize()),
              new THREE.Vector3(r, tendonStart.distanceTo(tendonEnd), r));
            this.mujocoRoot.cylinders.setMatrixAt(numWraps, mat);
            numWraps++;
          }
        }
      }
      this.mujocoRoot.cylinders.count = numWraps;
      this.mujocoRoot.spheres.count = numWraps > 0 ? numWraps + 1 : 0;
      this.mujocoRoot.cylinders.instanceMatrix.needsUpdate = true;
      this.mujocoRoot.spheres.instanceMatrix.needsUpdate = true;
    }
  }

  /** Releases anything awaiting a frame. Called after rendering, so a waiter observes
   *  the physics and poses of the frame just drawn rather than the previous one. The
   *  array is swapped out first: a resolver may synchronously queue another wait, and
   *  appending to the array being iterated would spin forever. */
  _releaseFrameWaiters() {
    if (!this._frameWaiters.length) return;
    const waiters = this._frameWaiters;
    this._frameWaiters = [];
    for (const resolve of waiters) {
      try { resolve(); } catch (e) { console.error('[robospace] frame waiter threw:', e); }
    }
  }
}

setStage('constructing the simulator');
let demo = new RoboSpaceDemo();
window._roboDemo = demo;  // expose for IDE resize handle

setStage('loading the initial scene');
await demo.init();

setStage('ready');
console.log('[robospace] ready');

// Dev/QA entry point:  await robospaceLoadRobot('stretch_3')
//
// Fetches a robot from mujoco_menagerie and stands it on a checkered floor. It
// runs through writeGeneratedScene(), the same path the scene-generation agent
// uses via ParentBridge → APPLY_SCENE, so checking it by hand exercises the real
// code — including rendering, which the Node test suites cannot cover.
window.robospaceListRobots = () => {
  // Static import would be cleaner, but keeping the manifest out of the initial
  // module graph avoids paying for it on a page load that never loads a robot.
  return ['franka_panda', 'stretch_3'];
};

// These loaders are driven from the Python editor as often as from the console, and a
// 33-73 MB download reported only to devtools looks like a hang to someone watching
// the output panel. robospaceLog mirrors to both; it is defined by
// initializePythonEnvironment, so fall back to the console before Pyodide is up.
const say = (text, level = 'log') => {
  if (typeof window.robospaceLog === 'function') window.robospaceLog(text, level);
  else if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
};

window.robospaceLoadRobot = async (packId = 'franka_panda') => {
  const { writeGeneratedScene, defaultRobotScene } = await import(versioned('./utils/sceneWriter.js'));
  const { ROBOT_MANIFESTS } = await import(versioned('./utils/robotPacks.js'));

  // Own-property lookup, matching ensureRobotPack: a bare index resolves
  // "__proto__" to a truthy object that slips past this guard and then fails
  // further in with an unhelpful error.
  const manifest = Object.prototype.hasOwnProperty.call(ROBOT_MANIFESTS, packId)
    ? ROBOT_MANIFESTS[packId]
    : null;
  if (!manifest) {
    say(`Unknown robot "${packId}". Try one of: ${Object.keys(ROBOT_MANIFESTS).join(', ')}`, 'error');
    return null;
  }
  say(`Loading ${packId}: ${manifest.files.length} files, ${(manifest.totalBytes / 1048576).toFixed(1)} MB (cached after the first run)`);

  let lastLogged = 0;
  const started = performance.now();
  try {
    const result = await writeGeneratedScene(demo, {
      sceneName: `${packId}_dev`,
      robotPack: packId,
      files: [{ path: 'scene.xml', content: defaultRobotScene(manifest.entry, `${packId} dev scene`) }],
      onProgress: ({ done, total, bytes, totalBytes }) => {
        if (bytes - lastLogged < totalBytes / 5 && done !== total) return;
        lastLogged = bytes;
        say(`  ${done}/${total} files, ${(bytes / 1048576).toFixed(1)}/${(totalBytes / 1048576).toFixed(1)} MB`);
      },
    });
    say(`Loaded in ${((performance.now() - started) / 1000).toFixed(1)}s`);
    for (const p of result.patched) {
      say(`  patched ${p.path}: ${p.notes.join('; ')}`, 'warn');
    }
    say(`  settled ${result.settled.steps} steps (${result.settled.seconds.toFixed(2)}s)${result.settled.atRest ? ' — at rest' : ' — still moving when the budget ran out'}`);
    say(`  nq=${result.modelStats.nq} nv=${result.modelStats.nv} nu=${result.modelStats.nu}`);
    say(`  actuators: ${result.modelStats.actuatorNames.join(', ')}`);
    return result;
  } catch (err) {
    say(`Failed to load ${packId}: ${err.message}`, 'error');
    if (err.code === 'MJCF_COMPILE_ERROR' && !err.mujocoDiagnostic) {
      say('  (MuJoCo gave no diagnostic — see compileModel() in mujocoUtils.js for why)', 'error');
    }
    throw err;
  }
};

// Author a whole scene, rather than standing a robot on the default floor:
//   await robospaceLoadScene('<mujoco>…</mujoco>', 'franka_panda', 'pick')
//
// Positional arguments on purpose — Pyodide wraps a Python dict as a PyProxy that
// this side cannot destructure, the same trap set_control() documents.
//
// Same writeGeneratedScene path as robospaceLoadRobot and APPLY_SCENE, so a scene
// built here behaves exactly like one the agent produces.
window.robospaceLoadScene = async (xml, robotPack = null, sceneName = 'python_scene') => {
  if (typeof xml !== 'string' || !xml.trim()) throw new Error('load_scene needs the scene XML as a string.');
  const pack = robotPack || null;      // Python None arrives as '' or undefined
  const { writeGeneratedScene } = await import(versioned('./utils/sceneWriter.js'));

  // <include> must be the FIRST element. applyHomePose writes the leading
  // qpos/ctrl slots, and those only belong to the robot if its bodies were
  // created first. Get this wrong and the home pose is silently applied to
  // whatever the scene declared instead — no error, just a robot in a strange
  // pose and a cube that teleports.
  if (pack) {
    const body = xml.replace(/<!--[\s\S]*?-->/g, '');
    const open = body.indexOf('<mujoco');
    const after = open < 0 ? '' : body.slice(body.indexOf('>', open) + 1);
    const first = /<\s*([A-Za-z_][\w.-]*)/.exec(after);
    if (first && first[1] !== 'include') {
      say(`<include> should be the first element inside <mujoco>, but found <${first[1]}>. `
        + "The robot's home pose may be applied to the wrong joints.", 'warn');
    }
  }

  let lastLogged = 0;
  const started = performance.now();
  try {
    const result = await writeGeneratedScene(demo, {
      sceneName,
      robotPack: pack,
      files: [{ path: 'scene.xml', content: xml }],
      onProgress: ({ done, total, bytes, totalBytes }) => {
        if (bytes - lastLogged < totalBytes / 5 && done !== total) return;
        lastLogged = bytes;
        say(`  ${done}/${total} files, ${(bytes / 1048576).toFixed(1)}/${(totalBytes / 1048576).toFixed(1)} MB`);
      },
    });
    say(`Scene "${sceneName}" loaded in ${((performance.now() - started) / 1000).toFixed(1)}s`);
    for (const p of result.patched) say(`  patched ${p.path}: ${p.notes.join('; ')}`, 'warn');
    return result;
  } catch (err) {
    say(`Failed to load scene "${sceneName}": ${err.message}`, 'error');
    throw err;
  }
};
