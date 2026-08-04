// examples/utils/safePath.js
//
// Guards for the highest-consequence untrusted input in the project: scene names and
// file paths, which are used to build MEMFS paths that get rmrf'd and written. A name
// that escapes its directory turns a scene write into a delete of whatever is above it.
//
// These lived in sceneWriter.js, which re-exports them so existing importers and the
// 52 assertions in test/scene-writer-inputs.test.mjs are unaffected. They moved here
// because ParentBridge.applySnapshot needs them too, and sceneWriter pulls in
// robotPacks → robotManifests, which a plain project load has no reason to download.
// This module has no imports at all, so it is free to depend on from anywhere.

const SAFE_SCENE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A scene name must be a single, ordinary directory name.
 *
 * The earlier check only rejected unexpected *characters*, which let "." and ".."
 * through — both are made entirely of allowed characters. `custom_scenes/..`
 * resolves to `custom_scenes`'s parent, and `custom_scenes/.` to the directory
 * holding every other saved scene, so either one aimed the rmrf at the wrong tree.
 * Reject path semantics, not just characters.
 */
export function assertSafeSceneName(sceneName) {
  if (typeof sceneName !== 'string' || !sceneName) {
    throw new Error('sceneName is required.');
  }
  if (sceneName.length > 64) {
    throw new Error(`sceneName "${sceneName.slice(0, 32)}…" is too long (max 64 characters).`);
  }
  if (!SAFE_SCENE_NAME.test(sceneName) || sceneName.includes('..')) {
    throw new Error(
      `Invalid sceneName "${sceneName}": must start with a letter or digit and contain only `
      + 'letters, digits, dot, dash or underscore. It is a single directory name, not a path.',
    );
  }
}

/**
 * Normalises a model-supplied file path to something guaranteed to stay inside the
 * scene directory. Rejects absolute paths, backslashes, and any "." or ".." segment
 * rather than pattern-matching on substrings — `a/../../b` contains no leading ".."
 * but still escapes.
 */
export function safeRelativePath(input) {
  const raw = String(input ?? '');
  if (!raw) throw new Error('File entry is missing a path.');
  if (raw.includes('\\')) {
    throw new Error(`Invalid file path "${raw}": use forward slashes.`);
  }
  if (raw.startsWith('/')) {
    throw new Error(`Invalid file path "${raw}": must be relative to the scene directory.`);
  }
  const segments = raw.split('/').filter((s) => s !== '');
  if (!segments.length) throw new Error(`Invalid file path "${raw}".`);
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new Error(`Refusing to write outside the scene directory: "${raw}".`);
    }
  }
  return segments.join('/');
}

/**
 * Resolves a caller-supplied entryXmlPath to a path inside this scene's directory.
 *
 * Callers legitimately pass any of three forms — "scene.xml",
 * "custom_scenes/<name>/scene.xml" (what a previous call returned), or the full
 * "/working/custom_scenes/<name>/scene.xml" — so all three are accepted by
 * trimming a recognised prefix and validating what remains.
 *
 * Note what is deliberately NOT done: a leading slash is not stripped in general.
 * An earlier version did, which defeated safeRelativePath's absolute-path check —
 * "/working/universal_robots_ur5e/scene.xml" was silently re-rooted to
 * "custom_scenes/<name>/working/universal_robots_ur5e/scene.xml" instead of being
 * refused. Confined, but wrong: it turns a caller mistake into a confusing
 * "entry file was not written" failure later. Only a prefix that actually names
 * this scene's directory is removed; anything else absolute is rejected.
 *
 * Exported so the tests exercise this function rather than a reimplementation of
 * it — the duplicate is how the bug above went unnoticed.
 */
export function resolveEntryXmlPath(entryXmlPath, sceneDir) {
  const raw = String(entryXmlPath ?? '');
  if (!raw) throw new Error('entryXmlPath is empty.');
  for (const prefix of [`${sceneDir}/`, `/${sceneDir}/`, `/working/${sceneDir}/`]) {
    if (raw.startsWith(prefix)) {
      return `${sceneDir}/${safeRelativePath(raw.slice(prefix.length))}`;
    }
  }
  return `${sceneDir}/${safeRelativePath(raw)}`;
}

/**
 * Splits a snapshot's entryXmlPath into a validated `custom_scenes/<name>` directory.
 *
 * This is the guard applySnapshot was missing. It derived the directory with
 * `split('/').slice(0, 2)` behind nothing but a `startsWith('custom_scenes/')` check,
 * so an entryXmlPath of `custom_scenes/../evil.xml` produced the directory
 * `custom_scenes/..` — and the recursive delete that follows then pointed at the
 * parent of every saved scene, i.e. all of /working.
 *
 * @returns {string|null} `custom_scenes/<name>`, or null when the path is not a
 *   custom scene at all (a built-in scene, which needs no directory).
 */
export function snapshotSceneDir(entryXmlPath) {
  const raw = String(entryXmlPath ?? '');
  if (!raw.startsWith('custom_scenes/')) return null;
  const segments = raw.split('/');
  if (segments.length < 3) {
    throw new Error(`Invalid snapshot entryXmlPath "${raw}": expected custom_scenes/<name>/<file>.`);
  }
  assertSafeSceneName(segments[1]);
  return `custom_scenes/${segments[1]}`;
}
