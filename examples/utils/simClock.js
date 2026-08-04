// examples/utils/simClock.js
//
// Simulation time, reconstructed as steps × timestep.
//
// WHY THIS EXISTS
//
// `d->time` is not bound in this WASM build (only mjOption::timestep and
// mjLROpt::timestep are), so MuJoCo's own clock is unreachable. What Python's
// get_time() returned instead was `demo.mujoco_time / 1000`, and mujoco_time is not
// simulation time at all — it is a wall-clock catch-up accumulator that render()
// resyncs to the requestAnimationFrame timestamp:
//
//     if (timeMS - this.mujoco_time > 35.0) { this.mujoco_time = timeMS; }
//
// So get_time() reported roughly *seconds since page load*, never reset with reset(),
// froze while paused and then jumped by the pause duration, and jumped again on every
// scene load. Three of the six shipped Python examples drive actuators from it, which
// is why they visibly glitch after a pause.
//
// mujoco_time still has to do its own job for the render loop, so it cannot simply be
// repurposed — hence a separate counter, advanced wherever the simulation is actually
// stepped.
//
// THE FAILURE MODE TO WATCH FOR
//
// A fifth `simulation.step()` call site added later would silently desync this clock:
// time would run slow with no error anywhere. test/sim-clock.test.mjs scans the source
// for exactly that.

export class SimClock {
  constructor() {
    this.steps = 0;
    this.time = 0;
  }

  /** @param {number} n how many steps were just taken @param {number} timestep seconds */
  advance(n, timestep) {
    if (!(n > 0) || !(timestep > 0)) return;
    this.steps += n;
    this.time += n * timestep;
  }

  /** @param {number} [t] seconds; a keyframe reset carries model.key_time[k]. */
  reset(t = 0) {
    this.steps = 0;
    this.time = Number.isFinite(t) ? t : 0;
  }
}
