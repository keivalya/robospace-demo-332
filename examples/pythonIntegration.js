// File: examples/pythonIntegration.js
export class PythonIntegration {
    constructor(demo, pyodide) {
        this.demo = demo;
        this.pyodide = pyodide;
        this.isRunning = false;
        this.animationFrameId = null;
        this.outputElement = document.getElementById('python-output');
        this.codeElement = document.getElementById('python-code');
        
        this.setupEventListeners();
        this.initializePythonEnvironment();
    }
    
    setupEventListeners() {
        document.getElementById('run-python').addEventListener('click', () => this.runPython());
        document.getElementById('stop-python').addEventListener('click', () => this.stopPython());
        
        // Add keyboard shortcut for running code
        this.codeElement.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                this.runPython();
            }
        });
    }
    
    async initializePythonEnvironment() {
        try {
            // Setup Python environment with MuJoCo bindings
            await this.pyodide.runPythonAsync(`
                import sys
                import numpy as np
                import time
                import json
                from js import window, document
                
                # Create a custom output handler
                class JSOutput:
                    def __init__(self):
                        self.buffer = []
                    
                    def write(self, text):
                        if text:
                            window.pythonOutput(text)
                    
                    def flush(self):
                        pass
                
                sys.stdout = JSOutput()
                sys.stderr = JSOutput()
                
                # Create MuJoCo wrapper class
                class MuJoCoSimulation:
                    def __init__(self):
                        self.model = None
                        self.sim = None
                        self.data = None
                        
                    def _update(self):
                        """Update from JavaScript context"""
                        pass
                    
                    def get_joint_names(self):
                        """Get list of joint names"""
                        return window.getMuJoCoJointNames()
                    
                    def get_body_names(self):
                        """Get list of body names"""
                        return window.getMuJoCoBodyNames()
                    
                    def get_state(self):
                        """Get current state (positions and velocities)"""
                        state = window.getMuJoCoState()
                        return json.loads(state)
                    
                    def set_control(self, ctrl):
                        """Set control values"""
                        if isinstance(ctrl, np.ndarray):
                            ctrl = ctrl.tolist()
                        window.setMuJoCoControl(json.dumps(ctrl))
                    
                    def get_sensor_data(self):
                        """Get sensor data"""
                        data = window.getMuJoCoSensorData()
                        return json.loads(data)
                    
                    def step(self):
                        """Step simulation"""
                        window.stepMuJoCoSimulation()
                    
                    def reset(self):
                        """Reset simulation"""
                        window.resetMuJoCoSimulation()
                    
                    def apply_force(self, body_id, force, torque=None):
                        """Apply force to a body"""
                        if torque is None:
                            torque = [0, 0, 0]
                        window.applyMuJoCoForce(body_id, json.dumps(force), json.dumps(torque))
                
                # Create global simulation object
                sim = MuJoCoSimulation()
                
                # Helper functions
                def get_time():
                    """Get simulation time"""
                    return window.getMuJoCoTime()
                
                def set_camera(position, target):
                    """Set camera position and target"""
                    window.setCamera(json.dumps(position), json.dumps(target))
                
                print("Python environment initialized")
                print("Available objects: sim, np, time")
                print("Use sim.set_control([...]) to control actuators")
            `);
            
            // Setup JavaScript-Python bridge functions
            window.pythonOutput = (text) => {
                this.appendOutput(text);
            };
            
            window.getMuJoCoJointNames = () => {
                if (!this.demo.model) return [];
                // Return joint names from model
                return [];  // Implement based on model structure
            };
            
            window.getMuJoCoBodyNames = () => {
                if (!this.demo.bodies) return [];
                return this.demo.bodies.map(b => b.name);
            };
            
            window.getMuJoCoState = () => {
                if (!this.demo.simulation) return "{}";
                
                const state = {
                    qpos: Array.from(this.demo.simulation.qpos),
                    qvel: Array.from(this.demo.simulation.qvel),
                    time: this.demo.simulation.time
                };
                return JSON.stringify(state);
            };
            
            window.setMuJoCoControl = (ctrlJson) => {
                if (!this.demo.simulation) return;
                
                const ctrl = JSON.parse(ctrlJson);
                const nu = this.demo.model.nu;  // Number of actuators
                
                for (let i = 0; i < Math.min(ctrl.length, nu); i++) {
                    this.demo.simulation.ctrl[i] = ctrl[i];
                }
            };
            
            window.getMuJoCoSensorData = () => {
                if (!this.demo.simulation) return "{}";
                
                const sensorData = {
                    data: Array.from(this.demo.simulation.sensordata || [])
                };
                return JSON.stringify(sensorData);
            };
            
            window.stepMuJoCoSimulation = () => {
                if (!this.demo.simulation) return;
                this.demo.simulation.step();
            };
            
            window.resetMuJoCoSimulation = () => {
                if (!this.demo.simulation) return;
                this.demo.simulation.resetData();
                this.demo.simulation.forward();
            };
            
            window.applyMuJoCoForce = (bodyId, forceJson, torqueJson) => {
                if (!this.demo.simulation) return;
                
                const force = JSON.parse(forceJson);
                const torque = JSON.parse(torqueJson);
                
                // Apply force at body center of mass
                this.demo.simulation.applyForce(
                    force[0], force[1], force[2],
                    torque[0], torque[1], torque[2],
                    0, 0, 0,  // Apply at COM
                    bodyId
                );
            };
            
            window.getMuJoCoTime = () => {
                if (!this.demo.simulation) return 0;
                return this.demo.simulation.time;
            };
            
            window.setCamera = (posJson, targetJson) => {
                const pos = JSON.parse(posJson);
                const target = JSON.parse(targetJson);
                
                this.demo.camera.position.set(pos[0], pos[1], pos[2]);
                this.demo.controls.target.set(target[0], target[1], target[2]);
                this.demo.controls.update();
            };
            
        } catch (error) {
            console.error('Error initializing Python environment:', error);
            this.appendOutput(`Error: ${error.message}`, true);
        }
    }
    
    async runPython() {
        if (this.isRunning) {
            this.appendOutput("Script already running. Stop it first.", true);
            return;
        }
        
        const code = this.codeElement.value;
        if (!code.trim()) {
            this.appendOutput("No code to run.", true);
            return;
        }
        
        this.isRunning = true;
        this.clearOutput();
        this.appendOutput("Running Python script...\n");
        
        // Change button states
        document.getElementById('run-python').disabled = true;
        document.getElementById('stop-python').disabled = false;
        
        try {
            // Load required packages
            await this.pyodide.loadPackagesFromImports(code);
            
            // Create a control loop if the code needs continuous execution
            const wrappedCode = `
async def main():
    ${code.split('\n').map(line => '    ' + line).join('\n')}

# Run the main function
import asyncio
asyncio.ensure_future(main())
            `;
            
            // Execute the Python code
            await this.pyodide.runPythonAsync(wrappedCode);
            
            this.appendOutput("\nScript completed successfully.");
            
        } catch (error) {
            console.error('Python execution error:', error);
            this.appendOutput(`\nError: ${error.message}`, true);
        } finally {
            this.isRunning = false;
            document.getElementById('run-python').disabled = false;
            document.getElementById('stop-python').disabled = true;
        }
    }
    
    stopPython() {
        if (!this.isRunning) return;
        
        this.isRunning = false;
        
        // Interrupt Python execution
        this.pyodide.runPython(`
            import sys
            sys.exit("Script stopped by user")
        `);
        
        this.appendOutput("\nScript stopped.", true);
        
        // Reset button states
        document.getElementById('run-python').disabled = false;
        document.getElementById('stop-python').disabled = true;
    }
    
    clearOutput() {
        this.outputElement.innerHTML = '<div class="output-label">OUTPUT</div>';
    }
    
    appendOutput(text, isError = false) {
        const outputDiv = document.createElement('div');
        outputDiv.style.color = isError ? '#ff6666' : '#0f0';
        outputDiv.style.whiteSpace = 'pre-wrap';
        outputDiv.textContent = text;
        this.outputElement.appendChild(outputDiv);
        
        // Auto-scroll to bottom
        this.outputElement.scrollTop = this.outputElement.scrollHeight;
    }
}

// Example Python scripts that users can use
export const PYTHON_EXAMPLES = {
    sine_wave_control: `
# Sine wave control example
import numpy as np
import time

# Get simulation time
t = get_time()

# Number of actuators (adjust based on your model)
num_actuators = 6

# Generate sine wave control signals
frequency = 0.5  # Hz
amplitude = 0.5
phase_shift = np.linspace(0, 2 * np.pi, num_actuators)

control = amplitude * np.sin(2 * np.pi * frequency * t + phase_shift)

# Apply control
sim.set_control(control)

print(f"Time: {t:.2f}s")
print(f"Control: {control}")
`,
    
    position_control: `
# Position control example
import numpy as np

# Get current state
state = sim.get_state()
qpos = np.array(state['qpos'])
qvel = np.array(state['qvel'])

# Target positions (adjust based on your model)
target_pos = np.array([0, 0.5, -0.5, 0.5, -0.5, 0])

# PD controller gains
kp = 10.0  # Proportional gain
kd = 1.0   # Derivative gain

# Calculate control
error = target_pos[:len(qpos)] - qpos
control = kp * error - kd * qvel[:len(error)]

# Apply control
sim.set_control(control)

print(f"Position error: {np.linalg.norm(error):.3f}")
print(f"Control effort: {np.linalg.norm(control):.3f}")
`,
    
    force_application: `
# Apply external forces example
import numpy as np

# Apply upward force to body 1
body_id = 1
force = [0, 0, 10]  # Force in world coordinates (N)
torque = [0, 0, 0]  # Torque in world coordinates (Nm)

sim.apply_force(body_id, force, torque)

# Step simulation
sim.step()

print(f"Applied force {force} to body {body_id}")
`
};