#!/usr/bin/env bash
# test-unit-stability.sh — PRD 1414.
#
# Runs `npm run test:unit` N times (default 3, override with STABILITY_RUNS)
# and fails if ANY test failed in ANY run — a test that's flaky under
# npm run test:unit's full-suite parallel-worker load (but passes alone) will
# not show up failing in a single run, so validators use this instead of one
# green run to decide whether a PRD's own gate can be trusted.
#
# Never runs from inside a job worktree without a scratch TMPDIR — see
# tests/README.md: test:unit can delete the worktree it's running from.
#
# Usage: STABILITY_RUNS=3 timeout 900 scripts/test-unit-stability.sh

set -u
cd "$(dirname "$0")/.."

RUNS="${STABILITY_RUNS:-3}"
FAILED_ANY=0
declare -a SUMMARY_LINES=()

for i in $(seq 1 "$RUNS"); do
  echo "=== stability run $i/$RUNS ==="
  log="$(mktemp)"
  if timeout 300 npm run test:unit > "$log" 2>&1; then
    status="PASS"
  else
    status="FAIL"
    FAILED_ANY=1
  fi
  summary="$(grep -E '^(Test Files|Tests) ' "$log" | tr '\n' ' ')"
  echo "run $i: $status  $summary"
  SUMMARY_LINES+=("run $i: $status  $summary")
  if [ "$status" = "FAIL" ]; then
    echo "--- failing tests in run $i (full log: $log) ---"
    grep -E '^ FAIL ' "$log" || echo "(could not extract individual failures — see full log: $log)"
  else
    rm -f "$log"
  fi
done

echo
echo "=== summary ==="
for line in "${SUMMARY_LINES[@]}"; do
  echo "$line"
done

if [ "$FAILED_ANY" -ne 0 ]; then
  echo "HALT: at least one run had a failing test — see per-run output above"
  exit 1
fi

echo "stable: $RUNS/$RUNS runs green"
exit 0
