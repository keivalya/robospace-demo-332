#!/usr/bin/env python3
"""Check that plain-language task selection resolves the way it claims to.

`vla_metaworld('shut the drawer')` has to land on task 18 and not task 19, and
it has to DECLINE rather than guess when a sentence does not actually choose.
That logic is Python living inside a JS template literal, so nothing else in
this repo executes it -- `check-prelude.py` only proves it parses.

This lifts the real definitions out of the prelude by name and runs them, so the
assertions below are against the shipped source rather than a copy that can
drift from it.

    python3 tools/check-language-match.py
"""

from __future__ import annotations

import ast
import io
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
TARGET = HERE.parent / "examples" / "pythonIntegration.js"
MARKER = "runPythonAsync(`"

# Everything the matcher needs, and nothing that touches `window` or `js`.
WANTED = ("_METAWORLD_TASKS", "_MW_STOPWORDS", "_MW_SYNONYMS",
          "_mw_words", "metaworld_match")

CASES = (
    # paraphrases that must resolve
    ("Open a drawer", 19), ("Push and close a drawer", 18),
    ("open the drawer", 19), ("close the drawer", 18),
    ("shut the drawer", 18), ("open drawer", 19),
    ("please open the drawer", 19), ("push the drawer closed", 18),
    ("pull the drawer open", 19), ("slide the drawer out", 19),
    ("can you close the drawer", 18), ("closing the drawer", 18),
    ("OPEN A DRAWER!", 19),
    # must decline: only shared words, so it expresses no preference
    ("drawer", None), ("the drawer please", None),
    # must decline: about something else entirely
    ("do something", None), ("make coffee", None), ("", None),
)


def main() -> int:
    src = io.open(TARGET, encoding="utf-8").read()
    start = src.index(MARKER) + len(MARKER)
    body = src[start:][: src[start:].index("`")]
    tree = compile(body, "<prelude>", "exec",
                   ast.PyCF_ALLOW_TOP_LEVEL_AWAIT | ast.PyCF_ONLY_AST)

    picked, seen = [], set()
    for node in tree.body:
        name = None
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            name = node.name
        elif isinstance(node, ast.Assign) and len(node.targets) == 1 \
                and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
        if name in WANTED:
            picked.append(node)
            seen.add(name)

    missing = [w for w in WANTED if w not in seen]
    if missing:
        print(f"prelude no longer defines: {', '.join(missing)}", file=sys.stderr)
        return 1

    ns: dict = {}
    exec(compile(ast.Module(body=picked, type_ignores=[]), "<matcher>", "exec"), ns)
    match = ns["metaworld_match"]
    tasks = ns["_METAWORLD_TASKS"]

    failures = 0
    for text, want in CASES:
        got = match(text, verbose=False)
        if got != want:
            failures += 1
            print(f"  FAIL  {text!r}: expected {want}, got {got}", file=sys.stderr)

    # Every training sentence must resolve to its own id, or the paraphrase
    # layer is actively harmful.
    for tid, sentence in tasks.items():
        got = match(sentence, verbose=False)
        if got != tid:
            failures += 1
            print(f"  FAIL  canonical {sentence!r}: expected {tid}, got {got}",
                  file=sys.stderr)

    if failures:
        print(f"{failures} failure(s)", file=sys.stderr)
        return 1
    print(f"ok  {len(CASES)} phrasings + {len(tasks)} canonical sentences resolve")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
