---
id: debugging/git-bisect-regression
title: Bisect commits to find the regression
category: Debugging
sendMode: paste
description: Runs git bisect from known-good to HEAD, records each step, then fixes preserving original intent.
---
This used to work and now it doesn't: [describe the broken behavior]. Run `git bisect` between the last known-good commit and HEAD. For each step, check out the commit, run the minimal reproducer I provide below, and mark good/bad. Record each bisection step so the path to the offending commit is reproducible. Once isolated, read the offending commit's diff, identify the line that introduced the regression, and propose a fix that preserves the original intent of that commit.
