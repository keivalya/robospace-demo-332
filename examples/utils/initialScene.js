// examples/utils/initialScene.js
//
// Decides which scene the page boots with. Pure and dependency-free so the boot
// path's one permanent-failure mode can actually be tested — importing main.js to
// test this would run the whole boot, top-level await and all.

export const DEFAULT_SCENE = 'universal_robots_ur5e/scene.xml';

/** Scenes that are guaranteed to exist under examples/scenes/. */
export const BUILTIN_SCENES = [DEFAULT_SCENE];

/**
 * Reads localStorage without letting it take the page down.
 *
 * `localStorage` does not return null when storage is unavailable — accessing it
 * *throws*. That happens in Safari private mode and, more importantly here, under
 * third-party storage partitioning, which is exactly how this page runs: inside a
 * cross-origin iframe on app.robospace.app. An unguarded read at module top level
 * is therefore a boot failure with a completely misleading symptom.
 */
export function readStoredScene(storage) {
  try {
    return storage.getItem('robospace_last_scene');
  } catch (_) {
    return null;
  }
}

export function forgetStoredScene(storage) {
  try {
    storage.removeItem('robospace_last_scene');
  } catch (_) { /* nothing to do; the caller is already falling back */ }
}

/**
 * Resolves a stored scene name to something that exists.
 *
 * The old check only rejected the `custom_scenes/` prefix, which covers exactly
 * one way this goes wrong. Any *other* stale value — a scene that used to be
 * bundled (`boston_dynamics_spot/scene_arm.xml` and `unitree_g1/scene.xml` are
 * still listed in a commented-out selector), a hand-edited key, a typo — reached a
 * `fetch` that failed, and the failure threw at module top level. Since nothing
 * ever rewrote or cleared the key, the page then failed to boot on *every*
 * subsequent load, forever, recoverable only through devtools.
 *
 * Validating against the known list kills the whole class instead of one instance.
 */
export function resolveInitialScene(stored, knownScenes = BUILTIN_SCENES) {
  if (typeof stored !== 'string' || !stored) return DEFAULT_SCENE;
  if (!knownScenes.includes(stored)) return DEFAULT_SCENE;
  return stored;
}
