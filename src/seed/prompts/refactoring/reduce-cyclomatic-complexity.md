---
id: refactoring/reduce-cyclomatic-complexity
title: Reduce cyclomatic complexity on a hot function
category: Refactoring
sendMode: paste
description: Early returns, guard clauses, small extractions — no new abstractions; preserves signature + tests.
---
Hand off to the `refactorer` subagent. This function has too many nested conditionals: [name file:function]. Reduce cyclomatic complexity using early returns, guard clauses, lookup tables, and small extracted helpers — no new abstractions, no design patterns unless the situation actually calls for one. Keep the public signature identical and keep the existing test assertions passing unchanged. Report before/after complexity and line count.
