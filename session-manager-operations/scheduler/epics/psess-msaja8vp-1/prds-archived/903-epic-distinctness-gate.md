---
title: Epic distinctness gate — join an existing Epic by default instead of minting a new one
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 25
sourcePromptId: psess-msaja8vp-1
dependsOn: [902-epic-source-provenance-schema]
---
# Goal

Make minting a brand-new Epic the LAST resort, not the default, for every automated `ensureEpic()` caller. Today the only "join instead of mint" mechanism is `reuseByGoal` (`src/main/lib/epicMint.cjs`), which only matches on an EXACT `goalText` string — so any producer that synthesizes a unique title per event (e.g. the RCA hook's `Root cause: <slug> → needs_review (...)` titles, which differ every run) always mints a fresh, disconnected Epic even when the work is really a continuation of an existing open one. Add a reusable `findJoinableEpic()` helper that (1) prefers an explicitly-known origin Epic when the caller has one, and (2) otherwise checks open Epics in the same cwd for topical overlap via a concrete, testable keyword-similarity rule — and wire `ensureEpic()` to consult it before minting.

# Acceptance criteria

- [ ] Add `findJoinableEpic(cwd, { goalText, preferEpicId, status })` to `src/main/lib/epicMint.cjs`, exported for the test file and for PRD 899/900's wiring. Logic, in order: (1) if `preferEpicId` is given and `hasOwn(index.sessions, preferEpicId)` is true and that session's own `status` is `'proposed'` or `'active'` (not `'completed'`), return `{ epicId: preferEpicId, matchedBy: 'preferEpicId' }` immediately — no similarity check needed; (2) otherwise, over every open (`status === 'proposed' || status === 'active'`) session in the same `cwd`, compute Jaccard similarity between the lowercased, punctuation-stripped, stopword-free token set of the candidate `goalText` and each open session's `goalText`; if the max similarity is `>= 0.35`, return `{ epicId: <that session's id>, matchedBy: 'similarity', score: <the score> }`; else return `null`
- [ ] Extract the tokenizer (lowercase, strip non-alphanumeric, split on whitespace, drop a small fixed English stopword list — e.g. the/a/an/is/of/to/for/and/in/on/at/this/that) as its own small named function so its behavior is independently testable, not inlined into the similarity check
- [ ] Wire `ensureEpic()`'s existing mint path: when `mintIfMissing` is true and neither `explicitEpicId` nor `reuseByGoal` already resolved a join (i.e. falling through to the 'mint new' branch at the `const epicId = ...slugify...` line), call `findJoinableEpic(cwd, { goalText, preferEpicId: explicitEpicId, status })` first; if it returns non-null, join that Epic exactly like the existing `reuseByGoal` branch does (same `prdDir` resolution, `created: false` return, no new session written) instead of minting
- [ ] Add an explicit opt-out: `ensureEpic(cwd, { ..., forceNewEpic: true })` skips `findJoinableEpic()` entirely and always mints — for the one legitimate case where a caller is certain a new Epic is warranted (e.g. the New Epic UI's direct human-authored creation path, which does not call this function today but may in future)
- [ ] Unit tests in `src/main/__tests__/epicMint.test.cjs`: (a) two `ensureEpic()` calls with near-identical goalText phrasing (e.g. 'Fix the login button color' vs 'Fix login button colour issue') and no `preferEpicId` — second call joins the first Epic (`created: false`), not mints; (b) two calls with genuinely unrelated goalText (e.g. 'Fix the login button color' vs 'Add CSV export to History tab') — second call mints a distinct Epic (`created: true`); (c) `preferEpicId` pointing at an existing OPEN Epic joins it even when goalText similarity is near-zero; (d) `preferEpicId` pointing at a `completed` Epic (or a nonexistent id) falls through to the similarity check instead of joining a dead Epic; (e) `forceNewEpic: true` mints even when a near-identical open Epic exists
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run src/main/__tests__/epicMint.test.cjs passes

# Implementation notes

PRD 902 lands first and adds the `source?: EpicSource` field to `PromptSession` (src/renderer/state/promptSessions.ts) plus a `source` param on `ensureEpic()` — read what it actually landed (`git log`/the file as it now exists) before starting, since this PRD's `findJoinableEpic` return value doesn't itself touch `source` (that's PRD 899/900's job when they call `ensureEpic` with both `preferEpicId`-equivalent context and a `source` object), but `ensureEpic`'s signature this PRD extends must not collide with the `source` param 902 added. Read `src/main/lib/epicMint.cjs` in full, in particular the current `reuseByGoal` block (lines ~134-153) and the mint branch (lines ~155-190) — `findJoinableEpic` must not change `reuseByGoal`'s existing exact-match behavior (still used by `scripts/lib/watchdogHelpers.cjs`'s standing 'Inbound feedback processing' Epic and `scripts/propose-epic.cjs`'s re-proposal-by-title), it only adds a NEW check on the path that would otherwise mint. `hasOwn()` (already defined in this file, line ~64) must be used for the `index.sessions` existence check per its own comment about prototype-pollution-safe lookups — do not use `index.sessions[preferEpicId]` truthiness directly. No stemming/NLP library needed — a plain token-set Jaccard over a small stopword list is sufficient and keeps this dependency-free; do not add a new npm package for this.

# Out of scope

- Wiring any specific producer (rca-hook, propose-epic, feedback-sweep, scheduler-dispatch) to pass `preferEpicId` or use this gate — PRDs 899/900
- Tuning the 0.35 similarity threshold based on real production data — ship the documented default; a follow-up can adjust it once real false-positive/negative data exists
- Any change to the New Epic UI's human-authored creation path (it doesn't call ensureEpic today)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
