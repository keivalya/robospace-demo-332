# Editor and upload reliability review

Verified 2026-10-04. Scope: demo boot, Python editor, and custom-model uploads.
Release cache version: 56. Deployment target: main (GitHub Pages).
Confirm the live page loads main.js?v=56 after the Pages workflow succeeds.

## Fixed

- **Storage-blocked startup:** `readStoredScene(localStorage)` evaluated the browser
  property before entering its try/catch. A throwing storage getter stopped boot.
  Storage access now happens inside the guard. The split-pane script also catches
  storage failures so resizing remains usable.
- **Editor storage failures:** unguarded reads/writes could stop editor setup,
  script execution, or the bridge dirty notification. The editor now retains the
  latest values in memory when browser storage is blocked or out of quota and
  advises the user to download their script with Save before closing the page.
- **Upload HTML injection:** XML/URDF filenames were interpolated into innerHTML.
  The required-file list now uses textContent, with a loaded/total count. No
  executable attack payload was needed to establish or test the unsafe sink.
- **Upload write confinement:** filenames used as scene directories are checked
  with assertSafeSceneName; XML includes/mesh/texture references and asset write
  destinations use safeRelativePath. Rejected paths produce upload errors.
  Main filenames must follow the same single-directory naming rules as snapshots:
  1–64 characters, start with a letter/digit, and use letters, digits, dot, dash,
  underscore without consecutive dots. Asset paths may contain subdirectories.
- **Failed upload recovery:** scene selection now changes only after compilation
  succeeds. A failed load leaves the previous robot selected and keeps the modal
  open with the error and retry instructions. New file selection clears stale
  readiness, and the same file can be selected again after correction.
- **Fallback editor visibility:** switching back from Blocks now restores the
  textarea when CodeMirror could not initialize.

## Improvement

Python errors expose a Go to error line button. It selects and scrolls to the
reported line in CodeMirror, or selects the line in the fallback textarea. Block
mode does not expose Python line navigation for generated code.

The changed startup modules and CodeEditor now inherit the entry module's cache
version so a cached older module does not mask these fixes for returning users.

## Verification

- The test-only DOM dependency is pinned to linkedom 0.18.12 to retain older
  Node compatibility; no runtime CDN or production dependency is added.
- `npm run test:editor-upload`: storage getter failure, quota failure, healthy
  persistence, literal filename rendering, required-file count, ordinary nested
  destinations, failed compilation, and successful compilation.
- `npm run test:syntax` includes the cooked Python-prelude syntax check.
- All 11 verification suites passed: syntax, editor-upload, mjmath, ik, clock,
  compile diagnostics, names, inputs, bridge, scene, and language.
- `npm audit --omit=dev --audit-level=high`: no reported production dependency
  vulnerabilities at verification time.
- Browser: NameError on line 2 displayed the navigation button; clicking it focused
  the editor and selected exactly the failing expression.
- Browser with a deliberately throwing localStorage getter: page booted, editor
  displayed its storage notice, and print_model() ran successfully.
- Browser upload handlers using in-memory File fixtures: a missing material failed
  compilation while UR5e remained selected; a corrected model then loaded and the
  dialog closed. Native file chooser automation was unavailable because the
  browser extension does not have file-URL permission; no browser setting changed.

This is a focused review, not a complete security audit. ZIP layout reconstruction,
archive resource limits, upload concurrency, and the broader application remain
outside these fixes.
