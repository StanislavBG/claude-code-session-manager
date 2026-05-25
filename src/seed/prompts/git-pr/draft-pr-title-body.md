---
id: git-pr/draft-pr-title-body
title: Draft a PR title + description from the branch
category: Git / PR
sendMode: auto-fire
description: Reads main..HEAD; produces title + summary bullets + verifiable test plan checklist + risks.
---
Run `git log main..HEAD` and `git diff main...HEAD`. Draft: (1) a Conventional-Commits-shaped PR title under 70 chars, (2) a Summary section with 2-4 bullets explaining what changed and why, (3) a Test plan section as a markdown checklist of items a reviewer can actually verify, (4) a "Risks / rollback" section if the diff touches anything load-bearing. Do not invent test coverage that does not exist — only list tests that are actually in the diff.
