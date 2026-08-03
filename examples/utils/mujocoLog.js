// examples/utils/mujocoLog.js
//
// Captures MuJoCo's stdout/stderr so we can recover the XML compiler's real
// diagnostic. When mj_loadXML fails it writes the reason into an error buffer
// which finish() then printf's (see src/main.template.cc:17-35). Emscripten
// routes printf through Module.print / Module.printErr, so installing hooks at
// load_mujoco() time is the only way to read that text from JS — the binding
// itself returns a null-pointer Model and throws nothing useful.
//
// Pass `mujocoLogHooks` to load_mujoco(), then bracket a compile with
// clearMjLog() / drainMjLog().

const MAX_LINES = 200;
const lines = [];

export function pushMjLog(text) {
  if (text === null || text === undefined) return;
  lines.push(String(text));
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

/** Returns everything buffered since the last drain, and empties the buffer. */
export function drainMjLog() {
  return lines.splice(0, lines.length);
}

export function clearMjLog() {
  lines.length = 0;
}

// Options for load_mujoco(). Still forwards to the console so the existing
// debugging workflow is unchanged.
export const mujocoLogHooks = {
  print: (text) => { pushMjLog(text); console.log(text); },
  printErr: (text) => { pushMjLog(text); console.error(text); },
};
