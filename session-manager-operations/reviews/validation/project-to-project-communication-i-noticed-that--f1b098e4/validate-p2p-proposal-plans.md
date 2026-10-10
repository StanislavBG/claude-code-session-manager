# Validation: p2p proposal plans (PRD 1804)

Base: `14869c8a` (from PRD notes). PRD files found in `…/epics/project-to-project-communication-i-noticed-that--f1b098e4/prds-archived/` (1798–1803; 1802 also has a follow-up `1802-fix-p2p-inbound-proposal-card`, lint-allowlist only).

Gates re-run (foreground, symlinked `node_modules` from the main checkout because the worktree has none; symlink removed afterwards):
- `vitest run` on crossProjectFeedback{,Routes}, mcpToolCatalog, schedulerMcpServerHelp, epicOrigin, EpicDetail, InboundProposalCard → 7 files / 212 tests passed.
- `npm run typecheck` → clean. `npm run lint` → clean (smells OK, page-stewards clean).

## p2p-structured-proposal-contract — VERIFIED
- Commit `8d9a5e80`. Validation: `src/main/lib/crossProjectFeedback.cjs:292-350` — blank motivation, empty `acceptanceCriteria`, empty `plan` only when `tag==='feature'` → 400 with field + purpose in message.
- Caps: motivation 2000, lists ≤20×≤500 non-blank, series key kebab ≤60 / title ≤120 / index int ≥1 / total 2..50 / index≤total (`:83-93`, `:322-350`).
- `source.proposal = {motivation, originAsk, plan, acceptanceCriteria, outOfScope, series}` passed to `ensureEpic` (`:488-498`); `resolveOriginAsk` (`:138-153`) single-lines, slices to 300, returns null on missing Epic/unreadable index, wrapped in try/catch.
- `composeFeedbackIntake`: folder basename + full path + "raised while working on" (`:212-229`); blocks in order series line → Why → Proposed plan (numbered) → Acceptance criteria (`- [ ]`) → Out of scope → Details (`:231-243`).
- Receipt text includes `[Part i of n — title]` (`:520-526`); audit event carries `series` (`:513`).
- Tests cover refusals, order, originAsk cases and source.proposal shape (`crossProjectFeedback.test.cjs:125-330`); passing.

## p2p-mcp-schema-proposal-fields — VERIFIED
- `scripts/scheduler-mcp-server.cjs:368-414`: properties motivation/plan/acceptanceCriteria/outOfScope/series{key,title,index,total} with descriptions; `required` = `['toCwd','fromCwd','title','motivation','acceptanceCriteria','body']`; plan description says required for `feature`; body described as supporting detail.
- `src/main/lib/mcpToolCatalog.cjs:240-258`: whenToUse leads with WHY, full plan + criteria, shared series; exampleArgs include motivation, plan, acceptanceCriteria, outOfScope, series.
- Field names identical to `crossProjectFeedback.cjs` (checked by reading both). The MCP handler forwards `{...args}` unchanged (`scheduler-mcp-server.cjs:683-700`), so the new fields reach the route.
- Catalog tests pass (in the 212).

## p2p-send-feedback-skill-plan-shape — VERIFIED
- `SKILL.md` step 3 retitled "Write the proposal for the human who must approve it", defines motivation/plan/acceptanceCriteria/outOfScope/body; old bug-report bullets moved under `body`.
- New "Multi-part requests" subsection (prefer one proposal; split only when independently approvable; shared `series {key,title,total}`, correct `index`, overall-plan paragraph in each motivation).
- Step 4 example shows all fields; step 5 says receiver sees motivation/plan/criteria and (unchanged) no reply channel. Field names match the server contract; caps quoted (2000/20/kebab ≤60/≤120/2-50) match.
- No other section removed (diff touches only steps 3–5 + keywords line).

## p2p-renderer-proposal-read-model — VERIFIED (see Important finding 1)
- `src/renderer/state/promptSessions.ts:26-45`: `InboundProposal` has exactly the stored fields; `EpicSource.proposal?`.
- `epicOrigin.ts`: `inboundFeedbackOrigin` returns `proposal` (Array.isArray via `isStringArray`; series requires `Number.isInteger` index/total) and `seriesLabel` "Part n of m · title"; hover title includes "raised while working on: …"; `inboundSeriesSiblings` filters by series key, sorts by index, `[]` without series.
- Tests in `epicOrigin.test.ts` pass.

## p2p-inbound-proposal-card — VERIFIED
- `epic-primitives.tsx` `InboundProposalCard`: null when not inbound; testids card/from/series/why/plan/criteria/out-of-scope/siblings/report present; out-of-scope hidden when empty; siblings strip only when `siblings.length > 1`, current marked; legacy fallback uses goal-section text → openingPrompt → goalText in a scrollable `whitespace-pre-wrap` block. No hooks, no interpolated Tailwind class names (only constant-string interpolation).
- `InboundProposalCard.test.tsx` passes; lint/typecheck clean.

## p2p-wire-proposal-card — VERIFIED
- `EpicDetail.tsx:616-620,1045-1049`: `isInboundProposal = status==='proposed' && inboundFeedbackOrigin(...) !== null`; card replaces `epic-seed-goal` only when timeline empty and not running; non-inbound path unchanged. Siblings derived in `useMemo` from the stable `sessions` collection (no fresh value from a selector); lint passes.
- `EpicApprovalBar.tsx:75-82`: note names sender label, `seriesLabel`, tells reviewer to read Why/Plan/Acceptance criteria above, keeps the "has not read this codebase" caveat.
- Legacy inbound (no proposal) → `InboundProposalCard` fallback → `inbound-proposal-report` shows the full goal-section report pre-approval; asserted in `EpicDetail.test.tsx` (passing).

## Cross-PRD field-name check
`motivation`, `plan`, `acceptanceCriteria`, `outOfScope`, `series{key,title,index,total}`, `originAsk` are spelled identically in `crossProjectFeedback.cjs`, `scheduler-mcp-server.cjs`, `mcpToolCatalog.cjs`, `SKILL.md`, `promptSessions.ts`, `epicOrigin.ts`. (`originAsk` is server-derived, intentionally absent from MCP schema; SKILL.md says so.)

## Findings

### Critical
- none

### Important
1. **`source.proposal` is not in the main-process EpicSource zod mirror, so renderer-driven persistence strips it.** `src/main/lib/promptSessionSchema.cjs:35-45` (`EpicSourceSchema` lacks `proposal`; zod objects strip unknown keys). Reproduced: `EpicSourceSchema.parse({producer:'cross-project-feedback', fromCwd:'/a', proposal:{…}})` → `{producer, fromCwd}`; `promptSessionsMergeActiveIndex.safeParse` output likewise drops it. Mint writes the raw `session` (so the card renders on first load), but `validated()` in `src/main/ipcSchemas.cjs` hands the *parsed* payload to `mergeActiveIndex` (`src/main/lib/activeIndexMerge.cjs:187`), so any renderer merge of that Epic (e.g. approval status change) can rewrite it without `proposal`; later reads then see a legacy Epic (series label, siblings strip, structure lost). Neither the PRDs nor their tests cover this path. Fix: add `proposal` (and a matching schema) to `EpicSourceSchema` and the `dataModelErd.ts:235` note; add a merge round-trip test. Not fixed here (validator does not edit product code).

### Minor
1. `src/renderer/state/promptSessions.ts:22-27`: the `EpicSource` doc comment now sits above `InboundProposal` instead of `EpicSource`.
2. `epic-primitives.tsx` (`InboundProposalCard`): for non-feature tags `plan` may be empty, yet the "Proposed plan" section still renders a heading with an empty `<ol>`; hide it when `plan.length === 0` as done for out-of-scope.
3. Sibling strip uses `goalText` which, for inbound Epics, is the title only (fine) — but `${index}/${proposal.series?.total ?? siblings.length}` shows the *count of found siblings* as the total if series is somehow null; unreachable today.
4. Gates ran with a temporary `node_modules` symlink to the main checkout (worktree has no install); not a product issue.
