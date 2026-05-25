---
id: performance/cpu-profile-hot-path
title: Find the real hot path with a CPU profile
category: Performance
sendMode: paste
description: Runs a sampling profiler, builds a flame graph, lists top 5 self-time + top 5 inclusive-time functions.
---
Hand off to the `perf-profiler` subagent. Run the app under a sampling CPU profiler (`node --cpu-prof`, `0x`, or `clinic flame` depending on stack) while reproducing the slow scenario I describe: [scenario]. Produce a flame graph and report the top 5 functions by self-time and the top 5 by inclusive time. For each, cite file:line, explain why it is hot (algorithmic, I/O, serialization, etc.), and propose a fix. Do not optimize anything that is not in the top 10 — that is premature.
