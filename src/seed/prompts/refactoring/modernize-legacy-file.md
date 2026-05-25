---
id: refactoring/modernize-legacy-file
title: Modernize a legacy file without changing behavior
category: Refactoring
sendMode: paste
description: callbacks→async/await, var→const, magic numbers, narrowed types — observable behavior unchanged.
---
Refactor this file to current project conventions: [file path]. Constraints: do NOT change observable behavior, do NOT change the public API, do NOT change the test assertions. You MAY: replace callbacks with async/await, replace `var` with `const`/`let`, replace string concatenation with template literals, extract magic numbers, narrow types, replace try/catch with explicit error returns where the project does that elsewhere. After each commit, run the full test suite and confirm green before continuing.
