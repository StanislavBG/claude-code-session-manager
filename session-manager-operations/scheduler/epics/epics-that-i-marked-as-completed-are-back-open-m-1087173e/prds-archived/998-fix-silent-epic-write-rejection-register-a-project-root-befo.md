---
title: Fix silent Epic-write rejection: register a project root before every prompt-sessions write
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 45
sourcePromptId: epics-that-i-marked-as-completed-are-back-open-m-1087173e
---
# Goal

Every renderer write to a project's session-manager-operations/prompt-sessions/ is rejected by config.cjs's validateWrite with "Write outside allowed write boundaries" unless that project root happens to have been registered via config.addAllowedRoot() earlier in the same app run. addAllowedRoot is only called from pty.cjs (pty spawn), lib/prdCreate.cjs and projectBrief.cjs — never from the Epic persistence path. Result: right after app boot, marking an Epic Completed silently fails to persist (no tombstone, no archive) and the Epic returns as Open on the next load. Verified in ~/.config/claude-code-session-manager/logs/session-manager-2026-08-06.log (lines 45-69, 421-447) against 7 Epics completed twice on 2026-08-06 with zero disk effect.

# Acceptance criteria

- [ ] src/main/lib/activeIndexMerge.cjs's mergeActiveIndex calls config.addAllowedRoot(path.resolve(cwd)) before its write, mirroring the existing precedent + comment in src/main/lib/prdCreate.cjs:152-155
- [ ] The Epic ARCHIVE write path (renderer markCompleted -> config.writeJson of promptSessionArchivePath) also succeeds on a cold boot with no pty spawned for that cwd — register the root in the main-process handler that serves it, not in the renderer
- [ ] New unit test in src/main/lib/__tests__/ proves: with allowedRoots containing ONLY the homedir, a mergeActiveIndex call for <tmpRoot>/session-manager-operations/prompt-sessions/active-index.json writes the file successfully (today it throws)
- [ ] New unit test proves an Epic archive write to <tmpRoot>/session-manager-operations/prompt-sessions/<id>.json succeeds under the same cold-boot conditions
- [ ] No widening of validateWrite's grants: the existing prompt-sessions/ sub-path check in src/main/config.cjs:139-147 is unchanged; only root REGISTRATION is added
- [ ] npm run typecheck and npm run test:unit both pass

# Implementation notes

Root cause chain, all verified: src/main/config.cjs:67 `allowedRoots = new Set([os.homedir()])`; validateWrite (config.cjs:100-175) skips the homedir root (`if (root === os.homedir()) continue`, line 113) so the per-project prompt-sessions/ grant at lines 139-147 only applies to a root added via addAllowedRoot. Only callers today: src/main/pty.cjs:99, src/main/lib/prdCreate.cjs:155, src/main/projectBrief.cjs:239. prdCreate.cjs:152-155 already carries the exact comment explaining this hazard — follow that pattern. The cwd reaching mergeActiveIndex is already zod-validated (src/main/ipcSchemas.cjs promptSessionsMergeActiveIndex) and still goes through validatePath, so registering it widens nothing beyond what a pty spawn in the same cwd already does. Do NOT fix this in the renderer.

# Out of scope

- Error surfacing / toasts (separate PRD)
- Reconciling the already-stale rows on disk (separate PRD)
- Any change to opsOwnership.cjs single-writer rules

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
