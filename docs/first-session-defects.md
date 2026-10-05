# First-session defects

Verified 2026-10-05. Cache version 59.

Why this file exists: `user_analysis.html` (601 registered users, 2026-06-30) records
that **94.3% logged in once and never returned** — 567 of 601 — and that only **19.4% of
email/password signups ever verify their email** against 100% of Google signups.

The tempting reading is that signup is broken. The code says otherwise: **nothing in the
app is gated on `emailVerified`** — not a route, not a Firestore rule, not a Storage
rule — so an unverified user is blocked from nothing. Verification is a reporting
problem. What actually costs the first session is what happens once a user is inside the
editor, and that is what this round fixed.

**None of it is measurable.** The simulator ships zero analytics on any origin
(`robospace-nextjs/docs/FINDINGS.md` F1), so the "26-second average session" figure
describes the marketing site only. Everything below is justified by defect severity, not
by observed lift.

## Fixed

### The Scene dropdown permanently destroyed the user's saved script

The worst defect found, and the only one that loses data.

| Step | Where |
|---|---|
| An uncached scene routes to the bridge handler | `examples/main.js:472,479-493` |
| The handler ends with an unconditional `resetPythonScript()` | `examples/utils/ParentBridge.js:1128` |
| which calls `setCode(DEFAULT_SCRIPT)` with no options, so `silent` is false | `examples/pythonIntegration.js` |
| `setCode` writes the editor, overwrites `editorStorage`, fires `emitDirty('script')` | `examples/pythonIntegration.js` |
| the parent's `dirty` subscription schedules `triggerSave`, which persists | `robospace-nextjs/src/components/projects/ProjectEditorShell.js:191-195,219` |

For a signed-in user the default script replaced their work in the editor, in
localStorage **and in Firestore**. No confirmation, no undo.

It was intermittent, which is why it would be reported as "my code randomly disappears":
the branch at `main.js:472` is `FS.analyzePath(fullPath).exists`, so only the *first*
selection of a given robot per session took this path. MEMFS starts empty on every page
load, so it recurred every session.

`resetPythonScript` now takes `{ onlyIfUntouched }`, passed only by the automatic
caller. The two deliberate callers — the Reset menu item (`main.js:585`) and
`_handleNewProject` — are unchanged.

**`{ silent: true }` would not have fixed this.** It suppresses only the autosave,
leaving the editor wiped while Firestore still held the old script — a divergence worse
than the original bug. Refusing to overwrite user content is the fix.

### Four silent failures

- **▶ Run shipped enabled during boot** and told anyone who clicked to *"Reload the
  page"* — the one action that discards the CDN download they were waiting on. Now
  disabled and labelled "Starting…" until `pythonApiReady`, re-enabled on failure so a
  click reaches a real explanation.
- **Examples and Import did nothing in Blocks mode.** `setCode` returns early there, so
  both `main.js` call sites closed the dropdown and produced no code and no error. The
  mode is persisted, so one click on Blocks reproduced it on every later visit.
- **A blocked Blockly CDN left a blank white panel**, on every visit, with no way out
  except clearing storage: the constructor bails leaving `_blockEditor` null, but
  `setEditorMode` showed the empty host and hid both Python editors anyway.
- **The Examples menu was an unlabelled `⋯`** while the startup banner printed *"Try the
  Examples menu for runnable scripts"*, naming a control that was nowhere on screen.

Also: the prelude claimed *"only loading needs `await`"*. There are 20 coroutines, and
forgetting `await` is a silent no-op that leaves a correct-looking transcript.

### `test/sensors-cameras.test.mjs` had been red since `c386356`

8 failing assertions, which trains everyone to ignore the suite. The feature was fine —
the test encoded `8dd6730`'s gripper-POV-only contract, and `c386356` re-added two
unconditional virtual cameras. One assertion (`name.includes('Gripper POV')`) read the
machine id instead of `displayName` and **never passed at all**.

### Camera framing and download resilience (fixed 2026-10-05, cache version 59)

- **Both virtual cameras were hardcoded to the Panda workbench** — overhead 1.25 m above
  `(0.45, 0)`, front at `(0.95, 0.65, 0)` — with no reference to the model. It was wrong
  even for the default scene: the real ur5e's visible geometry centres at **x = −0.398**,
  so the overhead camera stared about 0.85 m away from the robot it was framing.

  MuJoCo computes exactly the right statistics (`mjStatistic`: `extent`, `center`), but
  **`stat_extent` and `stat_center` are unbound in this WASM build** and read back
  `undefined` — the same embind gap as `HEAPU8`, `_malloc` and `model.ptr()`. Probe
  before relying on any `model.*` field. New `examples/utils/cameraFraming.js` derives
  bounds from `geom_xpos` instead, excluding `mjGEOM_PLANE` (drawn as a hardcoded
  100×100 Reflector, so one would swamp the bounds by two orders), `mjGEOM_HFIELD`
  (draws nothing), and `geom_group >= 3` (the renderer's own visibility rule).

  Bounds are measured **once per model load, not per frame** — recomputing would make
  both views drift as the arm extends, which is worse than a view that is merely
  imperfect.

- **Pack downloads had no timeout and no retry.** A connection that *stalls* rather than
  errors left the `await` pending forever, with the status line still reading "Simulation
  Ready". New `examples/utils/fetchRetry.js` times out on **stalling, not total
  duration** — menagerie's largest single file is a 21 MB mesh, so any fixed deadline
  generous enough for that on a slow link is far too long to catch a hang. Retries skip
  definitive answers (a 404 is not retried, but still falls through to the next URL).

- **A failed asset download was swallowed** to `console.warn`, so the crawl "succeeded"
  with a mesh missing and MuJoCo then failed to compile — telling the user their model
  had an unresolvable asset reference when the actual event was a network failure.
  Failures are now collected and raised naming the files and the count.

## Still open
- **Pack downloads triggered from the Scene dropdown show no progress** standalone,
  because `ParentBridge._send` is a no-op with no parent (`:201-202`), while `sim-status`
  still reads "Simulation Ready". Mostly a standalone concern; the embedded editor does
  receive `SCENE_PROGRESS`.
- **Blocks mode has no persistence at all** (`BlockEditor.js`, no serialisation), while
  Python work is saved. Blocks are lost on reload.
- **The scene choice is never restored.** `main.js:467` writes
  `robospace_last_scene` and `initialScene.js:50-53` discards anything but the UR5e.
  **That allowlist is deliberate** — it kills a permanent-boot-failure class where a
  stale key bricked boot forever, recoverable only through devtools. Do not naively
  "restore persistence"; growing the list safely needs its own design.
- **`vla_policy` is first in `EXAMPLE_LABELS`**, so the top example in the menu can only
  fail on the public page.
- **`robotstudio_so101` loads a floorless bare-robot XML** and leaves a duplicate
  dropdown entry (`robotManifests.js:200-204`, `ParentBridge.js:1095,1114`).
- **`e` and `r` are single-keystroke destructive actions** outside `#python-ide`
  (`main.js:870-872`) with no confirmation.

## Verification

The camera and download work adds `test:framing` (22 assertions against the real
compiled ur5e, not a mock, because the bug was a set of constants that looked plausible
in isolation) and `test:fetch` (14 assertions, led by the positive control that a
*slow but progressing* download must survive — a timeout on total duration would pass
every stall assertion and still break real users on the 21 MB mesh). Both download paths
were then exercised against the real network with `test:packs` (Panda, 33 MB) and
`test:packs -- stretch_3` (73 MB, confirming the >20 MB raw-GitHub fallback).

Every offline suite passes (`node --import ./test/register.mjs test/<name>.test.mjs`),
`sensors-cameras` for the first time, and `check-scene` exits 0. The P0 fix carries 5 new
assertions in `test:bridge` led by a positive control, and was mutation-checked: reverting
the one-line guard turns 2 of them red.

**None of this is browser-verified.** Every item above is visual or interactive, and every
Node suite stubs three.js. Serve with `python3 -m http.server 8000` and hard-reload
(`Cmd+Shift+R`, required after the `?v=` bump).
