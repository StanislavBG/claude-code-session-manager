---
title: Wire ChatTurn.outcome for real completed/landed assistant turns
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: psess-msaup10i-1
---
# Goal

src/renderer/state/chat.ts:47 declares `ChatTurn.outcome?: string` with the comment "Unset today (no producer populates it yet)". ChatTranscriptTurn.tsx already renders it (a small sage-colored label next to "claude · age") whenever it's present, but nothing ever sets it, so the design mock's "landed" / "PRD ready for review" style completion signal never appears in the real app. Wire a real producer.

# Acceptance criteria

- [ ] Read src/renderer/state/chat.ts in full, focusing on every `pushTurn(tabId, { ...role: 'assistant'... })` call site (at minimum the ones around line 811 and 825 seen this session) and how a chatRunner run's completion is classified today (search for where a run is detected as finished vs erroring vs needing input — chatRunner.cjs's own completion signal, and/or chat.ts's handling of the 'complete'/'error'/'needs-input' stream events).
- [ ] Decide and document (in the PRD's own implementation, as a code comment) a concrete, deterministic rule for when an assistant turn gets a non-empty `outcome`: e.g. only the FINAL assistant turn of a successfully-completed run (not every intermediate turn), with a short label derived from real signal already available (e.g. 'Landed' for a normal successful completion, or a PRD-dispatch outcome like 'Dispatched to PRD' when the turn coincides with a prd_created event) — do not invent a label with no real backing signal, and do not guess silently if the available signals are ambiguous: pick the most conservative rule that's honest about what's known (a run finished without error) rather than a rule that implies more than the data supports (e.g. don't claim 'tests passed' unless a real test-result signal exists).
- [ ] The chosen rule is implemented and the outcome label actually appears in the real app on a real completed Epic turn — verify by triggering or observing a real chat completion (or, if no live run is available for verification, by unit-testing the new logic directly against a constructed completion event) rather than only asserting the field is technically settable.
- [ ] Add unit test coverage for the new outcome-setting logic (wherever chat.ts's existing tests live — check first) covering: a normal successful completion gets the expected label, an errored run does NOT get outcome set, a mid-run/intermediate turn does NOT get outcome set.
- [ ] `npm run typecheck` passes and the relevant existing chat.ts test suite passes with no regressions.

# Implementation notes

Primary file: src/renderer/state/chat.ts (already partially read this session — has pushTurn, capturePromptSessionTurn, and the classify-the-final-message logic around lines 778-850). Rendering side (no changes needed there, already reads turn.outcome): src/renderer/components/ChatTranscriptTurn.tsx line ~554 (`{turn.outcome && <span className="font-mono ...">{turn.outcome}</span>}`). Do not touch the rendering — this PRD is entirely about the producer side in chat.ts.

# Out of scope

- Turn-card contrast fix (separate PRD)
- Diff/plan rendering (separate PRD chain)
- Anything beyond a single deterministic outcome label per completed turn — no multi-stat summary row (that's closer to the diff-rendering PRD's scope if pursued later)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
