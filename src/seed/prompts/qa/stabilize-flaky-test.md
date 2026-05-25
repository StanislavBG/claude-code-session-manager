---
id: qa/stabilize-flaky-test
title: Convert a Playwright test failure into a stable fix
category: QA
sendMode: paste
description: Diagnoses a flaky test as real-bug / locator-timing / test-data-leak, then patches and re-runs 10x.
---
This Playwright test is flaky / failing: [paste test name or path]. Use the `playwright-debug` skill — pull the trace, identify whether the failure is (a) a real bug, (b) a timing/locator issue, or (c) a test-data leak from another test. For (a) write a smaller reproducer and patch the app; for (b) replace the locator with a role/label/testid locator and rely on auto-wait; for (c) isolate the test's setup/teardown. Re-run 10 times in headed mode to confirm stability.
