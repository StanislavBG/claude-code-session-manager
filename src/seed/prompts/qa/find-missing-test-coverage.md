---
id: qa/find-missing-test-coverage
title: Find missing test coverage on the diff
category: QA
sendMode: auto-fire
description: Lists untested error paths, branches, and public APIs in the staged diff, ranked by risk.
---
Look at the staged diff. For every new or changed function, branch, and error path, check whether at least one test exercises it. List untested behaviors as a checklist with `file:line — behavior — suggested test name`. Prioritize: untested error paths and untested public API > untested branches > untested happy paths. Do not propose tests for trivial getters or for code that is purely delegating.
