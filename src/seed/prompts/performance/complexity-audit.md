---
id: performance/complexity-audit
title: Complexity audit on hot data structures
category: Performance
sendMode: paste
description: Flags every loop over user-scaled data with big-O analysis; proposes O(n) rewrites or justifies n.
---
Identify every loop in this module that iterates over user-scaled data (collections whose size grows with user count, request count, or document size). For each, state the time and space complexity in big-O, flag any nested loop over user-scaled data as a complexity hazard, and propose either an O(n) rewrite, an index/Map lookup, or a justification that n is provably bounded. Do not touch loops over constant-sized data (e.g., HTTP methods, weekdays).
