// mujocoUtils.js
import * as THREE from 'three';
import { Reflector  } from './utils/Reflector.js';
import { clearMjLog, drainMjLog } from './utils/mujocoLog.js';
// NOTE: do NOT `import { RoboSpaceDemo } from './main.js'`.
// It was used only for JSDoc @param types, but importing main.js without the
// cache-bust query string causes the browser to load it as a *separate* module
// instance — running `new RoboSpaceDemo()` a second time, producing two
// simulations, two render loops, and duplicate event listeners.

export async function reloadFunc() {
  // Delete the old scene and load the new scene
  const oldRoot = this.scene.getObjectByName("MuJoCo Root");
  if (oldRoot && oldRoot.parent) {
    oldRoot.parent.remove(oldRoot);
  }
  [this.model, this.state, this.simulation, this.bodies, this.lights] =
    await loadSceneFromURL(this.mujoco, this.params.scene, this);
  this.simulation.forward();
  for (let i = 0; i < this.updateGUICallbacks.length; i++) {
    this.updateGUICallbacks[i](this.model, this.simulation, this.params);
  }
}

/** @param {RoboSpaceDemo} parentContext*/
export function setupGUI(parentContext) {

  // Make sure we reset the camera when the scene is changed or reloaded.
  parentContext.updateGUICallbacks.length = 0;
  parentContext.updateGUICallbacks.push((model, simulation, params) => {
    // TODO: Use free camera parameters from MuJoCo
    parentContext.camera.position.set(2.0, 1.7, 1.7);
    parentContext.controls.target.set(0, 0.7, 0);
    parentContext.controls.update(); });

  // Add scene selection dropdown.
  // let reload = reloadFunc.bind(parentContext);
  // parentContext.gui.add(parentContext.params, 'scene', {
  //   "Spot Robot with Arm": "boston_dynamics_spot/scene_arm.xml",
  //   "Spot Robot": "boston_dynamics_spot/scene.xml",
  //   "Unitree G1": "unitree_g1/scene.xml",
  //   "Universal Robots UR5e": "universal_robots_ur5e/scene.xml",
  // }).name('Example Scene').onChange(reload);

  // Add a help menu.
  // Parameters:
  //  Name: "Help".
  //  When pressed, a help menu is displayed in the top left corner. When pressed again
  //  the help menu is removed.
  //  Can also be triggered by pressing F1.
  // Has a dark transparent background.
  // Has two columns: one for putting the action description, and one for the action key trigger.keyframeNumber
  let keyInnerHTML = '';
  let actionInnerHTML = '';
  const displayHelpMenu = () => {
    if (parentContext.params.help) {
      const helpMenu = document.createElement('div');
      helpMenu.style.position = 'absolute';
      helpMenu.style.top = '10px';
      helpMenu.style.left = '10px';
      helpMenu.style.color = 'white';
      helpMenu.style.font = 'normal 18px Arial';
      helpMenu.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
      helpMenu.style.padding = '10px';
      helpMenu.style.borderRadius = '10px';
      helpMenu.style.display = 'flex';
      helpMenu.style.flexDirection = 'column';
      helpMenu.style.alignItems = 'center';
      helpMenu.style.justifyContent = 'center';
      helpMenu.style.width = '400px';
      helpMenu.style.height = '400px';
      helpMenu.style.overflow = 'auto';
      helpMenu.style.zIndex = '1000';

      const helpMenuTitle = document.createElement('div');
      helpMenuTitle.style.font = 'bold 24px Arial';
      helpMenuTitle.innerHTML = '';
      helpMenu.appendChild(helpMenuTitle);

      const helpMenuTable = document.createElement('table');
      helpMenuTable.style.width = '100%';
      helpMenuTable.style.marginTop = '10px';
      helpMenu.appendChild(helpMenuTable);

      const helpMenuTableBody = document.createElement('tbody');
      helpMenuTable.appendChild(helpMenuTableBody);

      const helpMenuRow = document.createElement('tr');
      helpMenuTableBody.appendChild(helpMenuRow);

      const helpMenuActionColumn = document.createElement('td');
      helpMenuActionColumn.style.width = '50%';
      helpMenuActionColumn.style.textAlign = 'right';
      helpMenuActionColumn.style.paddingRight = '10px';
      helpMenuRow.appendChild(helpMenuActionColumn);

      const helpMenuKeyColumn = document.createElement('td');
      helpMenuKeyColumn.style.width = '50%';
      helpMenuKeyColumn.style.textAlign = 'left';
      helpMenuKeyColumn.style.paddingLeft = '10px';
      helpMenuRow.appendChild(helpMenuKeyColumn);

      const helpMenuActionText = document.createElement('div');
      helpMenuActionText.innerHTML = actionInnerHTML;
      helpMenuActionColumn.appendChild(helpMenuActionText);

      const helpMenuKeyText = document.createElement('div');
      helpMenuKeyText.innerHTML = keyInnerHTML;
      helpMenuKeyColumn.appendChild(helpMenuKeyText);

      // Close buttom in the top.
      const helpMenuCloseButton = document.createElement('button');
      helpMenuCloseButton.innerHTML = 'Close';
      helpMenuCloseButton.style.position = 'absolute';
      helpMenuCloseButton.style.top = '10px';
      helpMenuCloseButton.style.right = '10px';
      helpMenuCloseButton.style.zIndex = '1001';
      helpMenuCloseButton.onclick = () => {
        helpMenu.remove();
      };
      helpMenu.appendChild(helpMenuCloseButton);

      document.body.appendChild(helpMenu);
    } else {
      document.body.removeChild(document.body.lastChild);
    }
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'F1') {
      parentContext.params.help = !parentContext.params.help;
      displayHelpMenu();
      event.preventDefault();
    }
  });
  keyInnerHTML += 'F1<br>';
  actionInnerHTML += 'Help<br>';

  let simulationFolder = parentContext.gui.addFolder("Simulation");

  // Add pause simulation checkbox.
  // Parameters:
  //  Under "Simulation" folder.
  //  Name: "Pause Simulation".
  //  When paused, a "pause" text in white is displayed in the top left corner.
  //  Can also be triggered by pressing the spacebar.
  const pauseSimulation = simulationFolder.add(parentContext.params, 'paused').name('Pause Simulation');
  pauseSimulation.onChange((value) => {
    if (value) {
      const pausedText = document.createElement('div');
      pausedText.style.position = 'absolute';
      pausedText.style.top = '10px';
      pausedText.style.left = '10px';
      pausedText.style.color = 'white';
      pausedText.style.font = 'normal 18px Arial';
      pausedText.innerHTML = 'pause';
      parentContext.container.appendChild(pausedText);
    } else {
      parentContext.container.removeChild(parentContext.container.lastChild);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.code === 'Space') {
      parentContext.params.paused = !parentContext.params.paused;
      pauseSimulation.setValue(parentContext.params.paused);
      event.preventDefault();
    }
  });
  actionInnerHTML += 'Play / Pause<br>';
  keyInnerHTML += 'Space<br>';

  // Add reload model button.
  // Parameters:
  //  Under "Simulation" folder.
  //  Name: "Reload".
  //  When pressed, calls the reload function.
  //  Can also be triggered by pressing ctrl + L.
  simulationFolder.add({reload: () => { reload(); }}, 'reload').name('Reload');
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.code === 'KeyL') { reload();  event.preventDefault(); }});
  actionInnerHTML += 'Reload XML<br>';
  keyInnerHTML += 'Ctrl L<br>';

  // Add reset simulation button.
  // Parameters:
  //  Under "Simulation" folder.
  //  Name: "Reset".
  //  When pressed, resets the simulation to the initial state.
  //  Can also be triggered by pressing backspace.
  const resetSimulation = () => {
    parentContext.simulation.resetData();
    parentContext.simulation.forward();
  };
  simulationFolder.add({reset: () => { resetSimulation(); }}, 'reset').name('Reset');
  document.addEventListener('keydown', (event) => {
    if (event.code === 'Backspace') { resetSimulation(); event.preventDefault(); }});
  actionInnerHTML += 'Reset simulation<br>';
  keyInnerHTML += 'Backspace<br>';

  // Add keyframe slider.
  let nkeys = parentContext.model.nkey;
  let keyframeGUI = simulationFolder.add(parentContext.params, "keyframeNumber", 0, nkeys - 1, 1).name('Load Keyframe').listen();
  keyframeGUI.onChange((value) => {
    if (value < parentContext.model.nkey) {
      parentContext.simulation.qpos.set(parentContext.model.key_qpos.slice(
        value * parentContext.model.nq, (value + 1) * parentContext.model.nq)); }});
  parentContext.updateGUICallbacks.push((model, simulation, params) => {
    let nkeys = parentContext.model.nkey;
    console.log("new model loaded. has " + nkeys + " keyframes.");
    if (nkeys > 0) {
      keyframeGUI.max(nkeys - 1);
      keyframeGUI.domElement.style.opacity = 1.0;
    } else {
      // Disable keyframe slider if no keyframes are available.
      keyframeGUI.max(0);
      keyframeGUI.domElement.style.opacity = 0.5;
    }
  });

  // Add sliders for ctrlnoiserate and ctrlnoisestd; min = 0, max = 2, step = 0.01.
  simulationFolder.add(parentContext.params, 'ctrlnoiserate', 0.0, 2.0, 0.01).name('Noise rate' );
  simulationFolder.add(parentContext.params, 'ctrlnoisestd' , 0.0, 2.0, 0.01).name('Noise scale');

  let textDecoder = new TextDecoder("utf-8");
  let nullChar    = textDecoder.decode(new ArrayBuffer(1));

  // Add actuator sliders.
  let actuatorFolder = simulationFolder.addFolder("Actuators");
  const addActuators = (model, simulation, params) => {
    let act_range = model.actuator_ctrlrange;
    let actuatorGUIs = [];
    for (let i = 0; i < model.nu; i++) {
      if (!model.actuator_ctrllimited[i]) { continue; }
      let name = textDecoder.decode(
        parentContext.model.names.subarray(
          parentContext.model.name_actuatoradr[i])).split(nullChar)[0];

      parentContext.params[name] = 0.0;
      let actuatorGUI = actuatorFolder.add(parentContext.params, name, act_range[2 * i], act_range[2 * i + 1], 0.01).name(name).listen();
      actuatorGUIs.push(actuatorGUI);
      actuatorGUI.onChange((value) => {
        simulation.ctrl[i] = value;
      });
    }
    return actuatorGUIs;
  };
  let actuatorGUIs = addActuators(parentContext.model, parentContext.simulation, parentContext.params);
  parentContext.updateGUICallbacks.push((model, simulation, params) => {
    for (let i = 0; i < actuatorGUIs.length; i++) {
      actuatorGUIs[i].destroy();
    }
    actuatorGUIs = addActuators(model, simulation, parentContext.params);
  });
  actuatorFolder.close();

  // Add function that resets the camera to the default position.
  // Can be triggered by pressing ctrl + A.
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.code === 'KeyA') {
      // TODO: Use free camera parameters from MuJoCo
      parentContext.camera.position.set(2.0, 1.7, 1.7);
      parentContext.controls.target.set(0, 0.7, 0);
      parentContext.controls.update(); 
      event.preventDefault();
    }
  });
  actionInnerHTML += 'Reset free camera<br>';
  keyInnerHTML += 'Ctrl A<br>';

  parentContext.gui.open();
}


/** Compiles an MJCF file into a Model, throwing on any compile failure.
 *
 * Detecting failure here is awkward, because none of the obvious signals work:
 *
 *   - load_from_xml does NOT reliably throw. For most *semantic* errors
 *     (wrong size arity, duplicate names, unresolved actuator target) it
 *     returns a Model wrapping a NULL mjModel*.
 *   - model.ptr() is not callable at all — embind never registered mjModel*,
 *     so it raises "Cannot call Model.ptr due to unbound types: P8mjModel_".
 *   - Reading fields off the null model does not trap, it returns garbage
 *     from low memory (nq came back as 1668509029 in testing). So a field
 *     sanity-check would silently accept a broken model.
 *
 * What is reliable is stdout: finish() printf's the error buffer, and it is
 * only called on failure (src/main.template.cc:17-35). Measured over 16 broken
 * models plus the primitives scene and the full ur5e scene (30 geoms, 20
 * meshes, a texture): zero false negatives, zero false positives.
 *
 * Caveat on message *quality*, which is a limitation of the shipped binary:
 * src/CMakeLists.txt links with EXCEPTION_CATCHING_ALLOWED=['load_from_xml'],
 * which strips the catch handler inside mj_loadXML that would normally turn an
 * internal mjXError into readable text. So tinyxml2 parse errors arrive with
 * full detail, while MJCF semantic errors arrive as an empty string or a bare
 * "mjXError". Rebuilding to fix that is blocked: main.genned.cc is generated
 * against an older MuJoCo than include/ (references tex_rgb, nmeshtexvert,
 * nstack, mjtCollision, ...), so the bindings need porting to 3.3.2 first.
 * Until then, callers should pre-validate semantics in JS — see the scene
 * validator on the agent side, which owns the checks MuJoCo cannot explain.
 *
 * If a *valid* model is ever rejected here, the cause is MuJoCo printing a
 * non-fatal warning during compile; the warning text will be in err.message.
 *
 * @param {mujoco} mujoco The mujoco namespace object
 * @param {string} path Absolute path inside the Emscripten FS, e.g. /working/foo/scene.xml
 * @returns {Model}
 */
export function compileModel(mujoco, path) {
  clearMjLog();

  let model = null;
  let thrown = null;
  try {
    model = mujoco.Model.load_from_xml(path);
  } catch (e) {
    thrown = e;
  }
  // Count lines, don't test the text: a failed compile often prints a single
  // EMPTY line (MuJoCo left the error buffer blank — see the caveat above), and
  // that empty line is still the signal. Testing truthiness of the joined text
  // silently accepts every one of those models.
  const lines = drainMjLog();
  const printed = lines.join('\n').trim();

  if (thrown !== null || lines.length > 0) {
    const err = new Error(formatCompileFailure(printed, thrown));
    err.code = 'MJCF_COMPILE_ERROR';
    err.mujocoDiagnostic = printed;          // '' when MuJoCo gave us nothing
    throw err;
  }

  return model;
}

function formatCompileFailure(printed, thrown) {
  if (printed) return printed;

  // Thrown-but-silent: the embind wrapper stringifies mjXError to just its type
  // name, and getExceptionMessage() raises on it, so there is no text to
  // recover. Say so plainly rather than surfacing "mjXError" as if it were a
  // diagnostic — a caller (or a model) trying to act on it needs to know the
  // reason is genuinely unavailable, not just terse.
  const raw = thrown && thrown.message ? thrown.message : String(thrown ?? '');
  const detail = raw && raw !== 'mjXError' ? ` (${raw})` : '';
  return 'MuJoCo rejected this model but did not report a reason' + detail +
    '. This is usually a structural problem: a geom size with the wrong number ' +
    'of values for its type, a duplicate name, a reference to an asset or joint ' +
    'that does not exist, or an element in the wrong place.';
}

/** Reads the names of a model's actuators and joints out of model.names.
 *
 * Same decoding approach as pythonIntegration.js:59-71 — names is one packed
 * buffer of NUL-terminated strings, indexed by the name_*adr tables.
 *
 * @param {Model} model
 * @returns {{ actuatorNames: string[], jointNames: string[] }}
 */
export function readModelNames(model) {
  const decoder = new TextDecoder('utf-8');
  const readAt = (addr) => decoder.decode(model.names.subarray(addr)).split('\0')[0] || '';

  const actuatorNames = [];
  for (let i = 0; i < model.nu; i++) {
    actuatorNames.push(readAt(model.name_actuatoradr[i]) || `actuator_${i}`);
  }
  const jointNames = [];
  for (let i = 0; i < model.njnt; i++) {
    jointNames.push(readAt(model.name_jntadr[i]) || `joint_${i}`);
  }
  return { actuatorNames, jointNames };
}

/** Loads a scene for MuJoCo
 * @param {mujoco} mujoco This is a reference to the mujoco namespace object
 * @param {string} filename This is the name of the .xml file in the /working/ directory of the MuJoCo/Emscripten Virtual File System
 * @param {RoboSpaceDemo} parent The three.js Scene Object to add the MuJoCo model elements to
 */
export async function loadSceneFromURL(mujoco, filename, parent) {
    // Compile FIRST, before destroying anything.
    //
    // This used to free and null model/state/simulation up front and only then
    // compile, which made a compile failure catastrophic in two ways: the caller was
    // left with a null model (and render() dereferenced it, killing the animation
    // loop for the session), and the previously working scene was already gone.
    //
    // Compiling first makes a failed load a true no-op — the old robot keeps
    // rendering and stepping while the caller repairs its XML, which is exactly what
    // the agent's compile-fail-and-repair loop needs. Safe even though the caller
    // may already have rmrf'd the scene directory (sceneWriter.writeGeneratedScene
    // does), because the live model lives in WASM memory, not in MEMFS.
    const newModel = compileModel(mujoco, "/working/"+filename);

    // Past this point the load cannot fail on the model itself, so it is safe to
    // tear down the old one.
    if (parent.simulation != null) {
      parent.simulation.free();
      parent.model      = null;
      parent.state      = null;
      parent.simulation = null;
    }
    // A drag captured against the old model holds a bodyID that means nothing in the
    // new one; left in place it becomes a NaN force applied to whatever body now
    // happens to sit at that index.
    if (parent.dragStateManager && typeof parent.dragStateManager.reset === 'function') {
      parent.dragStateManager.reset();
    }

    const cleanUpRoot = (rootObj) => {
      if (!rootObj) return;
      rootObj.traverse((node) => {
        if (node.isMesh || node.isLine || node.isPoints) {
          if (node.geometry) node.geometry.dispose();
          if (node.material) {
            if (Array.isArray(node.material)) {
              node.material.forEach((m) => m.dispose());
            } else {
              node.material.dispose();
            }
          }
        }
      });
      if (rootObj.parent) {
        rootObj.parent.remove(rootObj);
      }
    };

    // Clean up any existing MuJoCo Root group in the three.js scene.
    const toRemove = [];
    parent.scene.traverse((node) => {
      if (node.name === "MuJoCo Root") {
        toRemove.push(node);
      }
    });
    for (const rootObj of toRemove) {
      cleanUpRoot(rootObj);
    }
    parent.mujocoRoot = null;

    // Load in the state from XML (compiled above, before the teardown).
    parent.model       = newModel;
    parent.state       = new mujoco.State(parent.model);
    parent.simulation  = new mujoco.Simulation(parent.model, parent.state);

    let model = parent.model;
    let state = parent.state;
    let simulation = parent.simulation;

    // Decode the null-terminated string names.
    let textDecoder = new TextDecoder("utf-8");
    let fullString = textDecoder.decode(model.names);
    let names = fullString.split(textDecoder.decode(new ArrayBuffer(1)));

    // Create the root object.
    let mujocoRoot = new THREE.Group();
    mujocoRoot.name = "MuJoCo Root"
    parent.scene.add(mujocoRoot);

    /** @type {Object.<number, THREE.Group>} */
    let bodies = {};
    /** @type {Object.<number, THREE.BufferGeometry>} */
    let meshes = {};
    /** @type {THREE.Light[]} */
    let lights = [];

    // Default material definition.
    let material = new THREE.MeshPhysicalMaterial();
    material.color = new THREE.Color(1, 1, 1);

    // Loop through the MuJoCo geoms and recreate them in three.js.
    for (let g = 0; g < model.ngeom; g++) {
      // Only visualize geom groups up to 2 (same default behavior as simulate).
      if (!(model.geom_group[g] < 3)) { continue; }

      // Get the body ID and type of the geom.
      let b = model.geom_bodyid[g];
      let type = model.geom_type[g];
      let size = [
        model.geom_size[(g*3) + 0],
        model.geom_size[(g*3) + 1],
        model.geom_size[(g*3) + 2]
      ];

      // Create the body if it doesn't exist.
      if (!(b in bodies)) {
        bodies[b] = new THREE.Group();
        bodies[b].name = names[model.name_bodyadr[b]];
        bodies[b].bodyID = b;
        bodies[b].has_custom_mesh = false;
      }

      // Set the default geometry. In MuJoCo, this is a sphere.
      let geometry = new THREE.SphereGeometry(size[0] * 0.5);
      if (type == mujoco.mjtGeom.mjGEOM_PLANE.value) {
        // Special handling for plane later.
      } else if (type == mujoco.mjtGeom.mjGEOM_HFIELD.value) {
        // TODO: Implement this.
      } else if (type == mujoco.mjtGeom.mjGEOM_SPHERE.value) {
        geometry = new THREE.SphereGeometry(size[0]);
      } else if (type == mujoco.mjtGeom.mjGEOM_CAPSULE.value) {
        geometry = new THREE.CapsuleGeometry(size[0], size[1] * 2.0, 20, 20);
      } else if (type == mujoco.mjtGeom.mjGEOM_ELLIPSOID.value) {
        geometry = new THREE.SphereGeometry(1); // Stretch this below
      } else if (type == mujoco.mjtGeom.mjGEOM_CYLINDER.value) {
        geometry = new THREE.CylinderGeometry(size[0], size[0], size[1] * 2.0);
      } else if (type == mujoco.mjtGeom.mjGEOM_BOX.value) {
        geometry = new THREE.BoxGeometry(size[0] * 2.0, size[2] * 2.0, size[1] * 2.0);
      } else if (type == mujoco.mjtGeom.mjGEOM_MESH.value) {
        let meshID = model.geom_dataid[g];

        if (!(meshID in meshes)) {
          geometry = new THREE.BufferGeometry(); // TODO: Populate the Buffer Geometry with Generic Mesh Data

          let vertex_buffer = model.mesh_vert.subarray(
             model.mesh_vertadr[meshID] * 3,
            (model.mesh_vertadr[meshID]  + model.mesh_vertnum[meshID]) * 3);
          for (let v = 0; v < vertex_buffer.length; v+=3){
            //vertex_buffer[v + 0] =  vertex_buffer[v + 0];
            let temp             =  vertex_buffer[v + 1];
            vertex_buffer[v + 1] =  vertex_buffer[v + 2];
            vertex_buffer[v + 2] = -temp;
          }

          let normal_buffer = model.mesh_normal.subarray(
             model.mesh_vertadr[meshID] * 3,
            (model.mesh_vertadr[meshID]  + model.mesh_vertnum[meshID]) * 3);
          for (let v = 0; v < normal_buffer.length; v+=3){
            //normal_buffer[v + 0] =  normal_buffer[v + 0];
            let temp             =  normal_buffer[v + 1];
            normal_buffer[v + 1] =  normal_buffer[v + 2];
            normal_buffer[v + 2] = -temp;
          }

          let uv_buffer = model.mesh_texcoord.subarray(
             model.mesh_texcoordadr[meshID] * 2,
            (model.mesh_texcoordadr[meshID]  + model.mesh_vertnum[meshID]) * 2);
          let triangle_buffer = model.mesh_face.subarray(
             model.mesh_faceadr[meshID] * 3,
            (model.mesh_faceadr[meshID]  + model.mesh_facenum[meshID]) * 3);
          geometry.setAttribute("position", new THREE.BufferAttribute(vertex_buffer, 3));
          geometry.setAttribute("normal"  , new THREE.BufferAttribute(normal_buffer, 3));
          geometry.setAttribute("uv"      , new THREE.BufferAttribute(    uv_buffer, 2));
          geometry.setIndex    (Array.from(triangle_buffer));
          meshes[meshID] = geometry;
        } else {
          geometry = meshes[meshID];
        }

        bodies[b].has_custom_mesh = true;
      }
      // Done with geometry creation.

      // Set the Material Properties of incoming bodies
      let texture = undefined;
      let color = [
        model.geom_rgba[(g * 4) + 0],
        model.geom_rgba[(g * 4) + 1],
        model.geom_rgba[(g * 4) + 2],
        model.geom_rgba[(g * 4) + 3]];
      if (model.geom_matid[g] != -1) {
        let matId = model.geom_matid[g];
        color = [
          model.mat_rgba[(matId * 4) + 0],
          model.mat_rgba[(matId * 4) + 1],
          model.mat_rgba[(matId * 4) + 2],
          model.mat_rgba[(matId * 4) + 3]];

        // Construct Texture from model.tex_rgb
        texture = undefined;
        let texId = model.mat_texid[matId];
        if (texId != -1) {
          let width    = model.tex_width [texId];
          let height   = model.tex_height[texId];
          let offset   = model.tex_adr   [texId];
          let rgbArray = model.tex_rgb   ;
          
          // ADD BOUNDS CHECKING HERE - This is the fix for the error
          if (rgbArray && offset >= 0 && width > 0 && height > 0) {
            let totalPixels = width * height;
            let requiredRGBLength = offset + (totalPixels * 3);
            
            // Check if we have enough data in the RGB array
            if (rgbArray.length >= requiredRGBLength) {
              let rgbaArray = new Uint8Array(width * height * 4);
              for (let p = 0; p < totalPixels; p++){
                let rgbIndex = offset + (p * 3);
                rgbaArray[(p * 4) + 0] = rgbArray[rgbIndex + 0];
                rgbaArray[(p * 4) + 1] = rgbArray[rgbIndex + 1];
                rgbaArray[(p * 4) + 2] = rgbArray[rgbIndex + 2];
                rgbaArray[(p * 4) + 3] = 255; // Full opacity
              }
              texture = new THREE.DataTexture(rgbaArray, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
              if (texId == 2) {
                texture.repeat = new THREE.Vector2(50, 50);
                texture.wrapS = THREE.RepeatWrapping;
                texture.wrapT = THREE.RepeatWrapping;
              } else {
                texture.repeat = new THREE.Vector2(1, 1);
                texture.wrapS = THREE.RepeatWrapping;
                texture.wrapT = THREE.RepeatWrapping;
              }
              texture.needsUpdate = true;
            } else {
              console.warn(`Texture data insufficient. Required: ${requiredRGBLength}, Available: ${rgbArray ? rgbArray.length : 0}`);
              texture = undefined;
            }
          } else {
            console.warn("Texture data not available or invalid parameters:", {
              rgbArrayExists: !!rgbArray,
              rgbArrayLength: rgbArray ? rgbArray.length : 0,
              offset: offset,
              width: width,
              height: height,
              texId: texId
            });
            texture = undefined;
          }
        }
      }

      if (material.color.r != color[0] ||
          material.color.g != color[1] ||
          material.color.b != color[2] ||
          material.opacity != color[3] ||
          material.map     != texture) {
        material = new THREE.MeshPhysicalMaterial({
          color: new THREE.Color(color[0], color[1], color[2]),
          transparent: color[3] < 1.0,
          opacity: color[3],
          specularIntensity: model.geom_matid[g] != -1 ?       model.mat_specular   [model.geom_matid[g]] *0.5 : undefined,
          reflectivity     : model.geom_matid[g] != -1 ?       model.mat_reflectance[model.geom_matid[g]] : undefined,
          roughness        : model.geom_matid[g] != -1 ? 1.0 - model.mat_shininess  [model.geom_matid[g]] : undefined,
          metalness        : model.geom_matid[g] != -1 ? 0.1 : undefined,
          map              : texture
        });
      }

      let mesh = new THREE.Mesh();
      if (type == 0) {
        mesh = new Reflector( new THREE.PlaneGeometry( 100, 100 ), { clipBias: 0.003,texture: texture } );
        mesh.rotateX( - Math.PI / 2 );
      } else {
        mesh = new THREE.Mesh(geometry, material);
      }

      mesh.castShadow = g == 0 ? false : true;
      mesh.receiveShadow = type != 7;
      mesh.bodyID = b;
      bodies[b].add(mesh);
      getPosition  (model.geom_pos, g, mesh.position  );
      if (type != 0) { getQuaternion(model.geom_quat, g, mesh.quaternion); }
      if (type == 4) { mesh.scale.set(size[0], size[2], size[1]) } // Stretch the Ellipsoid
    }

    // Parse tendons.
    let tendonMat = new THREE.MeshPhongMaterial();
    tendonMat.color = new THREE.Color(0.8, 0.3, 0.3);
    mujocoRoot.cylinders = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(1, 1, 1),
        tendonMat, 1023);
    mujocoRoot.cylinders.receiveShadow = true;
    mujocoRoot.cylinders.castShadow    = true;
    mujocoRoot.add(mujocoRoot.cylinders);
    mujocoRoot.spheres = new THREE.InstancedMesh(
        new THREE.SphereGeometry(1, 10, 10),
        tendonMat, 1023);
    mujocoRoot.spheres.receiveShadow = true;
    mujocoRoot.spheres.castShadow    = true;
    mujocoRoot.add(mujocoRoot.spheres);

    // Parse lights.
    for (let l = 0; l < model.nlight; l++) {
      let light = new THREE.SpotLight();
      if (model.light_directional[l]) {
        light = new THREE.DirectionalLight();
      } else {
        light = new THREE.SpotLight();
      }

      // Use the diffuse color specified in the MuJoCo model
      const diffuse = model.light_diffuse.subarray(l * 3, (l + 1) * 3);
      light.color.setRGB(diffuse[0], diffuse[1], diffuse[2]);

      light.decay = model.light_attenuation[l] * 100;
      light.penumbra = 0.5;
      light.castShadow = true; // default false

      light.shadow.mapSize.width = 1024; // default
      light.shadow.mapSize.height = 1024; // default
      light.shadow.camera.near = 1; // default
      light.shadow.camera.far = 10; // default
      //bodies[model.light_bodyid()].add(light);
      if (bodies[0]) {
        bodies[0].add(light);
      } else {
        mujocoRoot.add(light);
      }
      lights.push(light);
    }
    if (model.nlight == 0) {
      let light = new THREE.DirectionalLight();
      mujocoRoot.add(light);
    }

    for (let b = 0; b < model.nbody; b++) {
      //let parent_body = model.body_parentid()[b];
      if (b == 0 || !bodies[0]) {
        mujocoRoot.add(bodies[b]);
      } else if(bodies[b]){
        bodies[0].add(bodies[b]);
      } else {
        console.log("Body without Geometry detected; adding to bodies", b, bodies[b]);
        bodies[b] = new THREE.Group(); bodies[b].name = names[b + 1]; bodies[b].bodyID = b; bodies[b].has_custom_mesh = false;
        bodies[0].add(bodies[b]);
      }
    }
  
    parent.mujocoRoot = mujocoRoot;

    return [model, state, simulation, bodies, lights]
}

/** Downloads the scenes/examples folder to MuJoCo's virtual filesystem
 * @param {mujoco} mujoco */
export async function downloadExampleScenesFolder(mujoco) {
  let allFiles = [
    "universal_robots_ur5e/assets/base_0.obj",
    "universal_robots_ur5e/assets/base_1.obj",
    "universal_robots_ur5e/assets/forearm_0.obj",
    "universal_robots_ur5e/assets/forearm_1.obj",
    "universal_robots_ur5e/assets/forearm_2.obj",
    "universal_robots_ur5e/assets/forearm_3.obj",
    "universal_robots_ur5e/assets/shoulder_0.obj",
    "universal_robots_ur5e/assets/shoulder_1.obj",
    "universal_robots_ur5e/assets/shoulder_2.obj",
    "universal_robots_ur5e/assets/upperarm_0.obj",
    "universal_robots_ur5e/assets/upperarm_1.obj",
    "universal_robots_ur5e/assets/upperarm_2.obj",
    "universal_robots_ur5e/assets/upperarm_3.obj",
    "universal_robots_ur5e/assets/wrist1_0.obj",
    "universal_robots_ur5e/assets/wrist1_1.obj",
    "universal_robots_ur5e/assets/wrist1_2.obj",
    "universal_robots_ur5e/assets/wrist2_0.obj",
    "universal_robots_ur5e/assets/wrist2_1.obj",
    "universal_robots_ur5e/assets/wrist2_2.obj",
    "universal_robots_ur5e/assets/wrist3.obj",
    "universal_robots_ur5e/scene.xml",
    "universal_robots_ur5e/ur5e.png",
    "universal_robots_ur5e/ur5e.xml"
  ];

  let requests = allFiles.map((url) => fetch("./examples/scenes/" + url));
  let responses = await Promise.all(requests);
  const failed = [];
  for (let i = 0; i < responses.length; i++) {
      // Check the status. Without this, a 404 or 500 writes the server's error page
      // *body* into scene.xml or a .obj, and the failure resurfaces much later as an
      // inexplicable MJCF_COMPILE_ERROR pointing at the wrong thing entirely. Skip
      // the file instead: a missing asset produces a compile error that names it.
      if (!responses[i].ok) {
          failed.push(`${allFiles[i]} (HTTP ${responses[i].status})`);
          continue;
      }
      let split = allFiles[i].split("/");
      let working = '/working/';
      for (let f = 0; f < split.length - 1; f++) {
          working += split[f];
          if (!mujoco.FS.analyzePath(working).exists) { mujoco.FS.mkdir(working); }
          working += "/";
      }

      if (allFiles[i].endsWith(".png") || allFiles[i].endsWith(".stl") || allFiles[i].endsWith(".skn")) {
          mujoco.FS.writeFile("/working/" + allFiles[i], new Uint8Array(await responses[i].arrayBuffer()));
      } else {
          mujoco.FS.writeFile("/working/" + allFiles[i], await responses[i].text());
      }
  }
  if (failed.length) {
      console.error(`[robospace] ${failed.length} bundled scene file(s) failed to download:\n  `
        + failed.join('\n  '));
  }
}

/** Access the vector at index, swizzle for three.js, and apply to the target THREE.Vector3
 * @param {Float32Array|Float64Array} buffer
 * @param {number} index
 * @param {THREE.Vector3} target */
export function getPosition(buffer, index, target, swizzle = true) {
  if (swizzle) {
    return target.set(
       buffer[(index * 3) + 0],
       buffer[(index * 3) + 2],
      -buffer[(index * 3) + 1]);
  } else {
    return target.set(
       buffer[(index * 3) + 0],
       buffer[(index * 3) + 1],
       buffer[(index * 3) + 2]);
  }
}

/** Access the quaternion at index, swizzle for three.js, and apply to the target THREE.Quaternion
 * @param {Float32Array|Float64Array} buffer
 * @param {number} index
 * @param {THREE.Quaternion} target */
export function getQuaternion(buffer, index, target, swizzle = true) {
  if (swizzle) {
    return target.set(
      -buffer[(index * 4) + 1],
      -buffer[(index * 4) + 3],
       buffer[(index * 4) + 2],
      -buffer[(index * 4) + 0]);
  } else {
    return target.set(
       buffer[(index * 4) + 0],
       buffer[(index * 4) + 1],
       buffer[(index * 4) + 2],
       buffer[(index * 4) + 3]);
  }
}

/** Converts this Vector3's Handedness to MuJoCo's Coordinate Handedness
 * @param {THREE.Vector3} target */
export function toMujocoPos(target) { return target.set(target.x, -target.z, target.y); }

/** Standard normal random number generator using Box-Muller transform */
export function standardNormal() {
  return Math.sqrt(-2.0 * Math.log( Math.random())) *
         Math.cos ( 2.0 * Math.PI * Math.random()); }

