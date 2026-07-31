---
title: promptId/sourcePromptId persistence + inline chatRunner-vs-develop classification
cwd: ~/Projects/session-manager
estimateMinutes: 20
---
# Goal

Thread the `PromptTicket.id` introduced in PRD 748 through to durable storage and to scheduler PRDs, and add the in-session classification step that decides, per ticket, whether it runs inline via chatRunner or gets dispatched to /develop for PRD decomposition. This is what makes "project-prompt-to-PRD" traceable: an exchange record and a scheduler PRD can both be traced back to the ticket that originated them.

# Acceptance criteria

- [ ] `src/main/exchanges.cjs`'s `recordExchange()` (~lines 37-62) accepts and persists an optional `promptId` field on the NDJSON record written to `~/.claude/knowledge-log/exchanges/<cwd>.jsonl`, sourced from `PromptTicket.id` when the exchange originates from a queued ticket. Do NOT backfill or synthesize IDs for existing historical records — old records simply lack the field, forward-only.
- [ ] `exchanges:list` IPC handler (`src/main/index.cjs` ~line 784) passes the `promptId` field through unchanged to the renderer.
- [ ] PRD frontmatter schema/parsing in `src/renderer/lib/prdFrontmatter.ts` (and wherever scheduler PRD files are parsed on the main-process side, e.g. `src/main/scheduler.cjs`) accepts an optional `sourcePromptId` frontmatter field — additive only, existing PRD files without the field must continue to parse identically (no required-field regression).
- [ ] The `mcp__session-manager-scheduler__scheduler_create_prd` tool / its underlying admin-API PRD-authoring path (used by `/develop`) accepts an optional `sourcePromptId` parameter and writes it into the created PRD's frontmatter when supplied.
- [ ] Add a classification function (e.g. `classifyPromptTicket(ticket): Promise<'inline' | 'develop'>` in a new small module under `src/renderer/lib/` or `src/main/`, colocated with existing prompt-flow code) that runs as an immediate step when a ticket reaches the front of its per-tab queue — it must NOT spawn a scheduler job or PRD to perform the classification itself (classification is a fast in-session judgment, not a scheduled hop). Document in a code comment why: classification decides IF a PRD is needed, so routing it through the scheduler first would be circular.
- [ ] When classification result is `'develop'`, the ticket's status transitions to `'dispatched-to-prd'` (per PRD 748's status enum) rather than running inline through chatRunner.
- [ ] Unit tests cover: `recordExchange` round-trips `promptId`; PRD frontmatter parsing tolerates both presence and absence of `sourcePromptId`; the classification function returns a value for representative quick vs. complex sample prompts (test can stub/mock the actual LLM call — verify the function's control flow and status-transition wiring, not model output quality).
- [ ] `npm run typecheck` passes.
- [ ] `timeout 120 npx vitest run <relevant test files>` passes.

# Implementation notes

Depends on PRD 748 (748-prompt-ticket-chat-queue.md) landing first — it introduces the `PromptTicket` type this PRD extends; read that PRD's diff before starting. Key files: `src/main/exchanges.cjs` (record shape ~lines 47-56), `src/main/index.cjs` line 784 (`exchanges:list` handler), `src/renderer/lib/prdFrontmatter.ts` (existing YAML round-trip pattern — follow its existing style for optional fields, do not hand-roll a new parser), `src/main/scheduler.cjs` (PRD frontmatter consumption). For the classification function: today there is NO deterministic classifier anywhere in this codebase — the closest existing precedent is the `/develop` skill's own text-heuristic trigger-matching (a judgment call, not code) documented in `plugins/session-manager-dev/skills/develop/SKILL.md`. This PRD should implement classification as a single, bounded `claude -p` (or equivalent lightweight prompt) call scoped ONLY to answering inline-vs-develop for the ticket text — reuse whatever this repo's existing pattern is for a small scoped LLM call (e.g. the pattern used by `memoryAggregate.cjs`'s single cost-gated `claude -p` pass: stdin closed, model pinned per this repo's automation-model-pinning convention, hard timeout). Do not build a new subsystem for this — one small function, one scoped call.

# Out of scope

- Turn-panel UI rendering of ticket status or PRD links (final PRD)
- Backfilling promptId onto historical exchange records
- Actually invoking /develop's full PRD-authoring flow from within chatRunner — this PRD only wires the status transition and the sourcePromptId plumbing; the real dispatch call is out of scope if it requires renderer-side orchestration beyond setting status to dispatched-to-prd (leave a clear TODO/hook point if so)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
