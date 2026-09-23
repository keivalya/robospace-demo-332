// Syntax-checks every module we own, including the browser-only ones.
//
//   npm run test:syntax
//
// WHY THIS EXISTS
//
// `main.js` and `pythonIntegration.js` cannot be imported under Node — top-level
// await on the WASM module, `document`, `localStorage`, Pyodide — so no test suite
// touches them. A syntax error in either therefore ships silently and only surfaces
// when a browser loads the page.
//
// That is not hypothetical. `pythonIntegration.js` holds the entire Python API inside
// a JS template literal, and a single raw backtick in a Python docstring terminated
// that literal and broke the whole module. The reported stack trace pointed at
// _populateExamplesWhenReady — an unrelated function several hundred lines away —
// so the error message actively misdirected.
//
// `node --check` parses without executing, which is exactly the right tool: it would
// have caught that in milliseconds. Run as a child process because there is no
// in-process API for "parse this ESM file and tell me if it is valid".

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };

// import.meta.dirname is Node 20+; this repo runs on 18, where it is undefined
// and path.join then throws ERR_INVALID_ARG_TYPE before a single file is checked.
const root = fileURLToPath(new URL('..', import.meta.url));

// Everything we author. `dist/` is generated and `examples/scenes/` holds assets.
const roots = ['examples', 'test', 'tools'];
const SKIP_DIRS = new Set(['scenes', 'robots', 'node_modules', 'fixtures']);

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(path.join(dir, entry.name), out);
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = roots
  .map((r) => path.join(root, r))
  .filter((d) => fs.existsSync(d))
  .flatMap((d) => collect(d))
  .sort();

console.log(`checking ${files.length} module(s)`);
for (const file of files) {
  const rel = path.relative(root, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    ok(rel);
  } catch (err) {
    const detail = (err.stderr ? err.stderr.toString() : String(err))
      .split('\n')
      .filter((l) => l.trim() && !/^\s*at /.test(l))
      .slice(0, 6)
      .join('\n      ');
    bad(`${rel}\n      ${detail}`);
  }
}

// Targeted guard for the specific trap above, because a syntax check only catches it
// when the stray backtick happens to unbalance the file. An *even* number of stray
// backticks would parse fine and silently truncate the Python source instead.
// Ground planes must not be Reflectors.
//
// CameraViewer.captureImage sets visible = false on every isReflector object
// for the duration of a capture -- a Reflector renders the scene into its own
// render target, and doing that inside an offscreen pass corrupts render-target
// and viewport state. So a plane built as a Reflector shows up in the viewport
// and is ABSENT from every captured frame, which is what data collection and
// any vision policy actually consume. The symptom is objects floating over the
// background, and nothing errors.
//
// A source guard rather than a rendered one: building the scene graph needs a
// WebGL context, and test/three-stub.mjs deliberately implements only the
// handful of three.js classes the other tests touch. This at least fails loudly
// if the Reflector is ever reintroduced for geom type 0.
console.log('\nground planes are plain meshes, not Reflectors');
{
  const src = fs.readFileSync(path.join(root, 'examples', 'mujocoUtils.js'), 'utf8');
  if (/new\s+Reflector\s*\(/.test(src)) {
    bad('mujocoUtils.js constructs a Reflector; captures will not contain it');
  } else {
    ok('no Reflector is constructed for geom type 0');
  }
  if (/from\s+'\.\/utils\/Reflector\.js'/.test(src)) {
    bad('mujocoUtils.js still imports Reflector');
  } else {
    ok('the Reflector import is gone');
  }
}

console.log('\nthe Python prelude must contain no raw backticks');
{
  const src = fs.readFileSync(path.join(root, 'examples', 'pythonIntegration.js'), 'utf8');
  let index = 0;
  let checked = 0;
  while ((index = src.indexOf('runPythonAsync(', index)) >= 0) {
    const open = src.indexOf('`', index);
    if (open < 0) break;
    let i = open + 1;
    let raw = 0;
    for (; i < src.length; i++) {
      if (src[i] === '\\') { i++; continue; }        // escaped: fine
      if (src[i] === '`') { raw++; break; }          // the terminator
    }
    checked++;
    if (raw === 1) ok(`prelude block ${checked} is terminated by its own backtick`);
    else bad(`prelude block ${checked} is not properly terminated`);
    index = i + 1;
  }
  if (!checked) bad('found no runPythonAsync template literals to check');
}

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
