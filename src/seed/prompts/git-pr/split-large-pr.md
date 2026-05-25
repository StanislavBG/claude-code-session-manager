---
id: git-pr/split-large-pr
title: Split a too-large PR into reviewable chunks
category: Git / PR
sendMode: paste
description: Proposes 2-5 sequential PRs with scope, dependencies, and the git ops to create each branch.
---
This branch is too big to review well. Read `git diff main...HEAD` and propose a split into 2-5 sequential PRs, each independently reviewable and independently shippable. For each proposed PR: title, scope (files), dependencies on prior PRs in the chain, and a one-sentence rationale. Then walk me through the actual git operations (cherry-pick or interactive-rebase plan) to create each branch. Do not execute destructive git commands — just produce the plan.
