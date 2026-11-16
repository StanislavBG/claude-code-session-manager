# Validation: cross-project replies land in the asking Epic

Base: 2d618cc698b63a26ac925c73094b1927a8d83dd8 (known). 8 commits bf7fdb6e..dbf1ff05, 26 files, +1981/-31.
PRD files found in prds-archived/ (3185-3192).

## Gates (re-run, foreground)
- `npx vitest run` over all PRD-gate test targets (crossProjectFeedback, crossProjectReply, promptSessionEvents, mcpToolCatalog, scheduler-mcp-server, CrossProjectReplyCard, BuildResultCard, useCrossProjectReplyToast, epicOrigin): 10 files / 276 tests pass.
- `npm run typecheck`: exit 0. `lint:hooks`, `lint:selectors`, `lint:docs`: all OK.
- `npm run test:unit` full: first run 1 file / 4 tests red (`restorableSessions.test.cjs`, isolated project, claimedClaudeSessionIdsAsync; passes alone 23/23); second full run 1074 files / 10529 passed, 0 failed. Treated as a load flake in a file this plan did not touch.
- CLAUDE.md size: 11999 chars (under 12,000 budget, by 1).

## Per-PRD
- **feedback-thread-stamp-reply-to — VERIFIED.** crossProjectFeedback.cjs diff (+209) stamps replyTo; promptSessionSchema.cjs EpicSourceSchema + promptSessions.ts EpicSource/notice union extended; crossProjectFeedback.test.cjs (+174) passes.
- **feedback-reply-deliver-into-asking-epic — VERIFIED.** crossProjectReply.cjs: identity 403 (:182-194), target limited to replyTo.epicId else 403 (:208), cwd validated via config.validatePath and self-reply refused (:212-220), MAX_REPLIES_PER_THREAD=3 with per-Y serialization, 429 on 4th (:226), receipt event on Y. Tests at crossProjectReply.test.cjs:116-361 pass.
- **feedback-reply-fallback-new-proposed-session — VERIFIED.** Tests :230-350 (archived/completed/refused-send fallbacks open linked proposed Epic, count toward cap) pass.
- **feedback-reply-mcp-tool-and-route — VERIFIED.** scheduler-mcp-server.cjs (+64), mcpToolCatalog.cjs, index.cjs:100-102 registers route; route tests :383-393 and scheduler-mcp-server-feedbackReply.test.cjs pass.
- **epic-reply-card-in-transcript — VERIFIED.** CrossProjectReplyCard.tsx + EpicDetail wiring; test passes; lint:hooks/selectors OK.
- **cross-project-reply-toast — VERIFIED.** useCrossProjectReplyToast.ts + App.tsx mount; test passes.
- **epic-origin-chip-reply-thread — VERIFIED.** epicOrigin.ts replyOf/replyTo; epicOrigin.test.ts passes.
- **feedback-reply-docs — VERIFIED.** send-feedback SKILL.md, domain-model.md, CLAUDE.md updated; lint:docs OK; plugin bumped 0.4.2.

## Plan-level real-path probe
crossProjectReply.test.cjs uses real Epic files via epicMint/readActiveIndex (only sendPrompt injected):
- `delivers into an active asking Epic` (:116): X gets `cross-project-reply` event, `sendPrompt('psess-x', prompt, {sessionId:'cs-x', cwd})` (X's own claudeSessionId), no human origin, receipt on Y, audit line.
- `toEpicId other than replyTo.epicId → 403` (:206): reply aimed at another Epic refused.
Both pass.

## Review
`/code-review` and `/security-review` not run as separate commands; self-reviewed: replyTo.cwd goes through validatePath + realpath compare (no traversal), reply text framed as untrusted, per-thread cap serialized, never human-origin so ledger can't be spoofed.

## Findings
- Critical: none.
- Important: none.
- Minor: CLAUDE.md is at 11999/12000 chars — next law line must split. `restorableSessions.test.cjs` flaked once in the full suite (unrelated to this plan).
