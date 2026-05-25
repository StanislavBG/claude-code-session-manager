---
id: code-review/full-spectrum-high
title: Full-spectrum review at high effort
category: Code Review
sendMode: auto-fire
description: Correctness + security + performance + maintainability + test coverage with merge verdict.
---
Run the `code-review` skill at effort level "high" on the current diff. Cover: correctness, security, performance, maintainability, test coverage, error handling, edge cases, and API/contract compatibility. Group findings by severity (must-fix / should-fix / nit). Cite file:line for every finding. End with a verdict: ready to merge / changes requested / needs design discussion. Do not invent issues to pad the review — if the diff is clean, say so.
