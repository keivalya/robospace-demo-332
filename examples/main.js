// main.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DragStateManager } from './utils/DragStateManager.js';
import { downloadExampleScenesFolder, loadSceneFromURL, getPosition, getQuaternion, toMujocoPos, standardNormal } from './mujocoUtils.js';
import load_mujoco from '../dist/mujoco_wasm.js';
import { FileUploadManager } from './utils/FileUploadManager.js';
import { LivePlotter } from './utils/LivePlotter.js';

const loadPyodide = window.loadPyodide;
// Load the MuJoCo Module
const mujoco = await load_mujoco();

// Set up Emscripten's Virtual File System
const STORAGE_KEY_SCENE = 'robospace_last_scene';
var initialScene = localStorage.getItem(STORAGE_KEY_SCENE) || "universal_robots_ur5e/scene.xml";
mujoco.FS.mkdir('/working');
mujoco.FS.mount(mujoco.MEMFS, { root: '.' }, '/working');
await downloadExampleScenesFolder(mujoco);
mujoco.FS.writeFile("/working/" + initialScene, await (await fetch("./examples/scenes/" + initialScene)).text());

export class RoboSpaceDemo {
  constructor() {
    this.mujoco = mujoco;

    // Load in the state from XML
    this.model = new mujoco.Model("/working/" + initialScene);
    this.state = new mujoco.State(this.model);
    this.simulation = new mujoco.Simulation(this.model, this.state);

    // Define Random State Variables
    this.params = { scene: initialScene, paused: false, help: false, ctrlnoiserate: 0.0, ctrlnoisestd: 0.0, keyframeNumber: 0 };
    this.mujoco_time = 0.0;
    this.bodies = {}, this.lights = {};
    this.tmpVec = new THREE.Vector3();
    this.tmpQuat = new THREE.Quaternion();
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
    // Cap at 2× to avoid excessive GPU load on very high-DPI screens
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Initial size — will be corrected by onWindowResize() called below.
    // false = don't touch canvas inline style; CSS fills appbody via position:absolute.
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap; // default THREE.PCFShadowMap
    this.renderer.setAnimationLoop(this.render.bind(this));

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
    // Upload Robot UI is omitted from the new layout; re-introduce via the
    // Program panel kebab menu when needed (FileUploadManager class still works).

    this.livePlotter = new LivePlotter();
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
      localStorage.setItem(STORAGE_KEY_SCENE, this.params.scene);
      if (this.setSimStatus) this.setSimStatus('loading');
      try {
        await this.reloadScene();
        if (this.setSimStatus) this.setSimStatus('ready');
      } catch (err) {
        if (this.setSimStatus) this.setSimStatus('error');
      }
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
      }
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
          if (this.setSimStatus) this.setSimStatus('loading');
          try {
            await this.reloadScene();
            if (this.setSimStatus) this.setSimStatus('ready');
          } catch (err) {
            if (this.setSimStatus) this.setSimStatus('error');
          }
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
      const { PYTHON_EXAMPLES } = await import('./pythonIntegration.js');
      const host = document.getElementById('ide-examples-list');
      if (!host || !PYTHON_EXAMPLES) return;
      const labels = {
        basic_control:   'Basic Control',
        sine_wave:       'Sine Wave',
        walking_pattern: 'Walking Pattern',
        pd_control:      'PD Controller',
        oscillation:     'Multi-freq Oscillation',
        info:            'Print System Info',
      };
      Object.entries(labels).forEach(([key, label]) => {
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

  async reloadScene() {
    this.clearError();

    // Delete the old scene and load the new scene
    this.scene.remove(this.scene.getObjectByName("MuJoCo Root"));

    try {
      [this.model, this.state, this.simulation, this.bodies, this.lights] =
        await loadSceneFromURL(this.mujoco, this.params.scene, this);
      this.simulation.forward();
    } catch (error) {
      this.showError(`Failed to load scene "${this.params.scene}": ${this.formatError(error)}`);
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

    // Camera reset
    this.camera.position.set(2.0, 1.7, 1.7);
    this.controls.target.set(0, 0.7, 0);
    this.controls.update();
  }

  async init() {
    // Download the the examples to MuJoCo's virtual file system
    await downloadExampleScenesFolder(mujoco);

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
  }

  async initializePythonEnvironment() {
    try {
      const pythonModule = await import('./pythonIntegration.js');
      await pythonModule.initializePythonEnvironment(this);
      pythonModule.setupPythonIDE(this);
    } catch (error) {
      console.error("Error setting up Python environment:", error);
    }
  }

  async updatePythonEnvironment() {
    const { updatePythonEnvironment } = await import('./pythonIntegration.js');
    await updatePythonEnvironment(this);
  }

  showError(message) {
    const errorLog = document.getElementById('error-log');
    if (!errorLog) return;

    const entry = document.createElement('div');
    entry.className = 'error-entry';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    entry.innerHTML = `<span class="error-time">${time}</span> ${message}`;
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
        if (this.setSimStatus) this.setSimStatus('loading');
        this.reloadScene()
          .then(() => this.setSimStatus && this.setSimStatus('ready'))
          .catch(() => this.setSimStatus && this.setSimStatus('error'));
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

  render(timeMS) {
    this.controls.update();

    if (!this.params["paused"]) {
      let timestep = this.model.getOptions().timestep;
      if (timeMS - this.mujoco_time > 35.0) { this.mujoco_time = timeMS; }
      while (this.mujoco_time < timeMS) {

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
        let dragged = this.dragStateManager.physicsObject;
        if (dragged && dragged.bodyID) {
          for (let b = 0; b < this.model.nbody; b++) {
            if (this.bodies[b]) {
              getPosition(this.simulation.xpos, b, this.bodies[b].position);
              getQuaternion(this.simulation.xquat, b, this.bodies[b].quaternion);
              this.bodies[b].updateWorldMatrix();
            }
          }
          let bodyID = dragged.bodyID;
          this.dragStateManager.update(); // Update the world-space force origin
          let force = toMujocoPos(this.dragStateManager.currentWorld.clone().sub(this.dragStateManager.worldHit).multiplyScalar(this.model.body_mass[bodyID] * 250));
          let point = toMujocoPos(this.dragStateManager.worldHit.clone());
          this.simulation.applyForce(force.x, force.y, force.z, 0, 0, 0, point.x, point.y, point.z, bodyID);
        }

        this.simulation.step();

        // Feed live plotter (first 8 qpos values)
        if (this.livePlotter) {
          this.livePlotter.sample(Array.from(this.simulation.qpos).slice(0, 8));
        }

        this.mujoco_time += timestep * 1000.0;
      }

    } else if (this.params["paused"]) {
      this.dragStateManager.update(); // Update the world-space force origin
      let dragged = this.dragStateManager.physicsObject;
      if (dragged && dragged.bodyID) {
        let b = dragged.bodyID;
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
          let pos = this.simulation.qpos;
          pos[addr + 0] += offset.x;
          pos[addr + 1] += offset.y;
          pos[addr + 2] += offset.z;
        }
      }

      this.simulation.forward();
    }

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

    // Render!
    this.renderer.render(this.scene, this.camera);
  }
}

let demo = new RoboSpaceDemo();
window._roboDemo = demo;  // expose for IDE resize handle
await demo.init();
