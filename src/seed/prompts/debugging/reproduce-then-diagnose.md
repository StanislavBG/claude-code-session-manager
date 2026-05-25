---
id: debugging/reproduce-then-diagnose
title: Reproduce-then-diagnose this bug
category: Debugging
sendMode: paste
description: Engages systematic-debugging skill — reliable repro first, then hypothesis-test, then fix.
---
Engage the `systematic-debugging` skill on this bug: [paste symptom, stack trace, or repro steps]. Phase 1: get a reliable reproduction — the bug must trigger on demand, not "sometimes." Capture the minimum input that triggers it. Phase 2: state your hypothesis in one sentence and describe the observation that would refute it. Phase 3: run the observation. Phase 4: only after the hypothesis survives, propose a fix. Do not patch code until phase 4. If three hypotheses fail, stop and re-examine your assumptions from scratch.
