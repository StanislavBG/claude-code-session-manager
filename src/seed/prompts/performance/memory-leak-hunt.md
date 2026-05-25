---
id: performance/memory-leak-hunt
title: Memory leak hunt
category: Performance
sendMode: paste
description: Snapshot-diffs after 100 iterations to find retained-size growers; pins fix with a regression test.
---
Run the app, take a heap snapshot, exercise the suspected leak path 100 times, take a second snapshot, diff them. Report retained-size growers: type, count delta, top retainers in the dominator tree. For each candidate leak cite the file:line that allocates and the file:line that fails to release (missing `removeListener`, unbounded cache, closure capturing a large object, timer not cleared, etc.). Propose a fix and a regression test that snapshot-diffs over N iterations and asserts bounded growth.
