---
id: debugging/instrument-intermittent-bug
title: Instrument to make an intermittent bug reproducible
category: Debugging
sendMode: paste
description: Adds ring-buffer logging at branch points; replays the captured sequence as a deterministic test.
---
This bug happens "sometimes" and we cannot reproduce it on demand: [describe symptom]. Add lightweight instrumentation (structured logs, counters, an in-memory ring buffer of recent state transitions) at every suspected branch point. Run the app under load or in the wild until the bug triggers, then read back the captured state to identify the unique sequence that led to it. Once captured, write a deterministic test that replays that sequence. Remove the instrumentation only after the regression test exists.
