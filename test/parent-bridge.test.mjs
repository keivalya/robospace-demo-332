// The agent's tool surface: APPLY_SCENE / READ_SCENE, and snapshot schema v2.
//
//   npm run test:bridge
//
// This drives the real ParentBridge through real postMessage envelopes — the
// handlers are reached by delivering a message to the listener the constructor
// registered, not by calling them directly, so the dispatch, origin lock-in and
// reply-id plumbing are all under test.
//
// What is faked and why:
//   • MEMFS and the demo — stand-ins for Emscripten and three.js, not for logic
//     that lives in this repo.
//   • robotPacks.ensureRobotPack, in the two tests that need a pack — the real
//     one fetches 33-73 MB from a CDN. The real pack path is covered by
//     `npm run test:packs`, and the real compile path by `npm run test:scene`.
// Everywhere else the real sceneWriter runs, so path confinement, the entry-file
// check and compile-error propagation are exercised as shipped.
//
// Rendering is not covered here and cannot be: check APPLY_SCENE by hand with
// `await robospaceLoadRobot('stretch_3')`, which goes through the same
// writeGeneratedScene call.

// ─── browser stubs, installed before ParentBridge is imported ───────────────

const PARENT_ORIGIN = 'https://app.robospace.app';
const messageListeners = new Set();
let sent = [];

globalThis.window = {
  // `hostname` gates the dev-origin allowlist and `search` carries the bridge nonce,
  // so both are read by ParentBridge and both are mutated by the tests below.
  location: { search: '', origin: 'https://demo.robospace.app', hostname: 'localhost' },
  addEventListener: (type, fn) => { if (type === 'message') messageListeners.add(fn); },
  removeEventListener: (type, fn) => messageListeners.delete(fn),
  parent: { postMessage: (msg, origin) => sent.push({ msg, origin }) },
};
globalThis.document = { getElementById: () => null };

const { ParentBridge } = await import('../examples/utils/ParentBridge.js');
const realSceneWriter = await import('../examples/utils/sceneWriter.js');

// ─── assertions ─────────────────────────────────────────────────────────────

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));
const eq = (got, want, m) => check(
  JSON.stringify(got) === JSON.stringify(want),
  `${m}${JSON.stringify(got) === JSON.stringify(want) ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`,
);

// ─── fake MEMFS ─────────────────────────────────────────────────────────────
// Enough of the Emscripten FS surface for ParentBridge and sceneWriter.

function createFakeFS() {
  const files = new Map();
  const dirs = new Set(['/', '/working']);
  return {
    files,
    dirs,
    analyzePath: (p) => ({ exists: files.has(p) || dirs.has(p) }),
    mkdir: (p) => { dirs.add(p); },
    rmdir: (p) => { dirs.delete(p); },
    unlink: (p) => { files.delete(p); },
    writeFile: (p, data) => {
      files.set(p, typeof data === 'string' ? new TextEncoder().encode(data) : data);
    },
    readFile: (p, opts) => {
      const bytes = files.get(p);
      if (!bytes) throw new Error(`ENOENT: ${p}`);
      return opts?.encoding === 'utf8' ? new TextDecoder().decode(bytes) : bytes;
    },
    readdir: (p) => {
      const prefix = p.endsWith('/') ? p : `${p}/`;
      const names = new Set(['.', '..']);
      for (const key of [...files.keys(), ...dirs]) {
        if (!key.startsWith(prefix) || key === p) continue;
        names.add(key.slice(prefix.length).split('/')[0]);
      }
      return [...names];
    },
    stat: (p) => ({ mode: dirs.has(p) ? 0o040000 : 0o100000 }),
    isDir: (mode) => (mode & 0o170000) === 0o040000,
  };
}

// ─── fake model / simulation ────────────────────────────────────────────────

function fakeModel({ actuators = ['shoulder_pan', 'elbow'], joints = ['j0', 'j1'] } = {}) {
  // model.names is one packed buffer of NUL-terminated strings indexed by the
  // name_*adr tables — the layout readModelNames actually decodes.
  const bytes = [];
  const pack = (list) => list.map((name) => {
    const at = bytes.length;
    for (const b of new TextEncoder().encode(name)) bytes.push(b);
    bytes.push(0);
    return at;
  });
  const name_actuatoradr = pack(actuators);
  const name_jntadr = pack(joints);
  return {
    nq: 7, nv: 7, nu: actuators.length, nbody: 3, ngeom: 4, njnt: joints.length,
    names: new Uint8Array(bytes),
    name_actuatoradr,
    name_jntadr,
    getOptions: () => ({ timestep: 0.002 }),
  };
}

function fakeSimulation(model) {
  return {
    qpos: new Float64Array(model.nq),
    qvel: new Float64Array(model.nv),
    ctrl: new Float64Array(model.nu),
    step() {},
    forward() {},
    free() {},
  };
}

function createFakeDemo() {
  const fs = createFakeFS();
  const model = fakeModel();
  const demo = {
    mujoco: { FS: fs },
    params: { scene: 'universal_robots_ur5e/scene.xml', paused: false },
    model,
    simulation: fakeSimulation(model),
    mujoco_time: 0,
    camera: { position: { toArray: () => [1, 2, 3], fromArray() {} } },
    controls: { target: { toArray: () => [0, 0, 0], fromArray() {} }, update() {} },
    reloadScene: null,
    // test knobs
    compileError: null,
    reloadCount: 0,
  };
  // Mirrors main.js's reloadScene: the scene is captured from the argument when given
  // (callers used to pre-set params.scene and let the queued job read it later, which
  // meant an overlapping reload could load someone else's scene), and params.scene is
  // updated only once the load has actually succeeded.
  demo.reloadScene = async (sceneOverride) => {
    const scene = sceneOverride ?? demo.params.scene;
    demo.reloadCount += 1;
    if (demo.compileError) {
      // Mirrors loadSceneFromURL on failure: the model is left null.
      demo.model = null;
      demo.simulation = null;
      const err = new Error(demo.compileError.message);
      err.code = 'MJCF_COMPILE_ERROR';
      err.mujocoDiagnostic = demo.compileError.diagnostic;
      throw err;
    }
    demo.model = fakeModel();
    demo.simulation = fakeSimulation(demo.model);
    demo.params.scene = scene;
  };
  return demo;
}

// ─── message plumbing ───────────────────────────────────────────────────────

let idCounter = 0;
const nextId = () => `t_${++idCounter}`;

/**
 * `source` defaults to window.parent because that is what a real browser sets for a
 * message posted by the embedder, and ParentBridge requires it: event.origin says
 * nothing about *which* window sent a message, so without the source check any other
 * frame on an allowlisted origin could impersonate the parent. Omitting it here
 * silently dropped every message and failed 43 assertions.
 */
function deliver(type, payload, { origin = PARENT_ORIGIN, id = nextId(), source = window.parent } = {}) {
  const event = { origin, source, data: { source: 'robospace', v: 1, type, id, payload } };
  for (const fn of messageListeners) fn(event);
  return id;
}

const repliesTo = (id) => sent.filter((s) => s.msg.id === id).map((s) => s.msg);
const typed = (type) => sent.filter((s) => s.msg.type === type).map((s) => s.msg);

async function waitForReply(id, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = repliesTo(id)[0];
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 2));
  }
  return null;
}

/** Fresh bridge + demo, already past the HELLO handshake. */
let lastBridge = null;
function newBridge() {
  // DIRTY is debounced by 750 ms. Without this, a previous test's pending timer
  // fires into *this* test's buffer and makes DIRTY counts nondeterministic.
  if (lastBridge?._dirtyTimer) clearTimeout(lastBridge._dirtyTimer);
  messageListeners.clear();
  sent = [];
  const demo = createFakeDemo();
  const bridge = new ParentBridge(demo);
  deliver('HELLO', { parentOrigin: PARENT_ORIGIN, protocolVersion: 1 });
  lastBridge = bridge;
  return { bridge, demo };
}

const SCENE_XML = '<mujoco model="t"><worldbody><geom type="box" size="1 1 1"/></worldbody></mujoco>';

// ════════════════════════════════════════════════════════════════════════════

console.log('handshake');
{
  const { bridge } = newBridge();
  check(typed('READY').length === 1, 'HELLO from an allowed origin gets READY');
  check(bridge.parentOrigin === PARENT_ORIGIN, 'parent origin is locked in');
  bridge.robotPack = null;
}

{
  // Origin lock-in has to cover the new messages too, not just the old ones.
  const { bridge } = newBridge();
  sent = [];
  const id = deliver('APPLY_SCENE', { sceneName: 'x', files: [{ path: 'scene.xml', content: SCENE_XML }] },
    { origin: 'https://evil.example.com' });
  await new Promise((r) => setTimeout(r, 50));
  check(repliesTo(id).length === 0, 'APPLY_SCENE from a non-locked origin is ignored');
  bridge.robotPack = null;
}

// ─── framing controls ───────────────────────────────────────────────────────
// This allowlist is the ENTIRE framing control: the demo is served from GitHub
// Pages, so it cannot send frame-ancestors and any page may embed it. Whatever gets
// past these checks can read the user's scene files and Python script out of MEMFS.

console.log('\nframing controls');
{
  // event.origin identifies an origin, not a window. Another frame or an opener on
  // an allowlisted origin must not be able to pose as our embedder.
  messageListeners.clear();
  sent = [];
  const bridge = new ParentBridge(createFakeDemo());
  deliver('HELLO', { parentOrigin: PARENT_ORIGIN }, { source: { postMessage() {} } });
  await new Promise((r) => setTimeout(r, 20));
  check(typed('READY').length === 0, 'HELLO from a window that is not window.parent is ignored');
  check(bridge.parentOrigin === null, 'and no origin gets locked in');
}

{
  // A *.vercel.app preview has an unpredictable origin, so it cannot be allowlisted
  // without a wildcard — and a wildcard is not a restriction, since anyone can deploy
  // there. The nonce lives only in the URL we were framed with, so only our real
  // embedder knows it.
  window.location.search = '?bridgeNonce=secret123';
  try {
    messageListeners.clear();
    sent = [];
    const bridge = new ParentBridge(createFakeDemo());
    deliver('HELLO', { parentOrigin: PARENT_ORIGIN });
    await new Promise((r) => setTimeout(r, 20));
    check(typed('READY').length === 0, 'HELLO without the expected nonce is rejected');
    check(bridge.parentOrigin === null, 'and the origin stays unlocked');

    deliver('HELLO', { parentOrigin: PARENT_ORIGIN, bridgeNonce: 'wrong' });
    await new Promise((r) => setTimeout(r, 20));
    check(typed('READY').length === 0, 'HELLO with the wrong nonce is rejected');

    deliver('HELLO', { parentOrigin: PARENT_ORIGIN, bridgeNonce: 'secret123' });
    await new Promise((r) => setTimeout(r, 20));
    check(typed('READY').length === 1, 'HELLO with the right nonce is accepted');
  } finally {
    window.location.search = '';
  }
}

{
  // localhost and 127.0.0.1 were live in the production allowlist.
  window.location.hostname = 'demo.robospace.app';
  try {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:8080', 'https://anyone.vercel.app']) {
      messageListeners.clear();
      sent = [];
      const bridge = new ParentBridge(createFakeDemo());
      deliver('HELLO', { parentOrigin: origin }, { origin });
      await new Promise((r) => setTimeout(r, 20));
      check(typed('READY').length === 0 && bridge.parentOrigin === null,
        `production rejects ${origin}`);
    }
    // The real parent origins must still work in production.
    messageListeners.clear();
    sent = [];
    const bridge = new ParentBridge(createFakeDemo());
    deliver('HELLO', { parentOrigin: PARENT_ORIGIN });
    await new Promise((r) => setTimeout(r, 20));
    check(typed('READY').length === 1 && bridge.parentOrigin === PARENT_ORIGIN,
      'production still accepts https://app.robospace.app');
  } finally {
    window.location.hostname = 'localhost';
  }
}

{
  // Off production, localhost must still connect or local development stops working.
  messageListeners.clear();
  sent = [];
  const bridge = new ParentBridge(createFakeDemo());
  deliver('HELLO', { parentOrigin: 'http://localhost:8001' }, { origin: 'http://localhost:8001' });
  await new Promise((r) => setTimeout(r, 20));
  check(typed('READY').length === 1, 'localhost is accepted when not the production deploy');
  check(bridge.parentOrigin === 'http://localhost:8001', 'and locks in as the counterparty');
}

console.log('\nAPPLY_SCENE — scene write');
{
  const { bridge, demo } = newBridge();
  const id = deliver('APPLY_SCENE', {
    sceneName: 'kitchen',
    files: [{ path: 'scene.xml', content: SCENE_XML }],
  });
  const reply = await waitForReply(id);
  check(reply?.type === 'SCENE_OK', 'valid scene replies SCENE_OK');
  eq(reply?.payload?.entryXmlPath, 'custom_scenes/kitchen/scene.xml', 'entryXmlPath defaults to scene.xml');
  eq(demo.params.scene, 'custom_scenes/kitchen/scene.xml', 'demo.params.scene points at the new scene');
  check(demo.mujoco.FS.files.has('/working/custom_scenes/kitchen/scene.xml'), 'scene.xml written to MEMFS');
  eq(reply?.payload?.modelStats?.nu, 2, 'modelStats carries nu');
  eq(reply?.payload?.modelStats?.actuatorNames, ['shoulder_pan', 'elbow'], 'modelStats carries actuator names');
  eq(reply?.payload?.robotPack, null, 'no robotPack reference when none was requested');
  bridge.robotPack = null;
}

{
  // The whole point of the repair loop: a compile failure must come back as a
  // reportable diagnostic, and must not leave the simulator unusable.
  const { bridge, demo } = newBridge();
  demo.compileError = { message: 'size 1 must have 3 values', diagnostic: 'Error: geom size' };
  const badId = deliver('APPLY_SCENE', {
    sceneName: 'kitchen',
    files: [{ path: 'scene.xml', content: '<mujoco/>' }],
  });
  const failure = await waitForReply(badId);
  check(failure?.type === 'ERROR', 'a broken scene replies ERROR');
  eq(failure?.payload?.code, 'MJCF_COMPILE_ERROR', 'error code is MJCF_COMPILE_ERROR');
  check(/size 1 must have 3 values/.test(failure?.payload?.message || ''), 'MuJoCo message reaches the parent');
  eq(failure?.payload?.mujocoDiagnostic, 'Error: geom size', 'raw diagnostic is forwarded');
  eq(failure?.payload?.recoverable, true, 'compile failures are marked recoverable');
  check(typed('DIRTY').length === 0, 'a failed apply does not mark the project dirty');

  demo.compileError = null;
  const goodId = deliver('APPLY_SCENE', {
    sceneName: 'kitchen',
    files: [{ path: 'scene.xml', content: SCENE_XML }],
  });
  const repaired = await waitForReply(goodId);
  check(repaired?.type === 'SCENE_OK', 'the next apply after a failure still succeeds (repair loop survives)');
  bridge.robotPack = null;
}

{
  // Untrusted paths are sceneWriter's job; what is asserted here is that the
  // bridge turns the refusal into an ERROR reply instead of an unhandled throw.
  const { bridge } = newBridge();
  const cases = [
    ['..', [{ path: 'scene.xml', content: SCENE_XML }], undefined, 'sceneName ".."'],
    ['ok', [{ path: '../../evil.xml', content: 'x' }], undefined, 'file path escaping the scene dir'],
    ['ok', [{ path: 'scene.xml', content: SCENE_XML }], '/etc/passwd', 'absolute entryXmlPath'],
    ['ok', [{ path: 'scene.xml', content: SCENE_XML }], 'nope.xml', 'entryXmlPath that was never written'],
  ];
  for (const [sceneName, files, entryXmlPath, label] of cases) {
    const id = deliver('APPLY_SCENE', { sceneName, files, entryXmlPath });
    const reply = await waitForReply(id);
    check(reply?.type === 'ERROR', `${label} → ERROR`);
    eq(reply?.payload?.code, 'APPLY_SCENE_FAILED', `${label} → APPLY_SCENE_FAILED`);
  }
  bridge.robotPack = null;
}

{
  const { bridge } = newBridge();
  const id = deliver('APPLY_SCENE', {});
  const reply = await waitForReply(id);
  check(reply?.type === 'ERROR', 'APPLY_SCENE with neither files nor script → ERROR');
  bridge.robotPack = null;
}

console.log('\nAPPLY_SCENE — script only');
{
  const { bridge, demo } = newBridge();
  let written = null;
  window.setPythonScript = (s) => { written = s; };
  const before = demo.reloadCount;
  const id = deliver('APPLY_SCENE', { script: 'print("hi")' });
  const reply = await waitForReply(id);
  check(reply?.type === 'SCENE_OK', 'script-only apply replies SCENE_OK');
  eq(reply?.payload?.scriptOnly, true, 'reply is flagged scriptOnly');
  eq(written, 'print("hi")', 'script reaches the Python editor');
  eq(demo.reloadCount, before, 'script-only apply does not recompile');
  check(reply?.payload?.modelStats?.nu === 2, 'script-only reply still reports modelStats');
  delete window.setPythonScript;
  bridge.robotPack = null;
}

{
  const { bridge } = newBridge();
  delete window.setPythonScript;
  const id = deliver('APPLY_SCENE', { script: 'x = 1' });
  const reply = await waitForReply(id);
  check(reply?.type === 'ERROR', 'script-only apply fails loudly when the editor is not ready');
  bridge.robotPack = null;
}

console.log('\nREAD_SCENE');
{
  const { bridge } = newBridge();
  const applyId = deliver('APPLY_SCENE', {
    sceneName: 'kitchen',
    files: [{ path: 'scene.xml', content: SCENE_XML }, { path: 'notes.txt', content: 'hello' }],
  });
  await waitForReply(applyId);

  const id = deliver('READ_SCENE', {});
  const reply = await waitForReply(id);
  check(reply?.type === 'SCENE_TEXT', 'READ_SCENE replies SCENE_TEXT');
  eq(reply?.payload?.content, SCENE_XML, 'READ_SCENE returns the scene XML verbatim');
  eq(reply?.payload?.entryXmlPath, 'custom_scenes/kitchen/scene.xml', 'READ_SCENE reports the entry path');
  eq([...(reply?.payload?.files || [])].sort(), ['notes.txt', 'scene.xml'], 'READ_SCENE lists generated files');

  // Pack files belong to the robot, not the agent; they must not be listed.
  bridge.robotPack = { id: 'stretch_3', commit: 'deadbeef', sceneDir: 'custom_scenes/kitchen', paths: ['notes.txt'] };
  const id2 = deliver('READ_SCENE', {});
  const reply2 = await waitForReply(id2);
  eq(reply2?.payload?.files, ['scene.xml'], 'READ_SCENE excludes robot-pack files');
  bridge.robotPack = null;
}

{
  const { bridge, demo } = newBridge();
  demo.params.scene = 'custom_scenes/gone/scene.xml';
  const id = deliver('READ_SCENE', {});
  const reply = await waitForReply(id);
  check(reply?.type === 'ERROR', 'READ_SCENE on a missing file replies ERROR');
  eq(reply?.payload?.code, 'READ_SCENE_FAILED', 'error code is READ_SCENE_FAILED');
  bridge.robotPack = null;
}

console.log('\nSCENE_PROGRESS');
{
  // Regression guard. simBridge resolves any inbound message whose id matches a
  // pending request, so a progress message echoing the request id would settle
  // the APPLY_SCENE promise early with a progress payload.
  const { bridge, demo } = newBridge();
  bridge._agentModulesPromise = Promise.resolve({
    robotPacks: { MENAGERIE_COMMIT: 'c0ffee', ensureRobotPack: async () => ({}) },
    sceneWriter: {
      ...realSceneWriter,
      writeGeneratedScene: async (d, spec) => {
        for (let i = 1; i <= 3; i++) {
          spec.onProgress({ done: i, total: 3, bytes: i * 10, totalBytes: 30, path: `a${i}.obj` });
        }
        d.params.scene = 'custom_scenes/kitchen/scene.xml';
        return {
          entryXmlPath: 'custom_scenes/kitchen/scene.xml',
          sceneDir: 'custom_scenes/kitchen',
          modelStats: realSceneWriter.readModelStats(d.model),
          patched: [], homePose: null, settled: { steps: 0, seconds: 0, atRest: true },
          robotPack: spec.robotPack, packPaths: ['stretch.xml', 'assets/base.obj'],
        };
      },
    },
  });

  const id = deliver('APPLY_SCENE', {
    sceneName: 'kitchen', robotPack: 'stretch_3',
    files: [{ path: 'scene.xml', content: SCENE_XML }],
  });
  const reply = await waitForReply(id);
  const progress = typed('SCENE_PROGRESS');
  check(progress.length > 0, 'progress is reported during a pack fetch');
  check(progress.every((m) => m.id !== id), 'SCENE_PROGRESS never reuses the request id');
  eq(progress.map((m) => m.payload.requestId).filter((r) => r === id).length, progress.length,
    'SCENE_PROGRESS correlates via payload.requestId');
  eq(progress.at(-1)?.payload?.done, 3, 'the final file always reports, throttling notwithstanding');
  check(reply?.type === 'SCENE_OK', 'the real reply still arrives after progress');
  eq(reply?.payload?.robotPack, { id: 'stretch_3', commit: 'c0ffee' },
    'SCENE_OK carries the pack reference');
  eq(bridge.robotPack?.paths, ['stretch.xml', 'assets/base.obj'], 'bridge remembers the pack file list');
  void demo;
}

console.log('\nDIRTY');
{
  const { bridge } = newBridge();
  const id = deliver('APPLY_SCENE', {
    sceneName: 'kitchen', files: [{ path: 'scene.xml', content: SCENE_XML }],
  });
  await waitForReply(id);
  // DIRTY is debounced by 750 ms; this is what hands the result to autosave.
  await new Promise((r) => setTimeout(r, 900));
  const dirty = typed('DIRTY');
  check(dirty.length === 1, 'a successful apply emits DIRTY for the existing autosave chain');
  eq(dirty[0]?.payload?.reason, 'agent', 'DIRTY is tagged "agent"');
  bridge.robotPack = null;
}

console.log('\nsnapshot v2 — serialize');
{
  const { bridge, demo } = newBridge();
  const FS = demo.mujoco.FS;
  demo.params.scene = 'custom_scenes/kitchen/scene.xml';
  FS.dirs.add('/working/custom_scenes');
  FS.dirs.add('/working/custom_scenes/kitchen');
  FS.dirs.add('/working/custom_scenes/kitchen/assets');
  FS.writeFile('/working/custom_scenes/kitchen/scene.xml', SCENE_XML);
  FS.writeFile('/working/custom_scenes/kitchen/stretch.xml', '<mujoco/>');
  FS.writeFile('/working/custom_scenes/kitchen/assets/base.obj', new Uint8Array([1, 2, 3]));

  const snapNoPack = bridge.serializeSnapshot();
  eq(snapNoPack.schemaVersion, 2, 'snapshots are written at schemaVersion 2');
  eq(snapNoPack.robotPack, null, 'no pack reference when no pack is active');
  eq(snapNoPack.files.length, 3, 'without a pack every file is inlined, as in v1');

  bridge.robotPack = {
    id: 'stretch_3', commit: 'abc123', sceneDir: 'custom_scenes/kitchen',
    paths: ['stretch.xml', 'assets/base.obj'],
  };
  const snap = bridge.serializeSnapshot();
  eq(snap.robotPack, { id: 'stretch_3', commit: 'abc123' }, 'the pack is stored as a reference');
  eq(snap.files.map((f) => f.path), ['custom_scenes/kitchen/scene.xml'],
    'pack files are excluded — this is what keeps the snapshot from being 73 MB');

  // Stale-reference guard: the user switched away to another scene.
  demo.params.scene = 'custom_scenes/other/scene.xml';
  FS.dirs.add('/working/custom_scenes/other');
  FS.writeFile('/working/custom_scenes/other/scene.xml', SCENE_XML);
  const other = bridge.serializeSnapshot();
  eq(other.robotPack, null, 'a pack from a different scene dir is not referenced');
  eq(other.files.length, 1, 'and its files are not excluded from the new scene');
  bridge.robotPack = null;
}

console.log('\nsingle-flight');
{
  // writeGeneratedScene starts with rmrf of the scene dir, so a second concurrent
  // apply deletes the first's files. Reject rather than queue.
  const { bridge } = newBridge();
  let release;
  const gate = new Promise((r) => { release = r; });
  bridge._agentModulesPromise = Promise.resolve({
    robotPacks: { MENAGERIE_COMMIT: 'c0ffee', ensureRobotPack: async () => ({}) },
    sceneWriter: {
      ...realSceneWriter,
      writeGeneratedScene: async (d) => {
        await gate;
        return {
          entryXmlPath: 'custom_scenes/kitchen/scene.xml', sceneDir: 'custom_scenes/kitchen',
          modelStats: realSceneWriter.readModelStats(d.model),
          patched: [], homePose: null, settled: { steps: 0, seconds: 0, atRest: true },
          robotPack: null, packPaths: [],
        };
      },
    },
  });

  const firstId = deliver('APPLY_SCENE', { sceneName: 'kitchen', files: [{ path: 'scene.xml', content: SCENE_XML }] });
  await new Promise((r) => setTimeout(r, 20));
  const secondId = deliver('APPLY_SCENE', { sceneName: 'kitchen', files: [{ path: 'scene.xml', content: SCENE_XML }] });
  const rejected = await waitForReply(secondId);
  check(rejected?.type === 'ERROR', 'a concurrent APPLY_SCENE is refused');
  eq(rejected?.payload?.code, 'SCENE_BUSY', 'refusal is tagged SCENE_BUSY, not a compile error');
  eq(rejected?.payload?.recoverable, true, 'and marked recoverable so the caller retries');

  release();
  const first = await waitForReply(firstId);
  check(first?.type === 'SCENE_OK', 'the first apply still completes');

  // The lock must clear, or one busy apply wedges the bridge forever.
  const thirdId = deliver('APPLY_SCENE', { sceneName: 'kitchen', files: [{ path: 'scene.xml', content: SCENE_XML }] });
  const third = await waitForReply(thirdId);
  check(third?.type === 'SCENE_OK', 'a later apply succeeds once the lock clears');
  bridge.robotPack = null;
}

{
  // A script-only apply touches no files, so it must not be blocked by the lock.
  const { bridge } = newBridge();
  window.setPythonScript = () => {};
  bridge._applyInFlight = true;
  const id = deliver('APPLY_SCENE', { script: 'x = 1' });
  const reply = await waitForReply(id);
  check(reply?.type === 'SCENE_OK', 'a script-only apply is not gated by the scene lock');
  delete window.setPythonScript;
  bridge._applyInFlight = false;
  bridge.robotPack = null;
}

console.log('\nsnapshot path confinement');
{
  // applySnapshot was the one MEMFS write path that bypassed sceneWriter's guards.
  const { bridge, demo } = newBridge();
  bridge._agentModulesPromise = Promise.resolve({
    sceneWriter: realSceneWriter,
    robotPacks: { MENAGERIE_COMMIT: 'abc123', ensureRobotPack: async () => ({}) },
  });

  const rejects = async (snap, label) => {
    let threw = false;
    try { await bridge.applySnapshot(snap); } catch (_) { threw = true; }
    check(threw, label);
  };

  // `custom_scenes/..` used to become the rmrf target — i.e. all of /working.
  await rejects({
    schemaVersion: 2, sceneName: 'x', entryXmlPath: 'custom_scenes/../evil.xml', files: [],
  }, 'entryXmlPath escaping via ".." is refused before anything is deleted');
  await rejects({
    schemaVersion: 2, sceneName: 'x', entryXmlPath: 'custom_scenes/./scene.xml', files: [],
  }, 'entryXmlPath with a "." segment is refused');
  await rejects({
    schemaVersion: 2, sceneName: 'x', entryXmlPath: 'custom_scenes/kitchen', files: [],
  }, 'entryXmlPath with no filename is refused');
  // files[].path stripped only leading slashes, so ".." passed straight through.
  await rejects({
    schemaVersion: 2, sceneName: 'kitchen', entryXmlPath: 'custom_scenes/kitchen/scene.xml',
    files: [{ path: 'custom_scenes/kitchen/../../evil.xml', encoding: 'utf8', content: 'x' }],
  }, 'a file path escaping the scene dir is refused');
  await rejects({
    schemaVersion: 2, sceneName: 'kitchen', entryXmlPath: 'custom_scenes/kitchen/scene.xml',
    files: [{ path: '/etc/passwd', encoding: 'utf8', content: 'x' }],
  }, 'an absolute file path is refused');

  check(!demo.mujoco.FS.files.has('/working/evil.xml'), 'nothing was written outside the scene dir');

  // And the ordinary shape still loads.
  await bridge.applySnapshot({
    schemaVersion: 2, sceneName: 'kitchen', entryXmlPath: 'custom_scenes/kitchen/scene.xml',
    files: [{ path: 'custom_scenes/kitchen/scene.xml', encoding: 'utf8', content: SCENE_XML }],
    sim: null,
  });
  check(demo.mujoco.FS.files.has('/working/custom_scenes/kitchen/scene.xml'),
    'a well-formed snapshot still applies');
  eq(demo.params.scene, 'custom_scenes/kitchen/scene.xml', 'and selects its scene');
}

{
  // LOAD_PROJECT coalesces instead of rejecting: StrictMode legitimately doubles it.
  const { bridge } = newBridge();
  let calls = 0;
  bridge._agentModulesPromise = Promise.resolve({
    sceneWriter: realSceneWriter,
    robotPacks: { MENAGERIE_COMMIT: 'abc123', ensureRobotPack: async () => ({}) },
  });
  const snap = {
    schemaVersion: 2, sceneName: 'kitchen', entryXmlPath: 'custom_scenes/kitchen/scene.xml',
    files: [{ path: 'custom_scenes/kitchen/scene.xml', encoding: 'utf8', content: SCENE_XML }],
    sim: null,
  };
  const realApply = bridge.applySnapshot.bind(bridge);
  bridge.applySnapshot = async (s) => { calls++; return realApply(s); };

  const a = deliver('LOAD_PROJECT', { projectId: 'p', snapshot: snap });
  const b = deliver('LOAD_PROJECT', { projectId: 'p', snapshot: snap });
  const [ra, rb] = [await waitForReply(a), await waitForReply(b)];
  eq(ra?.type, 'LOAD_PROJECT_OK', 'the first LOAD_PROJECT succeeds');
  eq(rb?.type, 'LOAD_PROJECT_OK', 'the concurrent duplicate also succeeds');
  eq(calls, 1, 'but the snapshot was applied only once');
  check(typed('SCENE_PROGRESS').length > 0,
    'a progress beat is emitted even on a cache hit, so the idle timeout re-arms');
}

console.log('\nsnapshot v2 — apply');
{
  // v1 snapshots predate the registry and must keep loading untouched.
  const { bridge, demo } = newBridge();
  let packCalls = 0;
  bridge._agentModulesPromise = Promise.resolve({
    sceneWriter: realSceneWriter,
    robotPacks: { MENAGERIE_COMMIT: 'abc123', ensureRobotPack: async () => { packCalls++; return {}; } },
  });

  await bridge.applySnapshot({
    schemaVersion: 1,
    sceneName: 'legacy',
    entryXmlPath: 'custom_scenes/legacy/scene.xml',
    files: [{ path: 'custom_scenes/legacy/scene.xml', encoding: 'utf8', content: SCENE_XML }],
    script: '',
    sim: null,
  });
  eq(packCalls, 0, 'a v1 snapshot never calls ensureRobotPack');
  check(demo.mujoco.FS.files.has('/working/custom_scenes/legacy/scene.xml'), 'v1 files are written');
  eq(demo.params.scene, 'custom_scenes/legacy/scene.xml', 'v1 snapshot selects its scene');
  eq(bridge.robotPack, null, 'v1 leaves no pack reference');
}

{
  const { bridge, demo } = newBridge();
  const order = [];
  let seenArgs = null;
  let homePoseApplied = null;
  bridge._agentModulesPromise = Promise.resolve({
    sceneWriter: {
      ...realSceneWriter,
      applyHomePose: (d, pose) => { homePoseApplied = pose; return true; },
    },
    robotPacks: {
      MENAGERIE_COMMIT: 'abc123',
      ensureRobotPack: async (mujoco, packId, sceneDir) => {
        order.push('pack');
        seenArgs = { packId, sceneDir };
        // The pack ships its own robot XML into the scene dir.
        mujoco.FS.writeFile(`/working/${sceneDir}/stretch.xml`, '<mujoco/>');
        return { entry: 'stretch.xml', paths: ['stretch.xml'], patched: [], homePose: { qpos: [0.5], ctrl: [] } };
      },
    },
  });

  const originalWrite = demo.mujoco.FS.writeFile;
  demo.mujoco.FS.writeFile = (p, d) => {
    if (p.endsWith('scene.xml')) order.push('files');
    return originalWrite(p, d);
  };

  await bridge.applySnapshot({
    schemaVersion: 2,
    sceneName: 'kitchen',
    entryXmlPath: 'custom_scenes/kitchen/scene.xml',
    robotPack: { id: 'stretch_3', commit: 'abc123' },
    files: [{ path: 'custom_scenes/kitchen/scene.xml', encoding: 'utf8', content: SCENE_XML }],
    script: '',
    sim: null,
  });

  eq(seenArgs, { packId: 'stretch_3', sceneDir: 'custom_scenes/kitchen' },
    'v2 re-fetches the pack into the scene dir');
  eq(order, ['pack', 'files'], 'the pack lands before files[], so a generated file wins a collision');
  eq(bridge.robotPack?.id, 'stretch_3', 'the restored pack is remembered for the next snapshot');
  eq(bridge.robotPack?.paths, ['stretch.xml'], 'and so is its file list');
  eq(homePoseApplied, { qpos: [0.5], ctrl: [] },
    'with no saved sim state the pack home pose is applied (the keyframe was stripped at fetch)');
  check(demo.mujoco.FS.files.has('/working/custom_scenes/kitchen/stretch.xml'), 'pack files are present again');
}

{
  // Saved state beats the home pose — it is where the user actually left off.
  const { bridge, demo } = newBridge();
  let homePoseApplied = null;
  bridge._agentModulesPromise = Promise.resolve({
    sceneWriter: { ...realSceneWriter, applyHomePose: (d, pose) => { homePoseApplied = pose; return true; } },
    robotPacks: {
      MENAGERIE_COMMIT: 'abc123',
      ensureRobotPack: async () => ({ entry: 'stretch.xml', paths: [], patched: [], homePose: { qpos: [0.5], ctrl: [] } }),
    },
  });

  await bridge.applySnapshot({
    schemaVersion: 2,
    sceneName: 'kitchen',
    entryXmlPath: 'custom_scenes/kitchen/scene.xml',
    robotPack: { id: 'stretch_3', commit: 'abc123' },
    files: [{ path: 'custom_scenes/kitchen/scene.xml', encoding: 'utf8', content: SCENE_XML }],
    sim: { qpos: Array(7).fill(0.25), qvel: Array(7).fill(0), ctrl: [0, 0] },
  });
  eq(homePoseApplied, null, 'saved sim state takes precedence over the home pose');
  eq(demo.simulation.qpos[0], 0.25, 'saved qpos is restored');
}

{
  // A snapshot whose state no longer fits the model used to leave the robot at
  // qpos0; now it falls back to the home pose.
  const { bridge } = newBridge();
  let homePoseApplied = null;
  bridge._agentModulesPromise = Promise.resolve({
    sceneWriter: { ...realSceneWriter, applyHomePose: (d, pose) => { homePoseApplied = pose; return true; } },
    robotPacks: {
      MENAGERIE_COMMIT: 'abc123',
      ensureRobotPack: async () => ({ entry: 'stretch.xml', paths: [], patched: [], homePose: { qpos: [0.5], ctrl: [] } }),
    },
  });

  // The size mismatch is the point of this test, so the warning it logs is
  // expected output — capture it rather than letting a stack trace print as if
  // something had gone wrong.
  const realWarn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    await bridge.applySnapshot({
      schemaVersion: 2,
      sceneName: 'kitchen',
      entryXmlPath: 'custom_scenes/kitchen/scene.xml',
      robotPack: { id: 'stretch_3', commit: 'abc123' },
      files: [{ path: 'custom_scenes/kitchen/scene.xml', encoding: 'utf8', content: SCENE_XML }],
      sim: { qpos: Array(999).fill(0.25) },   // oversized: .set() throws
    });
  } finally {
    console.warn = realWarn;
  }
  check(warned > 0, 'a mismatched saved state is reported, not swallowed');
  eq(homePoseApplied, { qpos: [0.5], ctrl: [] },
    'a mismatched saved state degrades to the home pose rather than qpos0');
}

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
