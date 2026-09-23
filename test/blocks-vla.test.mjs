// Do the VLA blocks exist, reach the toolbox, and generate the Python they claim?
//
// Blockly needs a DOM, so this stubs just enough of one to run initCustomBlocks
// and capture the definitions and generators. The workspace itself is allowed to
// fail -- it needs a real canvas and is not what these assertions are about.
//
// The escaping check is the one with teeth. PROMPT is a free-text field: the
// point of the block is that you can type your own sentence at the policy, and a
// quote or a backslash in it would otherwise generate Python that does not parse.
//
//   npm run test:blocks
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve from the test file, not the cwd, so it works from anywhere.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const src = fs.readFileSync(path.join(ROOT, 'examples/utils/BlockEditor.js'), 'utf8');

const defs = [];
const gens = {};
globalThis.Blockly = {
  defineBlocksWithJsonArray: (arr) => defs.push(...arr),
  Python: { forBlock: gens },
  inject: () => ({ addChangeListener() {}, getAllBlocks: () => [] }),
};
globalThis.window = globalThis;
globalThis.document = {
  getElementById: () => ({ innerHTML: '', style: {} }),
  createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
  body: { appendChild() {} },
};
const { BlockEditor } = await import('../examples/utils/BlockEditor.js');
// initCustomBlocks is what we are testing; initWorkspace needs a real DOM and
// is allowed to fail here.
try { new BlockEditor(null, () => {}); } catch (e) { console.log(`  (workspace init skipped: ${e.message})`); }

const vla = defs.filter((d) => d.type.startsWith('robospace_vla'));
let fail = 0;
const ok = (n, c, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); if (!c) fail++; };

ok('four VLA blocks defined', vla.length === 4, vla.map((d) => d.type).join(', '));
for (const d of vla) {
  ok(`${d.type} has a tooltip and a colour`, !!d.tooltip && d.colour !== undefined);
  ok(`${d.type} has a generator`, typeof gens[d.type] === 'function');
}
// The toolbox must actually offer them, or they exist and nobody can reach them.
const toolboxHasVla = /<category name="🧠 VLA"/.test(src)
  && vla.every((d) => src.includes(`<block type="${d.type}">`));
ok('toolbox offers every VLA block', toolboxHasVla);

const field = (v) => ({ getFieldValue: (k) => v[k] });
ok('load generates the right call',
   gens['robospace_vla_load'](field({})) === 'await load_metaworld()\n');
ok('run generates the right call',
   gens['robospace_vla_run'](field({ TASK: '19' })) === 'await vla_metaworld(19)\n');
ok('selftest generates the right call',
   gens['robospace_vla_selftest'](field({})) === 'await metaworld_selftest()\n');
const custom = gens['robospace_vla_run_prompt'](field({ TASK: '19', PROMPT: 'Push and close a drawer' }));
ok('custom prompt generates the right call',
   custom === 'await vla_metaworld(19, prompt="Push and close a drawer")\n', custom.trim());
// A quote in the free-text field must not produce Python that fails to parse.
const nasty = gens['robospace_vla_run_prompt'](field({ TASK: '18', PROMPT: 'say "open" now\\' }));
ok('a quote in the prompt field is escaped', !/[^\\]"open"/.test(nasty), nasty.trim());

console.log(fail ? `\n${fail} failure(s)` : '\nall checks passed');
process.exit(fail ? 1 : 0);
