---
title: Roll back a minted Epic when its seed PRD write fails
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
dependsOn: [fix-sourceprompt-id-contract-mismatch]
---

# Goal

src/main/lib/epicMint.cjs's `ensureEpic` synchronously writes a newly-minted Epic (session entry + seed `prompt` event) into active-index.json before the caller (src/main/scheduler.cjs `writePrd`) ever attempts the actual PRD file write. When that PRD write subsequently fails (invalid slug at scheduler.cjs ~4167-4170, symlink defense trip at ~4179-4187, or a writeTextAtomic exception at ~4195-4198), `cleanupEmptyMintedEpic` (scheduler.cjs ~4151-4164) only removes the on-disk prds/ directory (and the epic root dir if now empty) — it never removes the Epic's entry from active-index.json's `sessions`/`events` maps. The result is a permanently orphaned Epic visible in the Epics nav with just a seed prompt event, no PRDs, and no code path that ever cleans it up.

# Acceptance criteria

- [ ] cleanupEmptyMintedEpic (or a new sibling function) removes the minted Epic's entry from active-index.json's sessions and events maps when the Epic was freshly minted by this call and the subsequent PRD write failed, mirroring the existing directory-cleanup behavior
- [ ] This rollback must NOT fire when the PRD is being added to an already-existing Epic (only Epics minted fresh by this exact ensureEpic call should be rolled back on failure) — reuse whatever signal ensureEpic already returns to distinguish "joined existing" vs "minted new"
- [ ] A unit test covers: PRD write failure (e.g. invalid slug) after a fresh Epic mint results in zero residual entries in active-index.json for that epicId
- [ ] A unit test covers: PRD write failure when joining a pre-existing Epic leaves that Epic's existing session/events untouched
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 600 npm run test:unit` passes.

# Implementation notes

Read src/main/lib/epicMint.cjs's ensureEpic (~line 73-117) for what it writes and what it currently returns to the caller. Read src/main/scheduler.cjs's writePrd and cleanupEmptyMintedEpic (~line 4151-4198) for the three failure call sites.

The active-index.json read-modify-write pattern in epicMint.cjs has no path lock (tracked separately in PRD 858) — for this PRD just reuse the existing synchronous fs.readFileSync/writeFileSync pattern already used elsewhere in the file; do not add locking as part of this change.

Depends on 856 only for sequencing (both touch ensureEpic's contract) — read its landed state before starting in case the return shape of ensureEpic changed.

# Out of scope

- Adding path-locking to epicMint.cjs's active-index.json writes (see PRD 858)
- Changing PRD-write success-path behavior

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
