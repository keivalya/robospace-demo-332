// examples/utils/challengeRegistry.js
//
// Catalog of built-in challenges and evaluations for RoboSpace Arena & FTUX onboarding.

export const CHALLENGES = {
  'welcome_first_motion': {
    id: 'welcome_first_motion',
    title: 'First Motion: Reach the Beacon',
    subtitle: 'Welcome Quest • 60-Second Onboarding',
    difficulty: 'Beginner',
    robotName: 'UR5e',
    xpReward: 100,
    targetTolerance: 0.06, // 6 cm
    starTargets: {
      time: 4.0,   // Under 4s sim time
      energy: 120, // Low energy
    },
    targetPositions: [
      { x: 0.35, y: 0.15, z: 0.45, label: 'Beacon' }
    ],
    starterPython: `# Welcome Quest: First Motion
# Goal: Move the end-effector into the glowing target beacon!

target = [0.35, 0.15, 0.45]
print(f"Moving toward beacon at {target}...")

robot.move_to(target)
run(1.5)

print("Target reached!")
`,
    // Evaluates tool tip distance to beacon
    evaluate(sim, model, elapsed, energy) {
      let toolX = 0, toolY = 0, toolZ = 0;
      if (model.nsite > 0 && sim.site_xpos) {
        toolX = sim.site_xpos[0];
        toolY = sim.site_xpos[1];
        toolZ = sim.site_xpos[2];
      } else if (model.nbody >= 7 && sim.xpos) {
        const adr = 7 * 3;
        toolX = sim.xpos[adr];
        toolY = sim.xpos[adr + 1];
        toolZ = sim.xpos[adr + 2];
      }

      const target = this.targetPositions[0];
      const dist = Math.hypot(toolX - target.x, toolY - target.y, toolZ - target.z);

      const success = dist < this.targetTolerance;
      return {
        distanceToGoal: dist,
        success,
        waypointsRemaining: success ? 0 : 1,
      };
    },
  },

  'daily_waypoint_racer': {
    id: 'daily_waypoint_racer',
    title: 'Waypoint Racer: 3-Point Patrol',
    subtitle: 'Daily Challenge #1 • Precision & Smoothness',
    difficulty: 'Intermediate',
    robotName: 'UR5e',
    xpReward: 150,
    targetTolerance: 0.06,
    starTargets: {
      time: 6.0,
      energy: 220,
    },
    targetPositions: [
      { x: 0.35, y: 0.20, z: 0.45, label: 'Waypoint A' },
      { x: 0.35, y: -0.20, z: 0.45, label: 'Waypoint B' },
      { x: 0.40, y: 0.00, z: 0.55, label: 'Waypoint C' },
    ],
    starterPython: `# Daily Challenge: Waypoint Racer
# Goal: Visit all three waypoints (A, B, C) in sequence!

waypoints = [
    [0.35,  0.20, 0.45], # Waypoint A
    [0.35, -0.20, 0.45], # Waypoint B
    [0.40,  0.00, 0.55], # Waypoint C
]

for i, pt in enumerate(waypoints):
    print(f"Navigating to Waypoint {chr(65+i)}: {pt}")
    robot.move_to(pt)
    run(1.0)

print("Circuit complete!")
`,
    evaluate(sim, model, elapsed, energy, state) {
      state.visitedIndex = state.visitedIndex || 0;
      let toolX = 0, toolY = 0, toolZ = 0;
      if (model.nsite > 0 && sim.site_xpos) {
        toolX = sim.site_xpos[0];
        toolY = sim.site_xpos[1];
        toolZ = sim.site_xpos[2];
      } else if (model.nbody >= 7 && sim.xpos) {
        const adr = 7 * 3;
        toolX = sim.xpos[adr];
        toolY = sim.xpos[adr + 1];
        toolZ = sim.xpos[adr + 2];
      }

      const currentTarget = this.targetPositions[state.visitedIndex];
      if (!currentTarget) {
        return { distanceToGoal: 0, success: true, waypointsRemaining: 0 };
      }

      const dist = Math.hypot(toolX - currentTarget.x, toolY - currentTarget.y, toolZ - currentTarget.z);
      if (dist < this.targetTolerance) {
        state.visitedIndex++;
      }

      const success = state.visitedIndex >= this.targetPositions.length;
      return {
        distanceToGoal: dist,
        success,
        waypointsRemaining: Math.max(0, this.targetPositions.length - state.visitedIndex),
        currentTargetIndex: state.visitedIndex,
      };
    },
  },

  'daily_vertical_liftoff': {
    id: 'daily_vertical_liftoff',
    title: 'High Reach: Elevation Test',
    subtitle: 'Daily Challenge #2 • Joint Coordination',
    difficulty: 'Intermediate',
    robotName: 'UR5e',
    xpReward: 150,
    targetTolerance: 0.05,
    starTargets: {
      time: 5.0,
      energy: 180,
    },
    targetPositions: [
      { x: 0.30, y: 0.00, z: 0.70, label: 'High Apex' }
    ],
    starterPython: `# Daily Challenge: High Reach
# Goal: Extend the arm vertically to reach the high apex beacon at Z = 0.70m

target = [0.30, 0.00, 0.70]
robot.move_to(target)
run(1.2)
`,
    evaluate(sim, model, elapsed, energy) {
      let toolX = 0, toolY = 0, toolZ = 0;
      if (model.nsite > 0 && sim.site_xpos) {
        toolX = sim.site_xpos[0];
        toolY = sim.site_xpos[1];
        toolZ = sim.site_xpos[2];
      } else if (model.nbody >= 7 && sim.xpos) {
        const adr = 7 * 3;
        toolX = sim.xpos[adr];
        toolY = sim.xpos[adr + 1];
        toolZ = sim.xpos[adr + 2];
      }

      const target = this.targetPositions[0];
      const dist = Math.hypot(toolX - target.x, toolY - target.y, toolZ - target.z);
      const success = dist < this.targetTolerance;

      return {
        distanceToGoal: dist,
        success,
        waypointsRemaining: success ? 0 : 1,
      };
    },
  }
};
