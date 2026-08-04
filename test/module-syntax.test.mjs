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

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };

const root = path.join(import.meta.dirname, '..');

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
