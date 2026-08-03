// Input validation for sceneWriter, which takes the highest-consequence untrusted
// input in the project: a scene name and file paths straight out of a model's tool
// call, used to build MEMFS paths that get rmrf'd and written.
//
//   npm run test:inputs
//
// The original check only rejected unexpected *characters*, so "." and ".." passed —
// both consist entirely of allowed characters. `custom_scenes/..` resolves to the
// parent of the scene directory and `custom_scenes/.` to the directory holding every
// other saved scene, which pointed the recursive delete at the wrong tree.
//
// Deliberately assertion-only: it checks that bad input is refused, and never
// exercises a destructive path to prove the point.

import { assertSafeSceneName, safeRelativePath, resolveEntryXmlPath } from '../examples/utils/sceneWriter.js';

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };

function rejects(fn, input, label) {
  try { fn(input); bad(`${label} — ACCEPTED ${JSON.stringify(input)}`); }
  catch { ok(`${label} rejected`); }
}
function accepts(fn, input, label, expected) {
  try {
    const got = fn(input);
    if (expected !== undefined && got !== expected) bad(`${label} — got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    else ok(`${label} accepted`);
  } catch (e) { bad(`${label} — rejected valid input: ${e.message}`); }
}

console.log('scene names that escape their directory');
for (const name of ['.', '..', '../..', 'a/../b', './x', '../evil', 'a..b', 'foo/bar', '/abs', 'a\\b']) {
  rejects(assertSafeSceneName, name, `sceneName ${JSON.stringify(name)}`);
}

console.log('\nother malformed scene names');
rejects(assertSafeSceneName, '', 'empty sceneName');
rejects(assertSafeSceneName, null, 'null sceneName');
rejects(assertSafeSceneName, 'a\nb', 'sceneName with a newline');
rejects(assertSafeSceneName, 'a b', 'sceneName with a space');
rejects(assertSafeSceneName, '.hidden', 'sceneName starting with a dot');
rejects(assertSafeSceneName, 'x'.repeat(65), 'over-long sceneName');

console.log('\nordinary scene names still work');
for (const name of ['kitchen', 'kitchen_01', 'my-scene', 'scene.v2', 'a', 'Warehouse3']) {
  accepts(assertSafeSceneName, name, `sceneName ${JSON.stringify(name)}`);
}

console.log('\nfile paths that escape the scene directory');
for (const p of ['../evil.xml', '../../evil.xml', 'a/../../evil.xml', './../evil.xml',
  '/working/universal_robots_ur5e/scene.xml', '..\\..\\evil.xml', 'a\\b.xml', '', null]) {
  rejects(safeRelativePath, p, `path ${JSON.stringify(p)}`);
}

console.log('\nordinary file paths still work');
accepts(safeRelativePath, 'scene.xml', 'scene.xml', 'scene.xml');
accepts(safeRelativePath, 'assets/part.obj', 'assets/part.obj', 'assets/part.obj');
accepts(safeRelativePath, 'a//b.xml', 'collapses a double slash', 'a/b.xml');
// A dot inside a segment is fine; only a whole segment of "." or ".." is a traversal.
accepts(safeRelativePath, 'my.scene.xml', 'dots inside a filename', 'my.scene.xml');

// entryXmlPath decides what gets compiled and what params.scene points at. Nothing
// passed it when this was written, but APPLY_SCENE forwards it from the agent's
// payload, so it gets the same treatment as any other model-supplied path.
//
// This calls the real resolveEntryXmlPath rather than a local copy. The first
// version of this block reimplemented the logic and drifted from it, which is
// exactly how the absolute-path bug below survived its own test.
console.log('\nentryXmlPath confinement');
const sceneDir = 'custom_scenes/kitchen';
const resolveEntry = (input) => resolveEntryXmlPath(input, sceneDir);

for (const p of ['../../evil.xml', '../other_scene/scene.xml',
  'custom_scenes/kitchen/../../evil.xml', 'custom_scenes/other/scene.xml/../../evil.xml']) {
  rejects(resolveEntry, p, `entryXmlPath ${JSON.stringify(p)}`);
}
// An absolute path that is not this scene's directory must be refused outright,
// not silently re-rooted underneath it.
rejects(resolveEntry, '/working/universal_robots_ur5e/scene.xml', 'absolute path outside the scene');
rejects(resolveEntry, '/etc/passwd', 'absolute path, unrelated');
rejects(resolveEntry, '', 'empty entryXmlPath');

// The three forms a caller may reasonably pass.
accepts(resolveEntry, 'scene.xml', 'bare filename', 'custom_scenes/kitchen/scene.xml');
accepts(resolveEntry, 'custom_scenes/kitchen/scene.xml', 'scene-dir-prefixed', 'custom_scenes/kitchen/scene.xml');
accepts(resolveEntry, '/working/custom_scenes/kitchen/scene.xml', 'full MEMFS path', 'custom_scenes/kitchen/scene.xml');
accepts(resolveEntry, 'nested/scene.xml', 'nested filename', 'custom_scenes/kitchen/nested/scene.xml');
// A directory whose name merely starts with this scene's name must not be treated
// as a prefix match.
rejects(resolveEntry, 'custom_scenes/kitchen_other/../evil.xml', 'lookalike sibling directory');

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
