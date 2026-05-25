---
id: code-review/ac-coverage-check
title: Pre-merge acceptance-criteria check
category: Code Review
sendMode: paste
description: Maps each AC item to the diff line that satisfies it; flags scope creep and unverified claims.
---
Engage the `requesting-code-review` skill. Compare the diff against the acceptance criteria in the PRD/issue I link below. For each AC item, mark satisfied / partial / missing, and cite the file:line in the diff that satisfies it. List any code in the diff that is NOT covered by an AC (scope creep). Flag any AC the diff claims to satisfy but does not actually exercise (e.g., feature flagged off, dead code path).
