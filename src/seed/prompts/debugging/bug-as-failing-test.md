---
id: debugging/bug-as-failing-test
title: Capture this bug as a failing test
category: Debugging
sendMode: auto-fire
description: Converts a bug report into a regression test that fails today on main and passes after the fix.
---
Hand off to the `debugger` subagent. Convert this bug report into a failing test before fixing anything: [paste bug report]. The test must fail on `main` with an assertion error that mirrors the user-visible symptom, not a setup error. Place it next to existing tests for the same module. Once the test fails the right way, fix the code, watch the test go green, and leave the test committed as a regression guard.
