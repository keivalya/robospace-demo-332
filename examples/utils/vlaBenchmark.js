/**
 * Measure a VLA policy's task success in RoboSpace.
 *
 * The policy is validated at 70% on LIBERO-spatial, but LIBERO drives the arm
 * through operational-space control while this simulator drives joint position
 * targets. vla_control_loop() bridges that with per-action IK, which is a
 * different plant from the one the policy learned on. Whether the transfer
 * survives is an empirical question, and this is what answers it.
 *
 * Deliberately separate from DatasetPipelineUI: that exists to *record*
 * demonstrations, so it carries a DataRecorder, frame capture, and export
 * machinery that would only slow a benchmark down and muddy what is being
 * measured. The scene setup, domain randomization and success predicate are
 * reused from the same TEACHER_TASKS definitions, so a VLA number and a teacher
 * number are directly comparable.
 */

import { TEACHER_TASKS } from './macroTeacher.js';

/**
 * Wilson score interval.
 *
 * The normal approximation is badly wrong at the episode counts a browser-based
 * benchmark can afford — at 0/5 it produces an interval of zero width, implying
 * certainty from five samples. Wilson stays honest there.
 */
export function wilson(successes, trials, z = 1.96) {
  if (!trials) return [0, 0];
  const p = successes / trials;
  const d = 1 + (z * z) / trials;
  const centre = (p + (z * z) / (2 * trials)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * Run N episodes of one task under a VLA policy.
 *
 * @param {object}   opts
 * @param {object}   opts.demo          RoboSpaceDemo instance
 * @param {string}   opts.taskKey       key into TEACHER_TASKS
 * @param {number}   [opts.episodes]
 * @param {string}   [opts.prompt]      defaults to the task's own description
 * @param {number}   [opts.duration]    sim-seconds allowed per episode
 * @param {number}   [opts.execute]     actions run per inference
 * @param {(p:object)=>void} [opts.onProgress]
 * @param {() => boolean}    [opts.shouldStop]
 * @returns {Promise<object>}
 */
export async function runVlaBenchmark({
  demo,
  taskKey,
  episodes = 10,
  prompt = null,
  duration = 30,
  execute = 25,
  onProgress = null,
  shouldStop = null,
}) {
  const task = TEACHER_TASKS[taskKey];
  if (!task) throw new Error(`unknown task ${taskKey}; have ${Object.keys(TEACHER_TASKS).join(', ')}`);
  if (!window.pyodide) throw new Error('Pyodide is not ready yet.');

  const instruction = prompt || task.description || task.name;
  const rows = [];
  const started = performance.now();

  if (task.sceneXml && typeof window.robospaceLoadScene === 'function') {
    onProgress?.({ phase: 'loading', taskKey });
    await window.robospaceLoadScene(task.sceneXml, task.robot, task.id);
  }

  for (let ep = 0; ep < episodes; ep++) {
    if (shouldStop?.()) break;

    window.resetSimulation?.();
    // Randomize exactly as the teacher pipeline does, so the two are measured
    // against the same distribution of starting scenes rather than the policy
    // being quietly handed easier ones.
    for (const [obj, r] of Object.entries(task.domainRandomization || {})) {
      window.simRandomizeObjectPose?.(obj, r.x, r.y, r.z, r.yaw);
    }

    onProgress?.({ phase: 'running', episode: ep, episodes, taskKey });

    let stats = null;
    let error = null;
    try {
      window.__vlaBenchArgs = { prompt: instruction, duration, execute };
      stats = await window.pyodide.runPythonAsync(`
import js
_a = js.window.__vlaBenchArgs
await vla_control_loop(_a.prompt, duration=_a.duration, execute=_a.execute, verbose=False)
`);
      if (stats && typeof stats.toJs === 'function') stats = stats.toJs({ dict_converter: Object.fromEntries });
    } catch (err) {
      // Abort rather than score it. vla_control_loop counts IK failures
      // internally instead of raising, so an exception reaching here is never a
      // task outcome -- it is a broken bridge, an unreachable server, a 429, or
      // a bug. Recording those as failed episodes manufactures a success rate
      // out of infrastructure errors, and that is not a hypothetical: a run
      // with a stale ParentBridge reported "0/10 = 0.0%" for ten identical
      // TypeErrors, which reads exactly like a policy that cannot do the task.
      const msg = err?.message || String(err);
      console.error(`[vlaBenchmark] aborted at episode ${ep + 1}:`, err);
      throw new Error(
        `VLA benchmark aborted at episode ${ep + 1}/${episodes}: ${msg} -- ` +
        'no success rate is reported because none was measured.');
    }

    const success = typeof task.evaluateSuccess === 'function'
      ? !!task.evaluateSuccess(demo.simulation, demo.model)
      : false;

    rows.push({ episode: ep, success, error, ...(stats || {}) });
    onProgress?.({ phase: 'episode', episode: ep, episodes, success, taskKey });
    await new Promise((r) => setTimeout(r, 0));   // let the UI paint
  }

  const trials = rows.length;
  const successes = rows.filter((r) => r.success).length;
  const [lo, hi] = wilson(successes, trials);
  const ikFailures = rows.reduce((a, r) => a + (r.ik_failures || 0), 0);
  const steps = rows.reduce((a, r) => a + (r.steps || 0), 0);

  return {
    taskKey,
    prompt: instruction,
    trials,
    successes,
    rate: trials ? successes / trials : 0,
    ci95: [lo, hi],
    // A high IK-failure rate means the adapter could not reach the poses the
    // policy asked for. That is a harness limitation, not a policy verdict, and
    // conflating the two would misread the whole benchmark.
    ikFailureRate: steps ? ikFailures / steps : 0,
    totalSteps: steps,
    wallSeconds: (performance.now() - started) / 1000,
    rows,
  };
}

/** One-line summary suitable for the console or a status bar. */
export function formatVlaResult(res) {
  const pct = (x) => `${(100 * x).toFixed(1)}%`;
  return (
    `${res.taskKey}: ${res.successes}/${res.trials} = ${pct(res.rate)} ` +
    `[95% CI ${pct(res.ci95[0])}, ${pct(res.ci95[1])}]  ` +
    `IK failures ${pct(res.ikFailureRate)}  ${res.wallSeconds.toFixed(0)}s`
  );
}
