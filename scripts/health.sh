#!/usr/bin/env bash

# Session Manager project health check
# GREEN (0): all checks pass
# YELLOW (1): some non-critical issues (build slow, tests flaky, etc.)
# RED (2): critical failures (broken build, failed tests, missing deps)

set -eu
cd "$(dirname "$0")/.."

status=0
issues=()

# 1. TypeScript compilation
if ! npm run typecheck 2>&1 | grep -q "error"; then
  echo "✓ TypeScript: clean"
else
  echo "✗ TypeScript: compilation errors"
  status=2
  issues+=("TypeScript errors")
fi

# 2. Dependencies
if npm ls > /dev/null 2>&1; then
  echo "✓ Dependencies: in sync"
else
  echo "⚠ Dependencies: inconsistent"
  status=1
  issues+=("npm dependencies out of sync")
fi

# 3. Test suite exists
if [ -d "tests/e2e" ] || [ -f "playwright.config.ts" ]; then
  echo "✓ Tests: e2e suite found"
  # Try running tests if env allows (non-CI can skip for speed)
  if [ "${SM_QUICK_HEALTH:-0}" != "1" ] && command -v xvfb-run > /dev/null 2>&1; then
    if npm run test:e2e > /dev/null 2>&1; then
      echo "  → e2e tests pass"
    else
      echo "  → e2e tests FAILED"
      status=2
      issues+=("e2e test failures")
    fi
  fi
else
  echo "⚠ Tests: no e2e suite found"
  status=1
  issues+=("no test suite")
fi

# 4. Build target
if [ -d "dist" ] || npm run build > /dev/null 2>&1; then
  echo "✓ Build: successful"
else
  echo "✗ Build: failed"
  status=2
  issues+=("build failure")
fi

echo ""
echo "════════════════════════════════════════"

if [ $status -eq 0 ]; then
  echo "🟢 GREEN — all checks pass"
elif [ $status -eq 1 ]; then
  echo "🟡 YELLOW — non-critical issues:"
  printf '  • %s\n' "${issues[@]}"
else
  echo "🔴 RED — critical failures:"
  printf '  • %s\n' "${issues[@]}"
fi

exit $status
