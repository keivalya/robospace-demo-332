#!/usr/bin/env python3
"""Compile the Python prelude that lives inside pythonIntegration.js.

That prelude is ~1700 lines of Python embedded in a JS template literal, which
makes two whole classes of mistake invisible until a user runs the editor:

* A Python syntax error. `node --check` validates the JavaScript and happily
  accepts any string contents, so a bad indent or an unclosed bracket ships.
* A stray backtick or `${`, which terminates the template literal early. That
  one usually does break the JS parse, but it can also silently truncate the
  prelude instead, leaving functions simply missing.

Both have happened here. Run this before committing a change to the prelude:

    python3 tools/check-prelude.py

Top-level `await` is legal in the prelude because Pyodide runs it through
`eval_code_async`, so it is compiled with PyCF_ALLOW_TOP_LEVEL_AWAIT.
"""

from __future__ import annotations

import ast
import io
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
TARGET = HERE.parent / "examples" / "pythonIntegration.js"
MARKER = "runPythonAsync(`"


def main() -> int:
    src = io.open(TARGET, encoding="utf-8").read()

    n = src.count(MARKER)
    if n != 1:
        print(f"expected exactly one {MARKER!r}, found {n}", file=sys.stderr)
        return 1

    start = src.index(MARKER) + len(MARKER)
    rest = src[start:]
    if "`" not in rest:
        print("template literal is never closed", file=sys.stderr)
        return 1
    body = rest[: rest.index("`")]

    # `${` would be interpolated by JS rather than reaching Python.
    if "${" in body:
        line = body[: body.index("${")].count("\n") + 1
        print(f"prelude line {line}: '${{' is a JS interpolation, not Python",
              file=sys.stderr)
        return 1

    # PyCF_ONLY_AST as well, so one parse both validates and yields the tree.
    flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT | ast.PyCF_ONLY_AST
    try:
        tree = compile(body, "<prelude>", "exec", flags)
    except SyntaxError as exc:
        print(f"prelude line {exc.lineno}: {exc.msg}", file=sys.stderr)
        lines = body.split("\n")
        for i in range(max(0, (exc.lineno or 1) - 3),
                       min(len(lines), (exc.lineno or 1) + 2)):
            print(f"  {i + 1:5d} {lines[i]}", file=sys.stderr)
        return 1

    defined = {n.name for n in ast.walk(tree)
               if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    print(f"ok  {len(body)} chars, {body.count(chr(10)) + 1} lines, "
          f"{len(defined)} functions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
