---
id: git-pr/conventional-commit
title: Write a Conventional Commit message for the staged diff
category: Git / PR
sendMode: auto-fire
description: Picks correct type + scope from the diff; rejects multi-type diffs as a signal to split.
---
Read the staged diff. Write a single Conventional Commit message with: type from {feat, fix, docs, style, refactor, perf, test, build, ci, chore}, optional scope in parens (the affected module or area), `!` before the colon if there is a breaking change, a ≤72-char subject in imperative mood, a blank line, and a body explaining the WHY (not the what — the diff shows the what). If the diff spans multiple types, that is a signal to split — tell me to split it rather than picking a wrong type.
