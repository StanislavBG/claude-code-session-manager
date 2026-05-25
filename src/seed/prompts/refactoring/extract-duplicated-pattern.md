---
id: refactoring/extract-duplicated-pattern
title: Extract a duplicated pattern into one place
category: Refactoring
sendMode: paste
description: Consolidates 3+ implementations of the same idea; no speculative generality beyond current callers.
---
Three or more sites in this repo implement [pattern, e.g., "is path inside $HOME", "atomic file write", "exponential backoff retry"]. Find every implementation with grep, compare them, identify the union of behaviors needed, and consolidate to one canonical implementation in a sensible location. Migrate all callers. Keep test coverage equivalent or better. Do not introduce a generic abstraction beyond what the existing call sites need — concrete duplication is fine; speculative generality is not.
