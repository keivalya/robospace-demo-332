# Panda picks up a block.
#
# Import this with the "Import .py" button rather than pasting it -- the XML block is
# long and pasting it has been truncated before.
#
# Note what is NOT here: no 'await' on any motion, no coroutines, no yield_control.
# Motion runs synchronously because stepping is far faster than real time; each motion
# records itself and the render loop replays it, so you still watch the robot move.
# Only loading a robot needs 'await', because it fetches meshes over the network.

SCENE = """<mujoco model="panda_pick">
  <include file="panda.xml"/>
  <compiler angle="radian" autolimits="true"/>
  <option integrator="implicitfast"/>
  <asset>
    <texture type="skybox" builtin="gradient" rgb1="0.3 0.5 0.7" rgb2="0 0 0"
             width="512" height="3072"/>
    <texture type="2d" name="grid" builtin="checker" mark="edge"
             rgb1="0.2 0.3 0.4" rgb2="0.1 0.2 0.3" markrgb="0.8 0.8 0.8"
             width="300" height="300"/>
    <material name="grid" texture="grid" texuniform="true" texrepeat="5 5"
              reflectance="0.2"/>
  </asset>
  <worldbody>
    <light pos="0 0 3" dir="0 0 -1" directional="true"/>
    <geom name="floor" size="0 0 0.05" type="plane" material="grid"/>
    <body name="cube" pos="0.5 0 0.025">
      <freejoint/>
      <geom type="box" size="0.025 0.025 0.025" rgba="0.85 0.3 0.3 1"
            density="300" friction="1.5 0.02 0.001"/>
    </body>
  </worldbody>
</mujoco>"""

await load_scene(SCENE, robot='franka_panda', name='panda_pick')
print_model()


def tips(z):
    """Hand position that puts the fingertips at height z above (0.5, 0).

    The Panda declares no <site>, so we aim its hand body. With the tool pointing down,
    the hand frame sits 0.1034 m above the fingertip midpoint.
    """
    return [0.5, 0.0, z + 0.1034]


GRASP = 0.030          # fingertip height at the grasp; the cube's centre is at 0.025

print('')
print('cube starts at z =', round(float(body_pos('cube')[2]), 4))

open_gripper()
move_to('body:hand', pos=tips(GRASP + 0.10), quat=tool_down())
move_to('body:hand', pos=tips(GRASP), quat=tool_down())
close_gripper()
move_to('body:hand', pos=tips(GRASP + 0.25), quat=tool_down())
run(1.0)

cube_z = float(body_pos('cube')[2])
fingers = float(get_joint('finger_joint1'))

print('')
print('cube height    %.4f m   (started 0.0250)' % cube_z)
print('finger opening %.4f m   (~0.025 = holding, ~0.000 = closed on nothing)' % fingers)
print('PICK SUCCEEDED' if cube_z > 0.15 else 'PICK FAILED')
