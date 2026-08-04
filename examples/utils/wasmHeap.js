// examples/utils/wasmHeap.js
//
// Reports the size of the WASM linear memory, so the unreclaimable growth described
// below is visible instead of ending a session with an uncatchable abort.
//
// WHY THIS IS A TRICK RATHER THAN A MEASUREMENT
//
// `dist/mujoco_wasm.js` was linked with EXPORTED_RUNTIME_METHODS=['FS','MEMFS'] and
// ASSERTIONS=1, so every ordinary handle on the heap *throws* when touched:
// Module.HEAPU8, Module.wasmMemory and Module.wasmExports all abort with "was not
// exported", and Module._malloc / Module._free are simply undefined. A typed array
// the module handed us, however, is a view onto that same linear memory — so its
// buffer's byteLength is the memory size. `model.names` is the convenient one: every
// compiled model has it.
//
// WHAT IT MEASURES
//
// Measured in Node against examples/scenes/universal_robots_ur5e/scene.xml:
//
//     initial load   256.3 MB
//     reload  1      369.2 MB
//     reload  3      531.7 MB
//     reload  6      636.9 MB
//     reload 12      966.5 MB      ~55 MB per reload; the 2 GB cap is ~25 reloads
//
// The cause is that nothing is ever freed. Simulation::free() in
// src/main.template.cc is `{ mju_free(_state); mju_free(_model); }`, which releases
// two 8-byte C++ wrapper structs; mj_deleteModel appears only in finish(), on a
// *failed* load, and mj_deleteData never appears at all. Isolated by experiment:
// 20x Model.load_from_xml leaves the heap flat at 16.5 MB, while 20x
// `new mujoco.State(model)` takes it from 16.5 MB to 299.8 MB. So mj_makeData's
// arena is essentially the whole leak.
//
// Fixing it properly needs the WASM rebuilt (bind mj_deleteModel/mj_deleteData, and
// export HEAPU8 so this file can stop being a trick), which is blocked — see the
// deferred section of the plan. Until then the mitigation is to watch this number
// and respawn the module before it reaches the cap.

/** Bytes of WASM linear memory, or 0 if it cannot be read. Never throws. */
export function heapBytes(model) {
  try {
    return model?.names?.buffer?.byteLength ?? 0;
  } catch (_) {
    return 0;
  }
}

export const MB = 1048576;

/** Warn once per crossing rather than once per reload, so the log stays readable. */
const WARN_AT_BYTES = 1000 * MB;

export function recordHeap(demo, model) {
  const bytes = heapBytes(model);
  if (!bytes) return 0;
  const previous = demo.heapBytes || 0;
  demo.heapBytes = bytes;
  if (bytes >= WARN_AT_BYTES && previous < WARN_AT_BYTES) {
    console.warn(
      `[robospace] WASM heap is ${(bytes / MB).toFixed(0)} MB and cannot shrink: this build `
      + 'never frees mjModel/mjData. Expect the module to abort somewhere past 2 GB. '
      + 'Reload the page to reclaim it.',
    );
  }
  return bytes;
}
