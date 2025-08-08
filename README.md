<p align="center">
  <a href="https://zalo.github.io/mujoco_wasm/"><img src="./examples/MuJoCoWasmLogo.png" href></a>
</p>
<p align="left">
  <a href="https://github.com/zalo/mujoco_wasm/deployments/activity_log?environment=github-pages">
      <img src="https://img.shields.io/github/deployments/zalo/mujoco_wasm/github-pages?label=Github%20Pages%20Deployment" title="Github Pages Deployment"></a>
  <a href="https://github.com/zalo/mujoco_wasm/commits/main">
      <img src="https://img.shields.io/github/last-commit/zalo/mujoco_wasm" title="Last Commit Date"></a>
  <a href="https://github.com/zalo/mujoco_wasm/blob/main/LICENSE">
      <img src="https://img.shields.io/badge/license-MIT-brightgreen" title="License: MIT"></a>
</p>

## The Power of MuJoCo in your Browser.

This project allows you to load and run MuJoCo 3.3.2 models using JavaScript and WebAssembly, with a new and improved user interface. It features a static toolbar for all major controls and an integrated Python IDE to program the robot model's actuation directly in the browser.

### [See the Live Demo Here](https://zalo.github.io/mujoco_wasm/)

## Features

*   **Static Toolbar**: A user-friendly toolbar at the top of the page provides easy access to all functionalities, including scene selection, simulation controls (pause, reload, reset), and noise controls.
*   **Integrated Python IDE**: A Python IDE on the right side of the screen allows you to program the robot model's actuation in real-time. Simply write your Python code and click "Run" to see it in action.
*   **Real-time Physics Simulation**: Powered by MuJoCo and WebAssembly, the simulation runs smoothly and efficiently in your browser.
*   **Interactive 3D View**: The 3D view is rendered using `three.js`, allowing you to interact with the simulation by panning, zooming, and rotating the camera.

## How to Use

### Toolbar

The toolbar at the top of the page provides the following controls:

*   **Example Scene**: A dropdown menu to select and load different MuJoCo scenes.
*   **Pause/Play**: Toggles the simulation between paused and running states.
*   **Reload**: Reloads the current scene.
*   **Reset**: Resets the simulation to its initial state.
*   **Noise Rate/Scale**: Sliders to control the amount of noise applied to the simulation.

### Python IDE

The Python IDE on the right side of the screen allows you to control the robot model's actuators using Python code. The IDE is powered by Pyodide, which runs Python directly in the browser.

To control the robot, you need to define a `controller` function in the Python IDE. This function will be called at each step of the simulation.

**Example: Actuating Joints**

Here is an example of a `controller` function that applies a sinusoidal control to the first actuator:

```python
import js

def controller(model, data):
    # model: the MuJoCo model object
    # data: the MuJoCo simulation data object
    
    # Apply a sinusoidal control to the first actuator
    data.ctrl[0] = 0.5 * js.Math.sin(data.time * 10)
```

Click the "Run" button to define or update the controller. The simulation will then use your Python code to control the robot.

## Building

**1. Install emscripten**

**2. Build the mujoco_wasm Binary**

On Linux, use:
```bash
mkdir build
cd build
emcmake cmake ..
make
```

On Windows, run `build_windows.bat`.

*3. (Optional) Update MuJoCo libs*

Build MuJoCo libs with wasm target and place to lib. Currently v3.3.2 included.

## JavaScript API

```javascript
import load_mujoco from "./mujoco_wasm.js";

// Load the MuJoCo Module
const mujoco = await load_mujoco();

// Set up Emscripten's Virtual File System
mujoco.FS.mkdir('/working');
mujoco.FS.mount(mujoco.MEMFS, { root: '.' }, '/working');
mujoco.FS.writeFile("/working/humanoid.xml", await (await fetch("./examples/scenes/humanoid.xml")).text());

// Load in the state from XML
let model       = new mujoco.Model("/working/humanoid.xml");
let state       = new mujoco.State(model);
let simulation  = new mujoco.Simulation(model, state);
```

Typescript definitions are available.
