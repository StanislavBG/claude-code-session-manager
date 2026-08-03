---
title: Epic-context digest builder for scheduled PRD dispatch
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: psess-mscg8i3u-2
---
# Goal

Build a pure, best-effort module `src/main/lib/epicContextDigest.cjs` exporting `buildContextDigest({ cwd, epicId, maxChars })` that composes a condensed, real (never fabricated) digest of an Epic's own session, for later injection into a scheduled PRD job's opening prompt. Reuse `promptSessionTranscript.cjs`'s `readTurns(cwd, epicId, { limit })` for turn history and `epicMint.cjs`'s `readActiveIndex(cwd)` for the Epic's `goalText`/`tag` — do not reimplement transcript reading or active-index parsing. This is groundwork only: wiring it into scheduler.cjs's actual dispatch path is a separate, dependent PRD.

# Acceptance criteria

- [ ] `src/main/lib/epicContextDigest.cjs` exports an async `buildContextDigest({ cwd, epicId, maxChars })` that returns a string.
- [ ] Internally calls `readTurns` from `./promptSessionTranscript.cjs` and `readActiveIndex` from `./lib/epicMint.cjs` — grep confirms no reimplementation of JSONL transcript parsing or active-index.json reading elsewhere in the new file.
- [ ] Digest text starts with the Epic's `goalText` (when present) followed by a bounded number of the most-recent turns, each formatted plainly as `[<role>] <text>`, and the whole returned string never exceeds `maxChars` (default 4000 when omitted).
- [ ] When the digest would exceed `maxChars`, whole turns are dropped starting from the oldest until it fits — never a hard mid-string slice that could cut a turn's text in half.
- [ ] Returns `''` (never throws) for: empty/missing `epicId`, `epicId` not present in that cwd's active-index.json sessions, an empty/nonexistent transcript, or any internal error — every internal call is wrapped so a failure here can never propagate to a caller.
- [ ] Unit tests at `src/main/__tests__/epicContextDigest.test.cjs` cover: a normal digest (goalText + turns present), missing epicId, epicId absent from active-index, empty transcript, and maxChars truncation dropping the oldest turns first (not a mid-turn slice).
- [ ] `timeout 300 npx vitest run src/main/__tests__/epicContextDigest.test.cjs` passes.
- [ ] `npm run typecheck` passes with no new errors.

# Implementation notes

Read `src/main/promptSessionTranscript.cjs` (readTurns(cwd, epicId, {limit}) — returns `{v, epicId, eventId, role, at, text}[]`, tolerant of corrupt lines, returns `[]` on ENOENT) and `src/main/lib/epicMint.cjs`'s `readActiveIndex(cwd)` (returns `{ sessions: { [epicId]: { goalText, tag, claudeSessionId, status, ... } } }`) before writing anything — reuse their exact signatures, don't guess. For the turn-history call, request a generous `limit` (e.g. 40) from `readTurns` and then apply the maxChars-driven oldest-first drop yourself in this new module, rather than pushing truncation logic into `promptSessionTranscript.cjs`. For test-file conventions for a new `src/main/__tests__/*.test.cjs` file (require/module.exports style, how existing main-process .cjs tests are structured and run under vitest), look at `src/main/__tests__/scheduler-meta-code-sha.test.cjs` or `src/main/__tests__/activeIndexMerge.test.cjs` as a template. Keep this module plain Node (no Electron dependency), matching `sessionSlots.cjs`'s and `promptSessionTranscript.cjs`'s own posture, since it needs to be callable from scheduler.cjs.

# Out of scope

- Wiring this into scheduler.cjs's actual job-dispatch prompt-building — that's the next PRD in this chain.
- Any change to sessionSlots.cjs or scheduler concurrency/metering.
- Any UI surfacing of the digest.
- Changing promptSessionTranscript.cjs's or epicMint.cjs's own APIs.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
