---
id: code-review/readability-naming
title: Diff readability + naming pass
category: Code Review
sendMode: paste
description: Surface-only review of names, magic numbers, lying comments, and overlong blocks.
---
Read the diff and report only on readability: unclear variable names, functions doing more than one thing, magic numbers without a named constant, comments that lie about what the code does, control flow that would benefit from early returns or guard clauses, and any block over ~30 lines that should be extracted. Propose concrete renames and extractions with a one-line justification each. Skip correctness and security — other passes cover that.
