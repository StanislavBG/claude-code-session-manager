---
id: performance/db-query-plan-review
title: Database query plan review
category: Performance
sendMode: paste
description: Runs EXPLAIN ANALYZE on hot-path queries; flags missing indexes, N+1, and over-fetching.
---
Find every SQL query or ORM call on the hot path I describe: [path]. For each, run `EXPLAIN ANALYZE` (or the ORM equivalent) and report: rows scanned vs rows returned, missing indexes (sequential scans on large tables), N+1 patterns where one query in a loop should be a single join or batched lookup, and queries returning more columns than the caller uses. Output as a table sorted by estimated cost.
