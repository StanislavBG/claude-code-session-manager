---
id: qa/visual-regression-review
title: Visual regression baseline + diff review
category: QA
sendMode: auto-fire
description: Refreshes screenshot baselines, classifies diffs as intentional / flake / real regression.
---
Use the `playwright-visual-testing` skill. Capture or refresh `toHaveScreenshot()` baselines for the primary routes, then run the suite. For any diff, classify as: (1) intentional UI change — update baseline, (2) flake — mask the dynamic region or wait for stable font load, (3) real regression — leave failing and open an issue. Disable animations and wait for `networkidle` before capture. Do not blindly update all baselines on a diff.
