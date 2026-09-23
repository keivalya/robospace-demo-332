#!/usr/bin/env bash
# Every test in package.json, one line of verdict each.
#
# Exists for the mujoco_wasm migration: "nothing breaks" needs a baseline that
# is a file, not a memory. Run it before and after and diff the two.
#
#   bash tools/run-all-tests.sh > /tmp/before.txt
cd "$(dirname "$0")/.."
SCRIPTS=$(python3 -c "
import json
for k in json.load(open('package.json'))['scripts']:
    if k.startswith(('test','check')): print(k)")
for s in $SCRIPTS; do
  out=$(timeout 900 npm run "$s" 2>&1)
  code=$?
  # Prefer the script's own summary line; fall back to the exit code.
  verdict=$(printf '%s\n' "$out" | grep -aoE "all checks passed|[0-9]+ failure\(s\)|[0-9]+ check\(s\) failed|[0-9]+ failed|VERDICT: [a-z ]+" | tail -1)
  printf "%-22s exit=%-3s %s\n" "$s" "$code" "${verdict:-(no summary line)}"
done
