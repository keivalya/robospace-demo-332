// examples/utils/macroTeacher.js
//
// The "Privileged" Macro Action Engine (The Teacher)
// Defines scripted manipulation policies that leverage privileged simulation state
// (e.g. sim.get_exact_object_pose) to compute perfect waypoints, perform domain randomization,
// and evaluate episode success.

export const TEACHER_TASKS = {
  panda_pick_cube: {
    id: 'panda_pick_cube',
    name: 'Franka Panda — Pick Cube',
    robot: 'franka_panda',
    description: 'Franka Panda grasps a cube from the table and lifts it.',
    sceneXml: `<mujoco model="panda_pick_cube">
  <include file="panda.xml"/>
  <compiler angle="radian" autolimits="true"/>
  <option integrator="implicitfast"/>
  <asset>
    <texture type="skybox" builtin="gradient" rgb1="0.3 0.5 0.7" rgb2="0 0 0" width="512" height="3072"/>
    <texture type="2d" name="grid" builtin="checker" mark="edge" rgb1="0.2 0.3 0.4" rgb2="0.1 0.2 0.3" markrgb="0.8 0.8 0.8" width="300" height="300"/>
    <material name="grid" texture="grid" texuniform="true" texrepeat="5 5" reflectance="0.2"/>
  </asset>
  <worldbody>
    <light pos="0 0 3" dir="0 0 -1" directional="true"/>
    <geom name="floor" size="0 0 0.05" type="plane" material="grid"/>
    <camera name="front_camera" pos="0.85 0.0 0.45" xyaxes="0 1 0 -0.5 0 0.866" mode="fixed"/>
    <body name="cube" pos="0.5 0 0.025">
      <freejoint/>
      <geom type="box" size="0.025 0.025 0.025" rgba="0.85 0.3 0.3 1" density="300" friction="1.5 0.02 0.001"/>
    </body>
  </worldbody>
</mujoco>`,
    domainRandomization: {
      cube: {
        x: [0.44, 0.54],
        y: [-0.12, 0.12],
        z: 0.025,
        yaw: [-0.4, 0.4],
      },
    },
    pythonScript: `# Privileged Teacher Policy: Pick Cube
import numpy as np

# 1. State Cheating: Query exact ground-truth object pose
cube_pose = sim.get_exact_object_pose("cube")
cx, cy, cz = float(cube_pose["pos"][0]), float(cube_pose["pos"][1]), float(cube_pose["pos"][2])

# Panda tool offset: hand body origin sits ~0.1034m above fingertips
tips_z = cz + 0.1034

# 2. Semantic Actions: Hover -> Grasp -> Close -> Lift
robot.open_gripper(seconds=0.4)
robot.reach_pose(cx, cy, tips_z + 0.10, quat=tool_down(), seconds=1.0)
robot.reach_pose(cx, cy, tips_z + 0.005, quat=tool_down(), seconds=0.6)
robot.close_gripper(seconds=0.8)
robot.reach_pose(cx, cy, tips_z + 0.22, quat=tool_down(), seconds=1.0)
robot.wait(0.5)
`,
    evaluateSuccess(sim, model) {
      // Cube is lifted above table (z > 0.12m)
      if (!sim || !model) return false;
      let cubeZ = 0;
      if (model.name_bodyadr) {
        for (let i = 0; i < model.nbody; i++) {
          const adr = model.name_bodyadr[i];
          let name = '';
          while (model.names[adr + name.length] && model.names[adr + name.length] !== 0) {
            name += String.fromCharCode(model.names[adr + name.length]);
          }
          if (name === 'cube') {
            cubeZ = sim.xpos[3 * i + 2];
            break;
          }
        }
      }
      return cubeZ > 0.12;
    },
  },

  panda_pick_and_place: {
    id: 'panda_pick_and_place',
    name: 'Franka Panda — Pick and Place',
    robot: 'franka_panda',
    description: 'Franka Panda picks up a cube and places it onto a green target pad.',
    sceneXml: `<mujoco model="panda_pick_and_place">
  <include file="panda.xml"/>
  <compiler angle="radian" autolimits="true"/>
  <option integrator="implicitfast"/>
  <asset>
    <texture type="skybox" builtin="gradient" rgb1="0.3 0.5 0.7" rgb2="0 0 0" width="512" height="3072"/>
    <texture type="2d" name="grid" builtin="checker" mark="edge" rgb1="0.2 0.3 0.4" rgb2="0.1 0.2 0.3" markrgb="0.8 0.8 0.8" width="300" height="300"/>
    <material name="grid" texture="grid" texuniform="true" texrepeat="5 5" reflectance="0.2"/>
  </asset>
  <worldbody>
    <light pos="0 0 3" dir="0 0 -1" directional="true"/>
    <geom name="floor" size="0 0 0.05" type="plane" material="grid"/>
    <camera name="front_camera" pos="0.85 0.0 0.45" xyaxes="0 1 0 -0.5 0 0.866" mode="fixed"/>
    <geom name="pad" pos="0.4 0.25 0.001" size="0.08 0.08 0.001" type="box" rgba="0.25 0.6 0.35 1"/>
    <body name="cube" pos="0.5 0 0.025">
      <freejoint/>
      <geom type="box" size="0.025 0.025 0.025" rgba="0.85 0.3 0.3 1" density="300" friction="1.5 0.02 0.001"/>
    </body>
  </worldbody>
</mujoco>`,
    domainRandomization: {
      cube: {
        x: [0.45, 0.53],
        y: [-0.10, 0.08],
        z: 0.025,
        yaw: [-0.3, 0.3],
      },
    },
    pythonScript: `# Privileged Teacher Policy: Pick and Place
import numpy as np

cube_pose = sim.get_exact_object_pose("cube")
cx, cy, cz = float(cube_pose["pos"][0]), float(cube_pose["pos"][1]), float(cube_pose["pos"][2])
tips_z = cz + 0.1034

target_pad = [0.4, 0.25, tips_z]

# Pick
robot.open_gripper(seconds=0.4)
robot.reach_pose(cx, cy, tips_z + 0.10, quat=tool_down(), seconds=0.8)
robot.reach_pose(cx, cy, tips_z + 0.005, quat=tool_down(), seconds=0.5)
robot.close_gripper(seconds=0.8)
robot.reach_pose(cx, cy, tips_z + 0.20, quat=tool_down(), seconds=0.8)

# Place onto pad
robot.reach_pose(target_pad[0], target_pad[1], tips_z + 0.20, quat=tool_down(), seconds=1.0)
robot.reach_pose(target_pad[0], target_pad[1], tips_z + 0.015, quat=tool_down(), seconds=0.6)
robot.open_gripper(seconds=0.5)
robot.reach_pose(target_pad[0], target_pad[1], tips_z + 0.20, quat=tool_down(), seconds=0.8)
robot.wait(0.5)
`,
    evaluateSuccess(sim, model) {
      if (!sim || !model) return false;
      let cubeX = 0, cubeY = 0, cubeZ = 0;
      if (model.name_bodyadr) {
        for (let i = 0; i < model.nbody; i++) {
          const adr = model.name_bodyadr[i];
          let name = '';
          while (model.names[adr + name.length] && model.names[adr + name.length] !== 0) {
            name += String.fromCharCode(model.names[adr + name.length]);
          }
          if (name === 'cube') {
            cubeX = sim.xpos[3 * i + 0];
            cubeY = sim.xpos[3 * i + 1];
            cubeZ = sim.xpos[3 * i + 2];
            break;
          }
        }
      }
      const dist = Math.hypot(cubeX - 0.4, cubeY - 0.25);
      return dist < 0.08 && cubeZ < 0.06;
    },
  },

  panda_stack_blocks: {
    id: 'panda_stack_blocks',
    name: 'Franka Panda — Stack Blocks',
    robot: 'franka_panda',
    description: 'Franka Panda picks up a top cube and stacks it onto a base cube.',
    sceneXml: `<mujoco model="panda_stack_blocks">
  <include file="panda.xml"/>
  <compiler angle="radian" autolimits="true"/>
  <option integrator="implicitfast"/>
  <asset>
    <texture type="skybox" builtin="gradient" rgb1="0.3 0.5 0.7" rgb2="0 0 0" width="512" height="3072"/>
    <texture type="2d" name="grid" builtin="checker" mark="edge" rgb1="0.2 0.3 0.4" rgb2="0.1 0.2 0.3" markrgb="0.8 0.8 0.8" width="300" height="300"/>
    <material name="grid" texture="grid" texuniform="true" texrepeat="5 5" reflectance="0.2"/>
  </asset>
  <worldbody>
    <light pos="0 0 3" dir="0 0 -1" directional="true"/>
    <geom name="floor" size="0 0 0.05" type="plane" material="grid"/>
    <camera name="front_camera" pos="0.85 0.0 0.45" xyaxes="0 1 0 -0.5 0 0.866" mode="fixed"/>
    <body name="base_cube" pos="0.45 0.15 0.025">
      <freejoint/>
      <geom type="box" size="0.025 0.025 0.025" rgba="0.3 0.5 0.85 1" density="400" friction="1.5 0.02 0.001"/>
    </body>
    <body name="top_cube" pos="0.50 -0.10 0.025">
      <freejoint/>
      <geom type="box" size="0.025 0.025 0.025" rgba="0.85 0.3 0.3 1" density="300" friction="1.5 0.02 0.001"/>
    </body>
  </worldbody>
</mujoco>`,
    domainRandomization: {
      top_cube: {
        x: [0.46, 0.53],
        y: [-0.14, -0.06],
        z: 0.025,
        yaw: [-0.2, 0.2],
      },
    },
    pythonScript: `# Privileged Teacher Policy: Stack Blocks
import numpy as np

top_pose = sim.get_exact_object_pose("top_cube")
base_pose = sim.get_exact_object_pose("base_cube")

tx, ty, tz = float(top_pose["pos"][0]), float(top_pose["pos"][1]), float(top_pose["pos"][2])
bx, by, bz = float(base_pose["pos"][0]), float(base_pose["pos"][1]), float(base_pose["pos"][2])
tips_z = tz + 0.1034

# Pick top cube
robot.open_gripper(seconds=0.4)
robot.reach_pose(tx, ty, tips_z + 0.10, quat=tool_down(), seconds=0.8)
robot.reach_pose(tx, ty, tips_z + 0.005, quat=tool_down(), seconds=0.5)
robot.close_gripper(seconds=0.8)
robot.reach_pose(tx, ty, tips_z + 0.20, quat=tool_down(), seconds=0.8)

# Stack on top of base cube
stack_z = bz + 0.05 + 0.1034
robot.reach_pose(bx, by, stack_z + 0.10, quat=tool_down(), seconds=1.0)
robot.reach_pose(bx, by, stack_z + 0.008, quat=tool_down(), seconds=0.6)
robot.open_gripper(seconds=0.5)
robot.reach_pose(bx, by, stack_z + 0.15, quat=tool_down(), seconds=0.8)
robot.wait(0.5)
`,
    evaluateSuccess(sim, model) {
      if (!sim || !model) return false;
      let topX = 0, topY = 0, topZ = 0;
      let baseX = 0, baseY = 0;
      if (model.name_bodyadr) {
        for (let i = 0; i < model.nbody; i++) {
          const adr = model.name_bodyadr[i];
          let name = '';
          while (model.names[adr + name.length] && model.names[adr + name.length] !== 0) {
            name += String.fromCharCode(model.names[adr + name.length]);
          }
          if (name === 'top_cube') {
            topX = sim.xpos[3 * i + 0];
            topY = sim.xpos[3 * i + 1];
            topZ = sim.xpos[3 * i + 2];
          } else if (name === 'base_cube') {
            baseX = sim.xpos[3 * i + 0];
            baseY = sim.xpos[3 * i + 1];
          }
        }
      }
      const dist = Math.hypot(topX - baseX, topY - baseY);
      return topZ > 0.045 && dist < 0.05;
    },
  },

  ur5e_reach_beacon: {
    id: 'ur5e_reach_beacon',
    name: 'UR5e — Reach Target Beacon',
    robot: 'universal_robots_ur5e',
    description: 'UR5e arm reaches a target beacon in 3D workspace.',
    sceneXml: null, // Uses default ur5e scene
    domainRandomization: {},
    pythonScript: `# Privileged Teacher Policy: Reach Beacon
target = [0.35, 0.15, 0.45]
robot.reach_pose(target[0], target[1], target[2], seconds=1.5)
robot.wait(0.5)
`,
    evaluateSuccess(sim, model) {
      if (!sim || !model) return false;
      let toolX = 0, toolY = 0, toolZ = 0;
      if (model.nsite > 0 && sim.site_xpos) {
        toolX = sim.site_xpos[0];
        toolY = sim.site_xpos[1];
        toolZ = sim.site_xpos[2];
      }
      return Math.hypot(toolX - 0.35, toolY - 0.15, toolZ - 0.45) < 0.06;
    },
  },
};
