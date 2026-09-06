// BlockEditor.js — Dual-Mode Blockly Visual Editor for RoboSpace (Phase 3)
// Defines custom blocks for robot control, converts blocks to Python targeting the high-level Robot API.

export class BlockEditor {
    constructor(containerEl, onPythonGenerated) {
        this.containerEl = containerEl;
        this.onPythonGenerated = onPythonGenerated;
        this.workspace = null;
        this.enabled = false;

        if (typeof Blockly === 'undefined') {
            console.warn('Blockly is not loaded on this page.');
            return;
        }

        this.initCustomBlocks();
        this.initWorkspace();
    }

    initCustomBlocks() {
        if (!window.Blockly) return;

        // Custom blocks JSON definitions
        const blockDefs = [
            {
                "type": "robospace_arm_move",
                "message0": "arm move_to X: %1 Y: %2 Z: %3",
                "args0": [
                    { "type": "field_number", "name": "X", "value": 0.4, "precision": 0.01 },
                    { "type": "field_number", "name": "Y", "value": 0.0, "precision": 0.01 },
                    { "type": "field_number", "name": "Z", "value": 0.25, "precision": 0.01 }
                ],
                "previousStatement": null,
                "nextStatement": null,
                "colour": 210,
                "tooltip": "Move the robot end-effector to Cartesian target (x, y, z) in meters."
            },
            {
                "type": "robospace_arm_home",
                "message0": "arm move home",
                "previousStatement": null,
                "nextStatement": null,
                "colour": 210,
                "tooltip": "Return the arm to its default home joint position."
            },
            {
                "type": "robospace_gripper_open",
                "message0": "gripper open",
                "previousStatement": null,
                "nextStatement": null,
                "colour": 160,
                "tooltip": "Open the robot gripper."
            },
            {
                "type": "robospace_gripper_close",
                "message0": "gripper close",
                "previousStatement": null,
                "nextStatement": null,
                "colour": 160,
                "tooltip": "Close the robot gripper."
            },
            {
                "type": "robospace_gripper_set",
                "message0": "gripper set position %1 m",
                "args0": [
                    { "type": "field_number", "name": "POS", "value": 0.04, "min": 0, "max": 0.2, "precision": 0.001 }
                ],
                "previousStatement": null,
                "nextStatement": null,
                "colour": 160,
                "tooltip": "Set gripper opening width in meters."
            },
            {
                "type": "robospace_base_drive",
                "message0": "drive base vx: %1 m/s  wz: %2 rad/s  duration: %3 s",
                "args0": [
                    { "type": "field_number", "name": "VX", "value": 0.5, "precision": 0.1 },
                    { "type": "field_number", "name": "WZ", "value": 0.0, "precision": 0.1 },
                    { "type": "field_number", "name": "DURATION", "value": 1.0, "precision": 0.1 }
                ],
                "previousStatement": null,
                "nextStatement": null,
                "colour": 30,
                "tooltip": "Drive mobile base with linear velocity vx and angular velocity wz for a duration."
            },
            {
                "type": "robospace_base_stop",
                "message0": "drive base stop",
                "previousStatement": null,
                "nextStatement": null,
                "colour": 30,
                "tooltip": "Immediately stop mobile base movement."
            },
            {
                "type": "robospace_joint_set",
                "message0": "set joint %1 angle %2 deg",
                "args0": [
                    { "type": "field_input", "name": "JOINT", "text": "elbow" },
                    { "type": "field_number", "name": "ANGLE", "value": 45, "precision": 1 }
                ],
                "previousStatement": null,
                "nextStatement": null,
                "colour": 280,
                "tooltip": "Set a specific joint to target angle in degrees."
            },
            {
                "type": "robospace_get_selected_body_pos",
                "message0": "selected 3D body position",
                "output": "Array",
                "colour": 45,
                "tooltip": "Get array [x, y, z] position of the currently selected 3D object on stage."
            },
            {
                "type": "robospace_sleep",
                "message0": "wait %1 seconds",
                "args0": [
                    { "type": "field_number", "name": "SECONDS", "value": 1.0, "min": 0, "precision": 0.1 }
                ],
                "previousStatement": null,
                "nextStatement": null,
                "colour": 120,
                "tooltip": "Pause execution for specified duration in seconds."
            },
            {
                "type": "robospace_print",
                "message0": "print %1",
                "args0": [
                    { "type": "field_input", "name": "TEXT", "text": "Hello RoboSpace!" }
                ],
                "previousStatement": null,
                "nextStatement": null,
                "colour": 200,
                "tooltip": "Print message to the console."
            }
        ];

        Blockly.defineBlocksWithJsonArray(blockDefs);

        // Define Python generators
        const pyGen = (Blockly.Python && Blockly.Python.forBlock)
            ? Blockly.Python.forBlock
            : (Blockly.Python || {});

        pyGen['robospace_arm_move'] = function (block) {
            const x = block.getFieldValue('X');
            const y = block.getFieldValue('Y');
            const z = block.getFieldValue('Z');
            return `robot.arm.move_to([${x}, ${y}, ${z}])\n`;
        };

        pyGen['robospace_arm_home'] = function () {
            return `robot.arm.home()\n`;
        };

        pyGen['robospace_gripper_open'] = function () {
            return `robot.gripper.open()\n`;
        };

        pyGen['robospace_gripper_close'] = function () {
            return `robot.gripper.close()\n`;
        };

        pyGen['robospace_gripper_set'] = function (block) {
            const pos = block.getFieldValue('POS');
            return `robot.gripper.set_position(${pos})\n`;
        };

        pyGen['robospace_base_drive'] = function (block) {
            const vx = block.getFieldValue('VX');
            const wz = block.getFieldValue('WZ');
            const dur = block.getFieldValue('DURATION');
            return `robot.base.drive(${vx}, ${wz}, ${dur})\n`;
        };

        pyGen['robospace_base_stop'] = function () {
            return `robot.base.stop()\n`;
        };

        pyGen['robospace_joint_set'] = function (block) {
            const joint = block.getFieldValue('JOINT');
            const angle = block.getFieldValue('ANGLE');
            return `robot.get_joint("${joint}").set_angle(${angle})\n`;
        };

        pyGen['robospace_get_selected_body_pos'] = function () {
            const order = (Blockly.Python && Blockly.Python.ORDER_ATOMIC) !== undefined ? Blockly.Python.ORDER_ATOMIC : 0;
            return [`body_pos(get_selected_body() or "")`, order];
        };

        pyGen['robospace_sleep'] = function (block) {
            const sec = block.getFieldValue('SECONDS');
            return `wait(${sec})\n`;
        };

        pyGen['robospace_print'] = function (block) {
            const text = block.getFieldValue('TEXT');
            return `print("${text}")\n`;
        };
    }

    initWorkspace() {
        if (!window.Blockly) return;

        const toolboxXml = `
            <xml id="toolbox" style="display: none">
              <category name="🤖 Arm" colour="#3b82f6">
                <block type="robospace_arm_move"></block>
                <block type="robospace_arm_home"></block>
              </category>
              <category name="🖐 Gripper" colour="#10b981">
                <block type="robospace_gripper_open"></block>
                <block type="robospace_gripper_close"></block>
                <block type="robospace_gripper_set"></block>
              </category>
              <category name="🚗 Drive Base" colour="#f59e0b">
                <block type="robospace_base_drive"></block>
                <block type="robospace_base_stop"></block>
              </category>
              <category name="⚙️ Joints" colour="#8b5cf6">
                <block type="robospace_joint_set"></block>
              </category>
              <category name="🎯 Vision & Stage" colour="#eab308">
                <block type="robospace_get_selected_body_pos"></block>
              </category>
              <category name="⏱ Control & Print" colour="#06b6d4">
                <block type="robospace_sleep"></block>
                <block type="robospace_print"></block>
                <block type="controls_repeat_ext">
                  <value name="TIMES">
                    <shadow type="math_number"><field name="NUM">3</field></shadow>
                  </value>
                </block>
                <block type="controls_if"></block>
              </category>
              <category name="🔢 Math & Text" colour="#64748b">
                <block type="math_number"></block>
                <block type="text"></block>
              </category>
            </xml>
        `;

        if (!document.getElementById('toolbox')) {
            const div = document.createElement('div');
            div.innerHTML = toolboxXml;
            document.body.appendChild(div.firstElementChild);
        }

        let darkTheme = null;
        if (Blockly.Theme && Blockly.Theme.defineTheme) {
            try {
                darkTheme = Blockly.Theme.defineTheme('robospace_dark', {
                    componentStyles: {
                        workspaceBackgroundColour: '#141419',
                        toolboxBackgroundColour: '#16161d',
                        toolboxForegroundColour: '#f1f5f9',
                        flyoutBackgroundColour: '#121218',
                        flyoutForegroundColour: '#f1f5f9',
                        flyoutOpacity: 0.95,
                        scrollbarColour: '#334155',
                        scrollbarOpacity: 0.7,
                        insertionMarkerColour: '#3b82f6',
                        insertionMarkerOpacity: 0.3,
                        markerColour: '#3b82f6',
                        cursorColour: '#3b82f6'
                    }
                });
            } catch (e) {
                // theme fallback
            }
        }

        const injectOptions = {
            toolbox: document.getElementById('toolbox'),
            collapse: false,
            comments: true,
            disable: false,
            maxBlocks: Infinity,
            trashcan: true,
            horizontalLayout: false,
            toolboxPosition: 'start',
            css: true,
            media: 'https://unpkg.com/blockly/media/',
            rtl: false,
            sounds: false,
            oneBasedIndex: true,
            grid: {
                spacing: 20,
                length: 3,
                colour: '#2a2a35',
                snap: true
            },
            zoom: {
                controls: true,
                wheel: true,
                startScale: 0.85,
                maxScale: 2,
                minScale: 0.4,
                scaleSpeed: 1.2
            }
        };

        if (darkTheme) injectOptions.theme = darkTheme;

        this.workspace = Blockly.inject(this.containerEl, injectOptions);

        this.loadDefaultBlocks();

        let _timer = null;
        this.workspace.addChangeListener(() => {
            clearTimeout(_timer);
            _timer = setTimeout(() => {
                if (this.onPythonGenerated) {
                    const pyCode = this.generatePython();
                    this.onPythonGenerated(pyCode);
                }
            }, 100);
        });

        this.enabled = true;
    }

    loadDefaultBlocks() {
        if (!this.workspace) return;
        const defaultXml = `
            <xml xmlns="https://developers.google.com/blockly/xml">
              <block type="robospace_arm_move" x="30" y="30">
                <field name="X">0.4</field>
                <field name="Y">0.0</field>
                <field name="Z">0.25</field>
                <next>
                  <block type="robospace_sleep">
                    <field name="SECONDS">1.0</field>
                    <next>
                      <block type="robospace_arm_home"></block>
                    </next>
                  </block>
                </next>
              </block>
            </xml>
        `;
        try {
            this.workspace.clear();
            const xml = Blockly.utils.xml.textToDom(defaultXml);
            Blockly.Xml.domToWorkspace(xml, this.workspace);
        } catch (e) {
            console.warn('Failed to load default Blockly XML:', e);
        }
    }

    generatePython() {
        if (!this.workspace || !Blockly.Python) return '# Blockly not available';
        const bodyCode = Blockly.Python.workspaceToCode(this.workspace);
        return `import time\n\nrobot = get_robot()\nprint("Moving UR5e arm to target [0.4, 0.0, 0.25]...")\n${bodyCode}`;
    }

    resize() {
        if (this.workspace && window.Blockly) {
            Blockly.svgResize(this.workspace);
        }
    }
}
