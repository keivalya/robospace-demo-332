# First-session defects

Verified 2026-10-05. Cache version 58.

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

## Still open

- **Both virtual cameras are hardcoded to the Panda workbench**
  (`examples/utils/CameraViewer.js:573-598`): positions `(0.45, 1.25, 0)` and
  `(0.95, 0.65, 0)`, with no reference to `model.stat` or any bounding box. For most of
  the 70 Menagerie robots two of the three camera entries point at empty space.
- **No timeout or retry in any pack download** (`examples/utils/robotPacks.js:281-297`);
  a stalled connection hangs the `await` forever. A single dropped asset is swallowed to
  `console.warn` (`ParentBridge.js:1269-1274`), so the crawl "succeeds" and the user gets
  a misleading MJCF compile error about a missing mesh instead of "a download failed".
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

Every offline suite passes (`node --import ./test/register.mjs test/<name>.test.mjs`),
`sensors-cameras` for the first time, and `check-scene` exits 0. The P0 fix carries 5 new
assertions in `test:bridge` led by a positive control, and was mutation-checked: reverting
the one-line guard turns 2 of them red.

**None of this is browser-verified.** Every item above is visual or interactive, and every
Node suite stubs three.js. Serve with `python3 -m http.server 8000` and hard-reload
(`Cmd+Shift+R`, required after the `?v=` bump).
