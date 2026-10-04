# Python API startup regression (2026-10-04)

Confirmed on demo.robospace.app, version 54: Pyodide raised SyntaxError at
prelude line 731 before defining any API functions. The two newline escapes in
`_mw_resolve` were cooked by JavaScript into literal newlines inside Python
single-quoted strings. All examples consequently raised NameError, irrespective
of robot selection or browser cache.

The fix doubles both escapes, propagates initialization failures to the startup
handler, displays the error in the console, disables Run on startup failure, and
marks Python ready only after successful API initialization. Version is now 55.
`test:prelude` now compiles the JavaScript-cooked string, and `test:syntax` invokes
it. The repaired check failed on the original source and passed on the fix.

Browser verified locally with UR5e: What is loaded, Make it move, and High-level
Robot API all complete unchanged. UR5e has no gripper, so the high-level example
prints its existing gripper guidance. This verification establishes API startup
and script completion, not end-effector positioning accuracy or playback quality.

Deployment: push this fix to main, which publishes the live GitHub Pages demo.
Confirm the deployed index loads main.js?v=55 and rerun the three examples.
