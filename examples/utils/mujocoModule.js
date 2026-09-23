// examples/utils/mujocoModule.js
//
// The single place the MuJoCo WASM module is chosen and loaded.
//
// Everything that needs MuJoCo imports this, so switching implementations is a
// one-line change here rather than an edit to ten files — and, more to the
// point, so is switching *back*. `dist/mujoco_wasm.js` is committed and the
// whole demo depends on it; a migration without a seam is a migration you
// cannot abandon halfway.
//
// WHY MIGRATE. The vendored build is MuJoCo **3.3.2** and cannot load an
// image-file texture at all (`npm run check:textures`). It is worse than that:
// its binding also exposes `tex_rgb` as `undefined` and `light_directional` as
// an empty view, so `mujocoUtils.js`'s render path has always fallen into its
// "Texture data not available" branch. **This demo has never displayed a
// texture, procedural or otherwise.** The official `@mujoco/mujoco` package is
// **3.14.0**, loads them, and is maintained by DeepMind in lockstep with MuJoCo
// releases.
//
// What that is worth: measured on the inference board, driving one policy over
// one HTTP path and changing only what it is shown, real textures score 4/4
// while flat white scores 0/4, per-texture mean colour 0/4, and procedural
// checkers at best 3/8.
//
// SELECTING THE IMPLEMENTATION. `legacy` keeps the vendored 3.3.2 build; the
// default is the official package through `mujocoCompat.js`, which presents the
// old API surface so call sites did not all have to change at once.
//
//   MUJOCO_IMPL=legacy npm run test:metaworld        (Node)
//   ?mj=legacy                                        (browser)

const DEFAULT_IMPL = 'official';

/** `legacy` | `official`, from the env under Node or the query string in a browser. */
export function selectedImpl() {
  if (typeof process !== 'undefined' && process.env?.MUJOCO_IMPL) {
    return process.env.MUJOCO_IMPL;
  }
  if (typeof location !== 'undefined' && location.search) {
    const q = new URLSearchParams(location.search).get('mj');
    if (q) return q;
  }
  return DEFAULT_IMPL;
}

/**
 * Loads MuJoCo and returns the module, with the pre-migration API surface in
 * both cases.
 *
 * @param {{print?: Function, printErr?: Function}} [hooks] Emscripten output
 *   hooks. The legacy build needs these to recover the XML compiler's
 *   diagnostic (see `mujocoLog.js`); the official build throws a real `Error`
 *   instead, so they are only useful there for tracing.
 */
export async function loadMujocoModule(hooks = {}) {
  if (selectedImpl() === 'legacy') {
    const { default: load } = await import('../../dist/mujoco_wasm.js');
    return load(hooks);
  }
  const { default: load } = await import('./mujocoCompat.js');
  return load(hooks);
}

export default loadMujocoModule;
