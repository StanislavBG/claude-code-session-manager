---
id: qa/tdd-red-first
title: TDD this feature, RED first
category: QA
sendMode: paste
description: Forces the RED-GREEN-REFACTOR loop; stops after a confirmed failing test before any implementation.
---
Engage the `test-driven-development` skill. We are adding the following feature: [describe behavior here]. Start in RED: write the smallest failing test that captures one observable behavior, run it, confirm it fails for the right reason (assertion failure, not setup error), and stop. Do not write implementation. Once I confirm RED, you will write the minimum implementation to reach GREEN, then refactor with the test still green. Never skip RED.
