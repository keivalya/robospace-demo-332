
import * as THREE           from 'three';
import { GUI              } from '../node_modules/three/examples/jsm/libs/lil-gui.module.min.js';
import { OrbitControls    } from '../node_modules/three/examples/jsm/controls/OrbitControls.js';
import { DragStateManager } from './utils/DragStateManager.js';
import { setupGUI, downloadExampleScenesFolder, loadSceneFromURL, getPosition, getQuaternion, toMujocoPos, standardNormal } from './mujocoUtils.js';
import   load_mujoco        from '../dist/mujoco_wasm.js';

const loadPyodide = window.loadPyodide;
// Load the MuJoCo Module
const mujoco = await load_mujoco();

// Set up Emscripten's Virtual File System
var initialScene = "boston_dynamics_spot/scene_arm.xml";
mujoco.FS.mkdir('/working');
mujoco.FS.mount(mujoco.MEMFS, { root: '.' }, '/working');
await downloadExampleScenesFolder(mujoco);
mujoco.FS.writeFile("/working/" + initialScene, await(await fetch("./examples/scenes/" + initialScene)).text());

export class MuJoCoDemo {
  constructor() {
    this.mujoco = mujoco;

    // Load in the state from XML
    this.model      = new mujoco.Model("/working/" + initialScene);
    this.state      = new mujoco.State(this.model);
    this.simulation = new mujoco.Simulation(this.model, this.state);

    // Define Random State Variables
    this.params = { scene: initialScene, paused: false, help: false, ctrlnoiserate: 0.0, ctrlnoisestd: 0.0, keyframeNumber: 0 };
    this.mujoco_time = 0.0;
    this.bodies  = {}, this.lights = {};
    this.tmpVec  = new THREE.Vector3();
    this.tmpQuat = new THREE.Quaternion();
    this.updateGUICallbacks = [];
    this.setupToolbar();
    this.setupPythonIntegration();

    // this.container = document.createElement( 'div' );
    // document.body.appendChild( this.container );
    this.container = document.getElementById('appbody');

    this.scene = new THREE.Scene();
    this.scene.name = 'scene';

    this.camera = new THREE.PerspectiveCamera( 45, window.innerWidth / window.innerHeight, 0.001, 100 );
    this.camera.name = 'PerspectiveCamera';
    this.camera.position.set(2.0, 1.7, 1.7);
    this.scene.add(this.camera);

    this.scene.background = new THREE.Color(0.15, 0.25, 0.35);
    this.scene.fog = new THREE.Fog(this.scene.background, 15, 25.5 );

    this.ambientLight = new THREE.AmbientLight( 0xffffff, 0.1 );
    this.ambientLight.name = 'AmbientLight';
    this.scene.add( this.ambientLight );

    this.renderer = new THREE.WebGLRenderer( { antialias: true } );
    this.renderer.setPixelRatio( window.devicePixelRatio );
    // this.renderer.setSize( window.innerWidth, window.innerHeight );
    const width = window.innerWidth - 40; // Account for collapsed robot info panel
    const height = window.innerHeight - 60 - 250; // Account for toolbar and python IDE
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap; // default THREE.PCFShadowMap
    this.renderer.setAnimationLoop( this.render.bind(this) );

    this.container.appendChild( this.renderer.domElement );

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.7, 0);
    this.controls.panSpeed = 2;
    this.controls.zoomSpeed = 1;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.10;
    this.controls.screenSpacePanning = true;
    this.controls.update();

    window.addEventListener('resize', this.onWindowResize.bind(this));

    // Initialize the Drag State Manager.
    this.dragStateManager = new DragStateManager(this.scene, this.renderer, this.camera, this.container.parentElement, this.controls);
    this.onWindowResize();
  }

  setupToolbar() {
    // Scene selector
    const sceneSelector = document.getElementById('scene-selector');
    const scenes = {
        "Spot Robot with Arm": "boston_dynamics_spot/scene_arm.xml",
        "Spot Robot": "boston_dynamics_spot/scene.xml",
        "Unitree H1": "unitree_h1/scene.xml",
        "Universal Robots UR5e": "universal_robots_ur5e/scene.xml",
        "Google Barkour VB": "google_barkour_vb/scene.xml",
    };
    
    // Populate scene selector
    Object.entries(scenes).forEach(([name, file]) => {
        const option = document.createElement('option');
        option.value = file;
        option.textContent = name;
        if (file === this.params.scene) option.selected = true;
        sceneSelector.appendChild(option);
    });
    
    sceneSelector.addEventListener('change', async (e) => {
        this.params.scene = e.target.value;
        await this.reloadScene();
    });
    
    // Pause button
    const pauseButton = document.getElementById('pause-button');
    pauseButton.addEventListener('click', () => {
        this.params.paused = !this.params.paused;
        pauseButton.textContent = this.params.paused ? '▶ Play' : '⏸ Pause';
        pauseButton.classList.toggle('active', this.params.paused);
    });
    
    // Reset button
    document.getElementById('reset-button').addEventListener('click', () => {
        if (this.simulation) {
            this.simulation.resetData();
            this.simulation.forward();
        }
    });
    
    // Reload button
    document.getElementById('reload-button').addEventListener('click', async () => {
        await this.reloadScene();
    });
    
    // Noise sliders
    const noiseRateSlider = document.getElementById('noise-rate-slider');
    const noiseRateValue = document.getElementById('noise-rate-value');
    noiseRateSlider.value = this.params.ctrlnoiserate;
    noiseRateValue.textContent = this.params.ctrlnoiserate.toFixed(2);
    
    noiseRateSlider.addEventListener('input', (e) => {
        this.params.ctrlnoiserate = parseFloat(e.target.value);
        noiseRateValue.textContent = this.params.ctrlnoiserate.toFixed(2);
    });
    
    const noiseScaleSlider = document.getElementById('noise-scale-slider');
    const noiseScaleValue = document.getElementById('noise-scale-value');
    noiseScaleSlider.value = this.params.ctrlnoisestd;
    noiseScaleValue.textContent = this.params.ctrlnoisestd.toFixed(2);
    
    noiseScaleSlider.addEventListener('input', (e) => {
        this.params.ctrlnoisestd = parseFloat(e.target.value);
        noiseScaleValue.textContent = this.params.ctrlnoisestd.toFixed(2);
    });
}

async setupPythonIntegration() {
  // Initialize Pyodide
  if (window.pyodide) return; // Already loaded
  
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
  }
}

async reloadScene() {
    // Delete the old scene and load the new scene
    this.scene.remove(this.scene.getObjectByName("MuJoCo Root"));
    [this.model, this.state, this.simulation, this.bodies, this.lights] =
        await loadSceneFromURL(this.mujoco, this.params.scene, this);
    this.simulation.forward();
    
    // Update robot info
    this.updateRobotInfo();
    
    // Update Python environment
    if (window.pyodide) {
        await this.updatePythonEnvironment();
    }
    
    // Camera reset
    this.camera.position.set(2.0, 1.7, 1.7);
    this.controls.target.set(0, 0.7, 0);
    this.controls.update();
}

updateRobotInfo() {
    if (!this.model) return;
    
    // Update model name
    document.getElementById('model-name').textContent = this.params.scene.replace('.xml', '');
    document.getElementById('body-count').textContent = this.model.nbody;
    document.getElementById('joint-count').textContent = this.model.njnt;
    
    // Update joints table
    const tbody = document.getElementById('joints-tbody');
    tbody.innerHTML = '';
    
    // Get joint and actuator information
    const textDecoder = new TextDecoder("utf-8");
    const names = textDecoder.decode(this.model.names).split('\0');
    
    for (let i = 0; i < this.model.nu; i++) {
        const row = document.createElement('tr');
        
        const nameIndex = this.model.name_actuatoradr[i];
        const name = names[nameIndex] || `actuator_${i}`;
        
        let range = [-1, 1];
        if (this.model.actuator_ctrllimited[i]) {
            const rangeStart = i * 2;
            range = [
                this.model.actuator_ctrlrange[rangeStart],
                this.model.actuator_ctrlrange[rangeStart + 1]
            ];
        }
        
        row.innerHTML = `
            <td>${i}</td>
            <td>${name}</td>
            <td>actuator</td>
            <td>[${range[0].toFixed(2)}, ${range[1].toFixed(2)}]</td>
            <td class="joint-value" id="joint-val-${i}">0.00</td>
        `;
        
        tbody.appendChild(row);
    }
}

  async init() {
    // Download the the examples to MuJoCo's virtual file system
    await downloadExampleScenesFolder(mujoco);

    // Initialize the three.js Scene using the .xml Model in initialScene
    [this.model, this.state, this.simulation, this.bodies, this.lights] =  
      await loadSceneFromURL(mujoco, initialScene, this);

    // this.gui = new GUI();
    // setupGUI(this);
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

  onWindowResize() {
    const toolbar = document.getElementById('toolbar');
    const pythonIDE = document.getElementById('python-ide');
    const robotInfo = document.getElementById('robot-info');
    
    // Calculate available space
    const toolbarHeight = 60;
    const ideHeight = pythonIDE.classList.contains('collapsed') ? 40 : 250;
    // const infoWidth = robotInfo.classList.contains('collapsed') ? 40 : 400;
    
    const width = window.innerWidth;
    const height = window.innerHeight - toolbarHeight - ideHeight;
    
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
          let rate  = Math.exp(-timestep / Math.max(1e-10, this.params["ctrlnoiserate"]));
          let scale = this.params["ctrlnoisestd"] * Math.sqrt(1 - rate * rate);
          let currentCtrl = this.simulation.ctrl;
          for (let i = 0; i < currentCtrl.length; i++) {
            currentCtrl[i] = rate * currentCtrl[i] + scale * standardNormal();
            this.params["Actuator " + i] = currentCtrl[i];
          }
        }

        // Update joint value displays
        if (this.model && this.simulation) {
            for (let i = 0; i < this.model.nu; i++) {
                const element = document.getElementById(`joint-val-${i}`);
                if (element) {
                    element.textContent = this.simulation.ctrl[i].toFixed(2);
                }
            }
        }

        for (let i = 0; i < this.simulation.qfrc_applied.length; i++) { this.simulation.qfrc_applied[i] = 0.0; }
        let dragged = this.dragStateManager.physicsObject;
        if (dragged && dragged.bodyID) {
          for (let b = 0; b < this.model.nbody; b++) {
            if (this.bodies[b]) {
              getPosition  (this.simulation.xpos , b, this.bodies[b].position);
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

        this.mujoco_time += timestep * 1000.0;
      }

    } else if (this.params["paused"]) {
      this.dragStateManager.update(); // Update the world-space force origin
      let dragged = this.dragStateManager.physicsObject;
      if (dragged && dragged.bodyID) {
        let b = dragged.bodyID;
        getPosition  (this.simulation.xpos , b, this.tmpVec , false); // Get raw coordinate from MuJoCo
        getQuaternion(this.simulation.xquat, b, this.tmpQuat, false); // Get raw coordinate from MuJoCo

        let offset = toMujocoPos(this.dragStateManager.currentWorld.clone()
          .sub(this.dragStateManager.worldHit).multiplyScalar(0.3));
        if (this.model.body_mocapid[b] >= 0) {
          // Set the root body's mocap position...
          console.log("Trying to move mocap body", b);
          let addr = this.model.body_mocapid[b] * 3;
          let pos  = this.simulation.mocap_pos;
          pos[addr+0] += offset.x;
          pos[addr+1] += offset.y;
          pos[addr+2] += offset.z;
        } else {
          // Set the root body's position directly...
          let root = this.model.body_rootid[b];
          let addr = this.model.jnt_qposadr[this.model.body_jntadr[root]];
          let pos  = this.simulation.qpos;
          pos[addr+0] += offset.x;
          pos[addr+1] += offset.y;
          pos[addr+2] += offset.z;
        }
      }

      this.simulation.forward();
    }

    // Update body transforms.
    for (let b = 0; b < this.model.nbody; b++) {
      if (this.bodies[b]) {
        getPosition  (this.simulation.xpos , b, this.bodies[b].position);
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
        for (let w = startW; w < startW + this.simulation.ten_wrapnum[t] -1 ; w++) {
          let tendonStart = getPosition(this.simulation.wrap_xpos, w    , new THREE.Vector3());
          let tendonEnd   = getPosition(this.simulation.wrap_xpos, w + 1, new THREE.Vector3());
          let tendonAvg   = new THREE.Vector3().addVectors(tendonStart, tendonEnd).multiplyScalar(0.5);

          let validStart = tendonStart.length() > 0.01;
          let validEnd   = tendonEnd  .length() > 0.01;

          if (validStart) { this.mujocoRoot.spheres.setMatrixAt(numWraps    , mat.compose(tendonStart, new THREE.Quaternion(), new THREE.Vector3(r, r, r))); }
          if (validEnd  ) { this.mujocoRoot.spheres.setMatrixAt(numWraps + 1, mat.compose(tendonEnd  , new THREE.Quaternion(), new THREE.Vector3(r, r, r))); }
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
      this.mujocoRoot.spheres  .count = numWraps > 0 ? numWraps + 1: 0;
      this.mujocoRoot.cylinders.instanceMatrix.needsUpdate = true;
      this.mujocoRoot.spheres  .instanceMatrix.needsUpdate = true;
    }

    // Render!
    this.renderer.render( this.scene, this.camera );
  }
}

let demo = new MuJoCoDemo();
await demo.init();
