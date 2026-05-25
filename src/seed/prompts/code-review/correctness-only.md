---
id: code-review/correctness-only
title: Review staged diff for correctness bugs only
category: Code Review
sendMode: auto-fire
description: Logic errors, race conditions, missing awaits, swallowed errors — no style or naming nits.
---
Invoke the `code-reviewer` subagent on the staged diff. Find correctness bugs only — logic errors, null dereferences, race conditions, off-by-one, missing await, swallowed errors, wrong operator, wrong sign, leaked resources. Ignore formatting, style, and naming. For each finding output `file:line — one-sentence description — suggested patch (≤ 5 lines)`. Be conservative: only report issues you can defend with a concrete reproducer or a clear code path.
