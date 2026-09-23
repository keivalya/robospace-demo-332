// Does the Meta-World scene pack fetch from upstream and compile here?
//
// Companion to metaworld-parity.test.mjs, which proves the physics match the
// inference board given local assets. This one proves the assets arrive: it hits
// the network, so it is a separate script rather than part of the parity run.
//
//   npm run test:metaworld:pack
//
// What it guards, beyond "it downloaded":
//
//   * The pack comes from Farama-Foundation/Metaworld, not mujoco_menagerie.
//     robotPacks.js used to hard-code one repo and one commit; manifests now
//     carry their own `repo`/`commit` and the IndexedDB cache key includes the
//     repo, because two sources can both pin "master" and a cross-repo cache hit
//     would serve one project's bytes for another project's path.
//   * The three <texture file=> references in scene/basic_scene.xml are stripped.
//     This MuJoCo build cannot load an image-file texture, and the failure is a
//     compile error rather than a missing texture.
//   * The compiled model matches the board's dimensions exactly. If upstream
//     moves and a mesh silently drops out, ngeom changes and this catches it.
import { loadMujocoModule as load_mujoco } from '../examples/utils/mujocoModule.js';
import { mujocoLogHooks } from '../examples/utils/mujocoLog.js';
import { compileModel, readNames } from '../examples/mujocoUtils.js';
import { ensureRobotPack, ROBOT_MANIFESTS } from '../examples/utils/robotPacks.js';

const BOARD_DIMS = { nbody: 37, ngeom: 52, njnt: 10, ncam: 7,
                     nmocap: 1, neq: 1, nq: 10, nv: 10, nu: 2 };

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const mujoco = await load_mujoco(mujocoLogHooks);
mujoco.FS.mkdir('/working');
const sceneDir = 'metaworld';
mujoco.FS.mkdir(`/working/${sceneDir}`);

const manifest = ROBOT_MANIFESTS.metaworld_drawer;
check('metaworld_drawer is registered', !!manifest);
if (!manifest) process.exit(1);
console.log(`  manifest: ${manifest.files.length} files, ` +
            `${(manifest.totalBytes / 1e6).toFixed(2)} MB, from ${manifest.repo}`);

const t0 = Date.now();
let res;
try {
  res = await ensureRobotPack(mujoco, 'metaworld_drawer', sceneDir, {
    // Bypass IndexedDB so the test exercises the real fetch path every run.
    cache: { async get() { return null; }, async set() {} },
  });
} catch (e) {
  check('fetch from upstream', false, String(e.message || e).slice(0, 200));
  process.exit(1);
}
check('fetch from upstream', true, `${((Date.now() - t0) / 1000).toFixed(1)}s`);

const stripped = (res.patched || []).find((p) => p.path === 'scene/basic_scene.xml');
check('the 3 image textures are stripped from basic_scene.xml',
      !!stripped && /removed 3 image-file texture/.test(stripped.notes.join(' ')),
      stripped ? stripped.notes.join('; ') : 'basic_scene.xml was not patched');

let model;
try {
  model = compileModel(mujoco, `/working/${sceneDir}/${res.entry}`);
  check(`compile ${res.entry}`, true);
} catch (e) {
  check(`compile ${res.entry}`, false, String(e.message || e).slice(0, 300));
  process.exit(1);
}

const bad = Object.entries(BOARD_DIMS).filter(([k, v]) => model[k] !== v);
check('model dimensions match the inference board', bad.length === 0,
      bad.map(([k, v]) => `${k}=${model[k]} want ${v}`).join(' '));

const cams = readNames(model, model.name_camadr, model.ncam, 'cam');
const bodies = readNames(model, model.name_bodyadr, model.nbody, 'body');
check('corner4 camera present (the view the checkpoint was trained on)',
      cams.includes('corner4'));
check('mocap-control bodies present',
      ['hand', 'rightclaw', 'leftclaw', 'mocap'].every((b) => bodies.includes(b)));
check('both task sentences carried on the manifest',
      Array.isArray(manifest.tasks) && manifest.tasks.length === 2,
      (manifest.tasks || []).map((t) => `${t.id}:"${t.text}"`).join('  '));

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
