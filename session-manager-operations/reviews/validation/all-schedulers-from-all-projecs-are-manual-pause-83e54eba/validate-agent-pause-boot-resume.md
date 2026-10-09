# Validation: agent pause / boot resume plan

Base: c2039a79 (known). Commits: 9a189dcd (1638), a05124fb (1639), 60865131 (1640).
Gates re-run (SM_CHAT_* unset, scratch TMPDIR): agent-pause/manual-pause/admin-routes/rate-limit-pause vitest 35/35 pass; `node --check` MCP server OK; mcpToolCatalog-pause 2/2; SchedulerTopBands 19/19; `npm run typecheck` exit 0; `npm run lint` exit 0.

## 1638-agent-pause-ttl-boot-unpause — VERIFIED
- Route parses body, invalid JSON -> 400, empty ok: scheduler.cjs `registerAdminRoutes` pause route (`raw ? JSON.parse(raw) : {}`, 400 on catch).
- `remote.pause(opts)` -> `setPaused('agent', null, {by})`, strings capped (300; cwd 1000): scheduler.cjs `remote.pause`.
- Agent pause persists `{reason, since, resumeAt, by}`; `AGENT_PAUSE_TTL_MS = 30*60_000`, `computeEffectiveResumeAt` returns now+TTL for 'agent'; existing resume timer path reused.
- Manual outranks agent: mutate returns early when `!isManual && s.paused.reason==='manual'`; manual replaces agent (reason differs -> overwritten). Cooldown bypassed for agent.
- Audit: `appendAuditEvent('scheduler_pause', {reason,resumeAt,by})` after commit; `scheduler_resume {source, clearedReason}` only when `wasPaused`.
- Boot: persisted 'manual'/'agent' -> `clearPause('boot')`; else-if branches keep elapsed/re-arm for other reasons.
- Tests: scheduler-agent-pause.test.cjs added (106 lines), scheduler-manual-pause.test.cjs updated; all pass.

## 1639-mcp-pause-caller-and-warning — VERIFIED
- `scheduler_pause` inputSchema has optional string `reason`; POST body `{originClaudeSessionId: SM_CHAT_SESSION_ID ?? null, cwd: process.cwd(), reason}`; resume body stays `{}` (scripts/scheduler-mcp-server.cjs ~L146, ~L484).
- Catalog entry: purpose "for every project on this machine", whenNotToUse forbids protecting one repo/Epic, notes cover 30 min expiry, cleared on restart, audited with caller, human pause outranks (mcpToolCatalog.cjs L50-58).
- Diagnosis row added to scheduler-operations.md (L176).
- mcpToolCatalog-pause.test.cjs asserts 'every project' and '30 minutes'; passes.

## 1640-pause-banner-agent-attribution — VERIFIED
- api.d.ts: `by?` on SchedulePauseInfo (+ 'agent' added to the reason union, needed for typing).
- pauseMessage 'agent' branch: project = last segment of by.cwd else 'another session'; reason clause omitted when null; "auto-resumes in <relative>" via formatRelative; elapsed -> "auto-resume pending"; plain string render.
- 'manual' text (SchedulerTopBands.tsx L159) unchanged; unknown reasons still hit the generic fallback.
- Tests added for agent banner with/without reason and elapsed resumeAt; pass.

## Combined diff review
The base..HEAD range also contains unrelated plans (web-remote restore, manual book); only the pause-related files were reviewed. No secrets, no `dangerouslySetInnerHTML`; agent-supplied `reason` is length-capped and rendered as text. Reused existing `readBody`/`appendAuditEvent`/`formatRelative`.

## Findings
### Critical
- none
### Important
- none
### Minor
- scheduler.cjs `registerAdminRoutes`: `by.reason`/`cwd` are only length-capped, not sanitised, before audit logging; harmless (JSONL-encoded) but unbounded count of repeated agent pauses re-extends the 30-min TTL (an agent can re-pause indefinitely). Consider a rate limit.
- SchedulerTopBands.tsx: an elapsed `resumeAt` shows "auto-resume pending" (PRD unspecified; reasonable choice).
- Untracked stray `<path>` file in the worktree is the known sqlite-MCP placeholder, not part of this plan.
