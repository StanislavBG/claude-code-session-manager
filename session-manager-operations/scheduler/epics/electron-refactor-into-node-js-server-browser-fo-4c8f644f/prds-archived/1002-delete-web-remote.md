---
title: Delete the Web Remote feature end to end
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 60
sourcePromptId: electron-refactor-into-node-js-server-browser-fo-4c8f644f
sourceTabId: 8a7cbc80-2fb6-46f2-a86d-cbb7a7b9906e
---
# Goal

Remove the Web Remote mobile-cockpit feature entirely — the outbound relay client, its E2E crypto state machine, its renderer tab, and its nav/screen wiring. This is a deliberate scope reduction ("going LIGHT"); the code stays recoverable in git history. Roughly 1,930 lines plus 4 test files come out, along with the relay's whole security surface.

# Acceptance criteria

- [ ] These files are deleted: `src/main/webRemote.cjs`, `src/main/lib/e2eStateMachine.cjs`, `src/renderer/components/tabs/WebRemote.tsx`
- [ ] These test files are deleted: `tests/unit/ipc-web-remote.spec.ts`, `tests/unit/webRemoteAuthGate.spec.ts`, `tests/unit/webRemoteSasState.spec.ts`, `src/main/__tests__/web-remote-e2e-pinning.test.cjs`
- [ ] `src/main/index.cjs` no longer requires or calls webRemote: the `require` at line ~72, `registerRemoteHandlers()` (~844), `attachWindow` (~1156), `init()` (~1189) and `destroy()` (~1252) call sites are all removed with no dangling references
- [ ] The `remote` nav entry is removed from `src/renderer/lib/navGroups.ts` (line ~66) and its `remote` case + `WebRemote` import removed from `src/renderer/components/screenComponents.tsx` (lines ~19, ~61, ~108)
- [ ] The `webRemote:` namespace is removed from `src/preload/index.cjs` and `src/preload/api.d.ts`, including the `webRemote:status`, `webRemote:token-revoked` and `webRemote:revoked-all` push-channel subscriptions
- [ ] webRemote-only schemas and command allowlists in `src/main/ipcSchemas.cjs` are removed, but `ALLOWED_COMMANDS`/`MUTATE_COMMANDS`/`SAS_GATED_READS` are only deleted if nothing else imports them — verify with grep before removing each
- [ ] Comment-only references in `src/main/scheduler.cjs:4768` and `src/main/lib/summarize.cjs:8` are updated so they no longer describe webRemote as a live caller; `lib/summarize.cjs` itself is KEPT (it has other callers)
- [ ] `npm run typecheck`, `npm run lint`, `npm run test:unit` and `npm run health` all pass
- [ ] grep across `src/`, `bin/`, `scripts/` and `tests/` returns zero live references to `webRemote`, `WebRemote`, or `e2eStateMachine` (comments in historical PRDs/docs are out of scope)

# Implementation notes

Established by inspection — trust these, they were verified against the tree:
- `src/main/webRemote.cjs` is 1,367 L, `src/main/lib/e2eStateMachine.cjs` is 39 L, `src/renderer/components/tabs/WebRemote.tsx` is 522 L.
- All `index.cjs` wiring line numbers above were read from the current file; re-grep rather than trusting the exact numbers if the file has moved under you.
- `src/main/lib/summarize.cjs` is SHARED — its header comment merely mentions webRemote as one importer. Delete the comment line, never the module.
- `src/main/scheduler.cjs:4768` is a comment describing a function as "callable from webRemote.cjs". The function itself may have other callers — check before removing anything beyond the comment.
- `~/.claude/session-manager/web-remote.json` and `~/.claude/web-remote-audit.log` are user-machine state, not repo files. Do NOT write migration/cleanup code for them; leaving them orphaned on disk is acceptable and expected.
- This PRD is INDEPENDENT of the Browser-tab deletion — no ordering constraint between them.

Follow the repo's no-backwards-compat-shims convention: delete outright, do not leave stubs, feature flags, or deprecation wrappers.

# Out of scope

- Editing CLAUDE.md or any documentation — that is the `docs-pass-browser-webremote-removal` PRD
- Touching anything in the Browser tab
- Deleting `src/main/lib/summarize.cjs`
- Removing or migrating user-machine files under ~/.claude/
- Any change to the bilko.run / ~/Projects/Bilko side of the relay — this repo only

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
