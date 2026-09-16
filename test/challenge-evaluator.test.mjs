// test/challenge-evaluator.test.mjs
//
// Tests for ChallengeEvaluator, challenge registry specifications,
// success threshold detection, and star rating calculations.

import { CHALLENGES } from '../examples/utils/challengeRegistry.js';
import { ChallengeEvaluator } from '../examples/utils/ChallengeEvaluator.js';

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));
const eq = (got, want, m) => check(
  JSON.stringify(got) === JSON.stringify(want),
  JSON.stringify(got) === JSON.stringify(want) ? m : `${m} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`
);

console.log('challenge registry validation');
{
  check(Object.keys(CHALLENGES).length >= 3, 'contains at least 3 challenges');

  const welcome = CHALLENGES['welcome_first_motion'];
  check(welcome !== undefined, 'welcome_first_motion exists');
  check(welcome.xpReward === 100, 'welcome quest awards 100 XP');
  check(welcome.difficulty === 'Beginner', 'welcome quest is Beginner');
  check(welcome.starterPython.includes('robot.move_to'), 'welcome quest contains starter python');
  check(welcome.targetPositions.length === 1, 'welcome quest has 1 target beacon');

  const racer = CHALLENGES['daily_waypoint_racer'];
  check(racer !== undefined, 'daily_waypoint_racer exists');
  check(racer.targetPositions.length === 3, 'daily racer has 3 waypoints');
  check(racer.starTargets.time > 0 && racer.starTargets.energy > 0, 'starTargets configured');
}

console.log('\nchallenge evaluator lifecycle & mock physics simulation');
{
  const mockScene = {
    add: () => {},
    remove: () => {},
  };
  const mockClock = { time: 1.5 };
  const mockDemo = {
    scene: mockScene,
    simClock: mockClock,
  };

  const evaluator = new ChallengeEvaluator(mockDemo);
  check(evaluator.status === 'idle', 'evaluator starts idle');

  let progressEvents = [];
  let completeEvent = null;

  const started = evaluator.start(
    'welcome_first_motion',
    (p) => progressEvents.push(p),
    (c) => { completeEvent = c; }
  );

  check(started === true, 'evaluator starts challenge successfully');
  check(evaluator.status === 'running', 'evaluator status becomes running');

  // Mock model and sim at tool position away from beacon
  const mockModel = {
    getOptions: () => ({ timestep: 0.01 }),
    nsite: 1,
    nbody: 8,
  };

  const mockSimFar = {
    site_xpos: new Float64Array([0.0, 0.0, 0.0]), // Origin (far from beacon at 0.35, 0.15, 0.45)
    ctrl: new Float64Array([1.0, 1.0, 1.0]),
    qpos: new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
  };

  // Run sample far away
  evaluator.lastProgressEmit = 0; // force emit
  evaluator.sample(mockSimFar, mockModel);

  check(evaluator.status === 'running', 'evaluator still running when far away');
  check(completeEvent === null, 'completeEvent not fired when far away');
  check(progressEvents.length > 0, 'progress event emitted');
  check(progressEvents[0].distanceToGoal > 0.4, 'distanceToGoal is accurate');
  check(evaluator.qposHistory.length === 1, 'qpos trajectory sampled');

  // Advance time and place tool right inside the target beacon: [0.35, 0.15, 0.45]
  mockClock.time = 3.2; // Under 4.0s for speed star
  const mockSimAtGoal = {
    site_xpos: new Float64Array([0.35, 0.15, 0.45]),
    ctrl: new Float64Array([0.5, 0.5, 0.5]),
    qpos: new Float64Array([0.35, 0.15, 0.45, 0, 0, 0]),
  };

  evaluator.lastProgressEmit = 0; // force emit
  evaluator.sample(mockSimAtGoal, mockModel);

  check(evaluator.status === 'completed', 'status becomes completed upon reaching goal');
  check(completeEvent !== null, 'completeEvent fired');
  check(completeEvent.challengeId === 'welcome_first_motion', 'challengeId matches');
  check(completeEvent.stars >= 2, 'earned at least 2 stars (goal + speed)');
  check(completeEvent.timeSeconds > 0, 'timeSeconds reported');
  check(completeEvent.energyTotal > 0, 'energyTotal reported');
  check(completeEvent.qposTrajectory.length >= 1, 'trajectory history attached for ghost replay');

  // Stop evaluator cleans up
  evaluator.stop();
  check(evaluator.status === 'idle', 'evaluator idle after stop()');
}

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
