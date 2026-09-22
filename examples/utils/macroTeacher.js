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

  // SO-101 (SO-ARM101). The one robot the VLA path targets. "Cube" rather than
  // "block" to match the Panda tasks, and because the body really is named `cube`.
  //
  // Scene fidelity is the whole game here, because the policy is used zero-shot:
  // we cannot move it toward our simulator, so the simulator has to move toward
  // it. Three constraints shaped every number below.
  //
  // 1. Reach, measured not assumed. Sampling 60k random joint configurations in
  //    desktop MuJoCo and tracking the moving jaw gives a reachable envelope of
  //    x [-0.267, 0.407], max horizontal radius 0.409 m. Against that, a target
  //    at x=0.22 is approachable to within 9.5 mm, and 0.19-0.35 all come within
  //    12 mm. Menagerie's own scene_box.xml parks the block at x=0.5, which the
  //    jaw misses by 105 mm -- unreachable. Its `pickup` keyframe grasps at
  //    x=0.219 instead, which is the giveaway. Randomising in [0.19, 0.25] keeps
  //    every episode physically solvable; the shipped 0.5 would have scored 0%
  //    for a reason that has nothing to do with the policy.
  // 2. Textures. This WASM build cannot load a single image-file texture (see
  //    stripFileTextures), so every material here is procedural `builtin` or flat
  //    rgba -- deliberately byte-identical to Menagerie's own so101 scene.xml,
  //    which is in turn the same canonical scene as panda_pick_cube above.
  // 3. Cameras are declared, not synthesised. CameraViewer only invents a camera
  //    for a category the MJCF leaves empty, and its virtual poses are hardcoded
  //    at Panda table scale (0.45-0.95 m), which is wrong for a 0.4 m arm. Naming
  //    them also avoids captureImage's silent fallback: an unknown camera name
  //    returns the wrist view rather than erroring.
  //    so101.xml's own wrist_cam is left alone on purpose -- it specifies
  //    intrinsics (sensorsize/focal) rather than fovy, but MuJoCo derives
  //    cam_fovy from them at compile time (verified: 48.46), so CameraViewer's
  //    `cam_fovy > 0` check passes and no fallback occurs.
  //
  // The bowl is present but not scored. Both candidate checkpoints were trained
  // on pick-AND-place ("pick up the cube and place it in the bowl"), so a bare
  // block would be out of distribution even though we score only the lift.
  so101_pick_cube: {
    id: 'so101_pick_cube',
    name: 'SO-101 Pick Cube',
    // `pythonScript` below is a PRIVILEGED TEACHER: it reads the cube's exact
    // pose and uses no cameras, and it never contacts the inference server. That
    // is true of every entry in this table -- the dataset collector always runs
    // a scripted policy, and says so at runtime ("Executing Teacher Macro").
    //
    // The VLA drives the same scene through a different entry point
    // (vla_control_loop_so101 / vla_benchmark). Sharing scene, randomisation and
    // evaluateSuccess is the point: the teacher establishes that the scene is
    // solvable, and its number is what the policy's number is compared against.
    robot: 'robotstudio_so101',
    description: 'pick up the cube and place it in the bowl',
    sceneXml: `<mujoco model="so101_pick_cube">
  <include file="so101.xml"/>
  <compiler angle="radian" autolimits="true"/>
  <option integrator="implicitfast" timestep="0.005" cone="elliptic" impratio="10"/>
  <visual>
    <headlight diffuse="0.6 0.6 0.6" ambient="0.3 0.3 0.3" specular="0 0 0"/>
    <rgba haze="0.15 0.25 0.35 1"/>
    <global azimuth="160" elevation="-20"/>
  </visual>
  <asset>
    <texture type="skybox" builtin="gradient" rgb1="0.3 0.5 0.7" rgb2="0 0 0" width="512" height="3072"/>
    <texture type="2d" name="groundplane" builtin="checker" mark="edge" rgb1="0.2 0.3 0.4" rgb2="0.1 0.2 0.3" markrgb="0.8 0.8 0.8" width="300" height="300"/>
    <material name="groundplane" texture="groundplane" texuniform="true" texrepeat="5 5" reflectance="0.2"/>
  </asset>
  <worldbody>
    <light pos="0 0 3.5" dir="0 0 -1" directional="true"/>
    <geom name="floor" size="0 0 0.05" pos="0 0 0" type="plane" material="groundplane"/>
    <camera name="top" pos="0.20 0 0.45" fovy="45"/>
    <camera name="front" pos="0.45 0 0.35" zaxis="0.5 0 0.866" fovy="45"/>
    <body name="cube" pos="0.22 0 0.03">
      <freejoint/>
      <geom type="box" name="cube" size="0.02 0.02 0.03" condim="3" friction="1 .03 .003" rgba="0 1 0 1" solref="0.01 1"/>
    </body>
    <body name="bowl" pos="0.20 0.13 0.01">
      <geom type="cylinder" name="bowl" size="0.045 0.01" rgba="0.85 0.85 0.88 1"/>
    </body>
  </worldbody>
</mujoco>`,
    domainRandomization: {
      // Kept well inside the ~315 mm reach, and off the bowl.
      cube: { x: [0.19, 0.25], y: [-0.06, 0.04], z: 0.03, yaw: [-0.4, 0.4] },
    },
    pythonScript: `# Privileged Teacher Policy: SO-101 Pick Block
#
# Every constant here was measured in MuJoCo, not guessed, because the obvious
# version of this script does nothing at all. Three reasons it fails:
#
# 1. THE ARM HAS 5 DOF, not 6 (shoulder_pan, shoulder_lift, elbow_flex,
#    wrist_flex, wrist_roll). So asking IK for a full pose is asking for 6
#    constraints on 5 joints. Measured: position-only converges to 0.000 mm,
#    while position + tool_down() lands 11.3 mm and 22.3 degrees out -- which
#    fails ik_solve's rot_tol of 1e-3 rad by 390x. move_to() then raises and the
#    script dies after its first gripper command, which looks exactly like "the
#    gripper twitched and nothing else happened". Hence pos only, quat omitted.
#
# 2. THE GRASP IS LOW. Menagerie ships a 'pickup' keyframe in scene_box.xml with
#    the arm actually holding the block; measured against it, the TCP sits at
#    z=0.0135 -- 13.5 mm off the floor, BELOW the cube centre -- with the cube
#    centre offset from the TCP by (0.0116, 0.0124, 0.0065). Aiming at the cube
#    centre instead puts the gripper 56 mm high and it closes on air.
#
# 3. THE IK BRANCH MATTERS. ik_solve does 16 random restarts and no collision
#    checking, so at that height it will happily return a solution that puts the
#    arm through the floor. Seeding from the keyframe configuration keeps it in
#    the branch that is known to work, and each later solve is seeded from the
#    previous answer.
#
# Validated offline over the same randomisation this task uses: 20/20.
import numpy as np

TCP = 'site:gripperframe'
OFF = (0.0116, 0.0124, 0.0065)     # cube centre - TCP, at the keyframe grasp
GRASP_Z = 0.0135                   # TCP height when grasping
GRIP_OPEN, GRIP_CLOSE = 1.5, 0.10  # higher qpos = jaw further out = more open

# The keyframe's arm configuration, as a seed.
KF = {'shoulder_pan': 0.0, 'shoulder_lift': 0.000382, 'elbow_flex': 0.473496,
      'wrist_flex': 1.17717, 'wrist_roll': 1.58437}
_info = {j['name']: j for j in model_info()['jointInfo']}
seed = list(get_qpos())
for _n, _v in KF.items():
    seed[_info[_n]['qposadr']] = _v

cube = sim.get_exact_object_pose("cube")
cx, cy = float(cube["pos"][0]), float(cube["pos"][1])
gx, gy = cx - OFF[0], cy - OFF[1]

set_actuator('gripper', GRIP_OPEN)
run(0.4)

for _z, _grip, _secs in ((GRASP_Z + 0.07, GRIP_OPEN, 1.3),
                         (GRASP_Z,        GRIP_OPEN, 1.0),
                         (GRASP_Z,        GRIP_CLOSE, 0.9),
                         (GRASP_Z + 0.10, GRIP_CLOSE, 1.3)):
    sol = ik_solve(TCP, pos=[gx, gy, _z], seed=seed)
    if not sol['success']:
        raise RuntimeError('IK failed at z=%.4f: %s (pos_err %.4f)'
                           % (_z, sol['reason'], sol['pos_err']))
    seed = list(sol['qpos'])
    set_actuator('gripper', _grip)
    move_joints(sol['joints'], seconds=_secs)

run(0.5)
`,
    evaluateSuccess(sim, model) {
      // Lift only. The cube rests with its centre at z=0.03 (half-height 0.03),
      // so 0.08 is ~5 cm of unambiguous clearance -- scaled to a 0.3 m arm
      // rather than reusing Panda's 0.12.
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
      return cubeZ > 0.08;
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
