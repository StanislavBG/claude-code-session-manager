---
id: git-pr/release-notes-block
title: Generate a release-notes block from commits
category: Git / PR
sendMode: auto-fire
description: Groups commits since last tag by Conventional Commits type; rewrites subjects in user-facing past tense.
---
Read `git log` since the previous tag. Group commits by Conventional-Commits type into sections: Features (feat), Fixes (fix), Performance (perf), Refactors (refactor), Docs (docs), Tests (test), Build/CI (build, ci, chore). One bullet per commit, rewritten from imperative-mood subject into past-tense user-facing language. Surface BREAKING CHANGES at the top in a dedicated section. Only emit emojis if the project's previous releases used them — otherwise plain section headers.
