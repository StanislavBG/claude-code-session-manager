---
id: refactoring/dead-code-sweep
title: Dead code sweep
category: Refactoring
sendMode: auto-fire
description: Audits for unused exports/files/deps; verifies absence of dynamic references before proposing deletes.
---
Audit the repo for unused exports, unused functions, unused files, unused dependencies, and unreachable branches. Use static analysis (`ts-prune`, `knip`, `depcheck`, or grep + import-graph). For each finding cite file:line and confirm it is genuinely unused by checking for: dynamic imports, string-based references, framework-magic auto-discovery, and re-exports through barrel files. Output a delete-list, then on my go-ahead remove them in a single commit titled `chore: remove dead code`.
