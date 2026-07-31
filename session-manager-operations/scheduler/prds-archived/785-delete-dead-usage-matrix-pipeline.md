---
title: Delete the dead usage-matrix pipeline (main + renderer store)
cwd: ~/Projects/session-manager
estimateMinutes: 10
---

# Goal

Chain link after PRD 784, which removed the Usage tab — the last consumer of the usage-matrix snapshot (TopologyHeader/SessionMatrix/AlertsStrip). Delete the now-dead pipeline end to end: renderer store, main-process module, IPC registration, preload exposure, and any transcripts.cjs feed coupling.

# Acceptance criteria

- [ ] Confirm first that `src/renderer/state/usageMatrix.ts` has zero surviving importers (`grep -rn "usageMatrix" src/renderer`); then delete it. If a live importer remains, KEEP and report why instead of forcing it.
- [ ] Deleted `src/main/usageMatrix.cjs`; removed its require + IPC/broadcast registration from `src/main/index.cjs`, and any hook in `src/main/transcripts.cjs` that exists ONLY to feed the matrix (transcripts.cjs's own classification/ring-buffer behavior for the Terminal must be untouched — verify by reading the call site before cutting)
- [ ] Removed usage-matrix exposure from `src/preload/index.cjs` and `src/preload/api.d.ts`
- [ ] Any unit test covering the deleted modules removed; remaining suites untouched
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 600 npm run test:unit` passes
- [ ] `grep -rn "usageMatrix" src/` returns no hits

# Implementation notes

Depends on PRD 784 (Usage tab removed; UsageMeters relocated to Home fed by `state/billing.ts`). Billing (`state/billing.ts`, the `/api/oauth/usage` fetch path) is a completely separate pipeline from the usage matrix — do not touch billing.

Known pre-784 consumers of usageMatrix: `src/main/index.cjs`, `src/main/transcripts.cjs`, `src/renderer/state/usageMatrix.ts`, `src/renderer/components/tabs/Usage.tsx` (deleted in 784). The `totalSubagentsActive/Spawned` counters live inside `usageMatrix.cjs` itself and die with it — that's fine; `state/live.ts` per-tab agent tracking is a different pipeline and stays.

# Out of scope

- Anything billing-related (state/billing.ts, AlmanacFooter pill, UsageMeters)
- Subagents-chain work (PRDs 781-783)

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).
