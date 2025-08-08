// File: examples/pythonIntegration.js

export async function initializePythonEnvironment(demo) {
    if (!window.pyodide) return;
    
    try {
        // Load required packages first
        await window.pyodide.loadPackage(["numpy"]);
        console.log("NumPy loaded successfully");
        
        // Setup JavaScript bridge functions
        window.getMujocoModel = () => demo.model;
        window.getMujocoSimulation = () => demo.simulation;
        window.getMujocoState = () => demo.state;
        
        window.setControl = (ctrlArray) => {
            if (!demo.simulation) return;
            const ctrl = Array.isArray(ctrlArray) ? ctrlArray : JSON.parse(ctrlArray);
            for (let i = 0; i < Math.min(ctrl.length, demo.model.nu); i++) {
                demo.simulation.ctrl[i] = ctrl[i];
            }
        };
        
        window.getControl = () => {
            if (!demo.simulation) return [];
            return Array.from(demo.simulation.ctrl);
        };
        
        window.resetSimulation = () => {
            if (!demo.simulation) return;
            demo.simulation.resetData();
            demo.simulation.forward();
        };
        
        window.stepSimulation = () => {
            if (!demo.simulation) return;
            demo.simulation.step();
        };
        
        window.getNumActuators = () => {
            if (!demo.model) return 0;
            return demo.model.nu;
        };
        
        window.getActuatorRanges = () => {
            if (!demo.model) return [];
            const ranges = [];
            for (let i = 0; i < demo.model.nu; i++) {
                if (demo.model.actuator_ctrllimited[i]) {
                    const rangeStart = i * 2;
                    ranges.push([
                        demo.model.actuator_ctrlrange[rangeStart],
                        demo.model.actuator_ctrlrange[rangeStart + 1]
                    ]);
                } else {
                    ranges.push([-1, 1]);
                }
            }
            return ranges;
        };
        
        window.getActuatorNames = () => {
            if (!demo.model) return [];
            const names = [];
            const textDecoder = new TextDecoder("utf-8");
            const nameStr = textDecoder.decode(demo.model.names).split('\0');
            
            for (let i = 0; i < demo.model.nu; i++) {
                const nameIndex = demo.model.name_actuatoradr[i];
                names.push(nameStr[nameIndex] || `actuator_${i}`);
            }
            return names;
        };
        
        window.getSimTime = () => {
            return demo.mujoco_time / 1000.0;
        };
        
        window.getQpos = () => {
            if (!demo.simulation) return [];
            return Array.from(demo.simulation.qpos);
        };
        
        window.getQvel = () => {
            if (!demo.simulation) return [];
            return Array.from(demo.simulation.qvel);
        };
        
        // Setup Python output to go to the OUTPUT panel
        window.pythonOutput = (text) => {
            const outputArea = document.getElementById('python-output');
            if (outputArea) {
                const line = document.createElement('div');
                line.style.color = '#0f0';
                line.style.fontFamily = 'monospace';
                line.style.fontSize = '12px';
                line.style.whiteSpace = 'pre-wrap';
                line.textContent = text;
                outputArea.appendChild(line);
                outputArea.scrollTop = outputArea.scrollHeight;
            }
        };
        
        // Initialize Python environment with helper functions
        await window.pyodide.runPythonAsync(`
import numpy as np
from js import window
import json
import math
import sys
import io

# Redirect stdout and stderr to the OUTPUT panel
class OutputRedirector:
    def write(self, text):
        if text and text != '\\n':
            window.pythonOutput(text)
    
    def flush(self):
        pass

sys.stdout = OutputRedirector()
sys.stderr = OutputRedirector()

# Helper functions to interact with MuJoCo
def get_num_actuators():
    """Get number of actuators"""
    return window.getNumActuators()

def get_actuator_names():
    """Get list of actuator names"""
    return window.getActuatorNames().to_py()

def get_actuator_ranges():
    """Get actuator control ranges"""
    ranges = window.getActuatorRanges().to_py()
    return [(r[0], r[1]) for r in ranges]

def set_control(ctrl):
    """Set control values for all actuators"""
    if isinstance(ctrl, np.ndarray):
        ctrl = ctrl.tolist()
    window.setControl(ctrl)

def get_control():
    """Get current control values"""
    return window.getControl().to_py()

def reset():
    """Reset simulation to initial state"""
    window.resetSimulation()

def step():
    """Step simulation forward"""
    window.stepSimulation()

def get_time():
    """Get simulation time"""
    return window.getSimTime()

def get_qpos():
    """Get joint positions"""
    return np.array(window.getQpos().to_py())

def get_qvel():
    """Get joint velocities"""
    return np.array(window.getQvel().to_py())

def print_info():
    """Print system information"""
    n = get_num_actuators()
    names = get_actuator_names()
    ranges = get_actuator_ranges()
    
    print(f"\\nSystem Information:")
    print(f"  Number of actuators: {n}")
    print(f"  Simulation time: {get_time():.3f}s")
    print(f"\\nActuators:")
    for i in range(n):
        name = names[i] if i < len(names) else f"actuator_{i}"
        r = ranges[i] if i < len(ranges) else (-1, 1)
        print(f"  [{i:2d}] {name:20s} | Range: [{r[0]:6.2f}, {r[1]:6.2f}]")

print("=" * 50)
print("MuJoCo Python Control Interface")
print("=" * 50)
print("Available functions:")
print("  get_num_actuators()  - Get number of actuators")
print("  get_actuator_names() - Get actuator names")
print("  get_actuator_ranges()- Get control ranges")
print("  set_control(ctrl)    - Set control values")
print("  get_control()        - Get current control")
print("  get_qpos()           - Get positions")
print("  get_qvel()           - Get velocities")
print("  get_time()           - Get simulation time")
print("  reset()              - Reset simulation")
print("  step()               - Step simulation")
print("  print_info()         - Print system info")
print("")
print("⚠️  Make sure simulation is NOT PAUSED to see movement!")
print("=" * 50)
        `);
        
        console.log("Python environment initialized");
        
    } catch (error) {
        console.error('Error initializing Python environment:', error);
    }
}

export async function updatePythonEnvironment(demo) {
    if (!window.pyodide) return;
    
    try {
        await window.pyodide.runPythonAsync(`
# Update with new model
print(f"\\nModel updated!")
print_info()
        `);
    } catch (error) {
        console.error('Error updating Python environment:', error);
    }
}

export function setupPythonIDE(demo) {
    const runButton = document.getElementById('run-python');
    const stopButton = document.getElementById('stop-python');
    const clearButton = document.getElementById('clear-python');
    const toggleButton = document.getElementById('toggle-ide');
    const codeArea = document.getElementById('python-code');
    const outputArea = document.getElementById('python-output');
    const ideContainer = document.getElementById('python-ide');
    const editorContainer = document.getElementById('python-editor-container');
    
    // Set initial example code
    codeArea.value = `import numpy as np
import math

# Get system information
n_actuators = get_num_actuators()
print(f"Number of actuators: {n_actuators}")

# Print actuator details
names = get_actuator_names()
ranges = get_actuator_ranges()
for i in range(min(5, n_actuators)):  # Show first 5
    print(f"  {i}: {names[i]:15s} [{ranges[i][0]:.2f}, {ranges[i][1]:.2f}]")

# Create sine wave control
t = get_time()
control = []
for i in range(n_actuators):
    # Sine wave with different phase for each joint
    value = 0.3 * math.sin(2 * math.pi * 0.5 * t + i * 0.5)
    # Clamp to range
    if i < len(ranges):
        min_val, max_val = ranges[i]
        value = max(min_val, min(max_val, value))
    control.append(value)

# Apply control
set_control(control)
print(f"\\nApplied control at t={t:.2f}s")
print(f"First 3 values: {control[:3]}")`;
    
    // Toggle IDE
    toggleButton.addEventListener('click', () => {
        ideContainer.classList.toggle('collapsed');
        const isCollapsed = ideContainer.classList.contains('collapsed');
        toggleButton.textContent = isCollapsed ? '⌃' : '⌄';
        editorContainer.classList.toggle('hidden', isCollapsed);
        
        // Adjust appbody height
        const appbody = document.getElementById('appbody');
        appbody.style.bottom = isCollapsed ? '40px' : '250px';
        
        // Properly resize the renderer
        setTimeout(() => demo.onWindowResize(), 10); // Small delay for CSS transition
    });
    
    // Clear output
    clearButton.addEventListener('click', () => {
        outputArea.innerHTML = '<div class="output-label">OUTPUT</div>';
    });
    
    // Add example selector handler
    const exampleSelector = document.getElementById('example-selector');
    if (exampleSelector) {
        exampleSelector.addEventListener('change', (e) => {
            if (e.target.value && PYTHON_EXAMPLES[e.target.value]) {
                codeArea.value = PYTHON_EXAMPLES[e.target.value];
                e.target.value = ''; // Reset selector
            }
        });
    }
    
    // Run Python code
    runButton.addEventListener('click', async () => {
        if (!window.pyodide) {
            window.pythonOutput("Pyodide not loaded yet. Please wait...");
            return;
        }
        
        const code = codeArea.value;
        if (!code.trim()) return;
        
        outputArea.innerHTML = '<div class="output-label">OUTPUT</div>';
        window.pythonOutput("Running...\n");
        
        try {
            // Load packages that might be imported in the code
            await window.pyodide.loadPackagesFromImports(code);
            
            // Run the code
            await window.pyodide.runPythonAsync(code);
            window.pythonOutput("\n✓ Execution completed");
        } catch (error) {
            // Extract just the error message, not the full traceback
            const errorMsg = error.message.split('\n').slice(-1)[0] || error.message;
            window.pythonOutput(`\n✗ Error: ${errorMsg}`);
        }
    });
    
    // Stop button (placeholder for now)
    stopButton.addEventListener('click', () => {
        window.pythonOutput("\n■ Stopped");
    });
    
    // Keyboard shortcut
    codeArea.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            runButton.click();
        }
    });
}

// Example code snippets for different scenarios
export const PYTHON_EXAMPLES = {
    basic_control: `import numpy as np

# Get system info
n = get_num_actuators()
print(f"Actuators: {n}")

# Set all to neutral
control = [0.0] * n
set_control(control)
print("Reset to neutral position")

# Move first actuator
if n > 0:
    control[0] = 0.5
    set_control(control)
    print("Moved first actuator to 0.5")`,

    sine_wave: `import math
import numpy as np

# Sine wave for all actuators
t = get_time()
n = get_num_actuators()
ranges = get_actuator_ranges()

control = []
for i in range(n):
    # Different frequency and phase for each
    freq = 0.5  # Hz
    phase = i * (math.pi / 4)
    amplitude = 0.3
    
    value = amplitude * math.sin(2 * math.pi * freq * t + phase)
    
    # Clamp to range
    if i < len(ranges):
        min_val, max_val = ranges[i]
        value = max(min_val, min(max_val, value))
    
    control.append(value)

set_control(control)
print(f"Time: {t:.2f}s")
print(f"Applied sine wave control")`,

    walking_pattern: `import math
import numpy as np

# Walking pattern
t = get_time()
n = get_num_actuators()

control = []
for i in range(n):
    if i % 2 == 0:  # Even actuators
        pos = 0.3 * math.sin(2 * t)
    else:  # Odd actuators
        pos = 0.3 * math.cos(2 * t)
    control.append(pos)

set_control(control)
print(f"Walking pattern at t={t:.2f}s")`,

    pd_control: `import numpy as np

# PD controller
n = get_num_actuators()
ranges = get_actuator_ranges()

# Target positions (middle of range)
target = []
for i in range(n):
    if i < len(ranges):
        min_val, max_val = ranges[i]
        target.append((min_val + max_val) / 2 * 0.5)
    else:
        target.append(0)

# Get current state
qpos = get_qpos()
qvel = get_qvel()

# PD gains
kp = 5.0
kd = 0.5

# Calculate control
control = []
for i in range(min(n, len(qpos), len(target))):
    error = target[i] - qpos[i]
    control_val = kp * error - kd * qvel[i]
    
    # Clamp to range
    if i < len(ranges):
        min_val, max_val = ranges[i]
        control_val = max(min_val, min(max_val, control_val))
    
    control.append(control_val)

# Fill remaining with zeros
while len(control) < n:
    control.append(0)

set_control(control)
print(f"PD control applied")
print(f"Error norm: {np.linalg.norm(np.array(target[:len(qpos)]) - qpos[:len(target)]):.3f}")`,

    oscillation: `import math
import numpy as np

# Multi-frequency oscillation
t = get_time()
n = get_num_actuators()
ranges = get_actuator_ranges()

control = []
for i in range(n):
    # Different patterns for different groups
    if i < n // 3:
        # Slow sine
        value = 0.4 * math.sin(t)
    elif i < 2 * n // 3:
        # Fast sine
        value = 0.3 * math.sin(3 * t + math.pi/4)
    else:
        # Cosine
        value = 0.2 * math.cos(2 * t)
    
    # Clamp to range
    if i < len(ranges):
        min_val, max_val = ranges[i]
        value = max(min_val, min(max_val, value))
    
    control.append(value)

set_control(control)
print(f"Multi-frequency pattern at t={t:.2f}s")
print(f"Sample values: {[f'{c:.2f}' for c in control[:3]]}...")`,

    info: `# Print detailed system information
print_info()

# Get current state
print(f"\\nCurrent State:")
print(f"  Time: {get_time():.3f}s")
print(f"  Control: {get_control()[:3]}...")
print(f"  Position shape: {get_qpos().shape}")
print(f"  Velocity shape: {get_qvel().shape}")`,
};