---
id: git-pr/pre-commit-safety-sweep
title: Pre-commit safety sweep
category: Git / PR
sendMode: auto-fire
description: Checks staged diff for secrets, debug code, commented-out blocks, unrelated changes — surface only, no auto-strip.
---
Before committing, sweep the staged diff for: secrets (API keys, tokens, passwords, `.env` content), unrelated changes that should be in a different commit, debug code (`console.log`, `print`, `debugger`, `dbg!`), commented-out code blocks, TODO/FIXME added without an issue link, and any file over ~500 lines that should be split. Report each finding with `file:line — category — action (remove / move / keep with justification)`. Do not auto-strip — surface them and let me decide.
