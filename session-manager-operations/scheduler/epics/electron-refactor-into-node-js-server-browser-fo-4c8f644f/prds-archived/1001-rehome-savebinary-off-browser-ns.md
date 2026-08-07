---
title: Re-home saveBinary off the browser IPC namespace onto files
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 35
sourcePromptId: electron-refactor-into-node-js-server-browser-fo-4c8f644f
sourceTabId: 8a7cbc80-2fb6-46f2-a86d-cbb7a7b9906e
---
# Goal

Epic image attachments currently write through `window.api.browser.saveBinary(...)` — an IPC channel owned by the Browser tab, which is about to be deleted. This PRD moves that one call onto the `files` namespace so the Browser tab can be removed without breaking Epic attachments. This is a pure re-home: no behaviour change, no new capability, and the on-disk destination is unchanged.

# Acceptance criteria

- [ ] `src/renderer/components/epics/attachments.tsx:105` calls a `files`-namespace binary-write API instead of `window.api.browser.saveBinary`, passing the same `'epics'` ops writer it passes today
- [ ] The new handler is registered in `src/main/files.cjs` (not `browserCapture.cjs`/`browserView.cjs`) and routes through `config.cjs`'s `writeBinaryAtomic` with `opts.writer` so the single-writer law in `src/main/lib/opsOwnership.cjs` still applies
- [ ] `src/preload/index.cjs` exposes the new method under `files:` and `src/preload/api.d.ts` is updated to match; the `browser.saveBinary` entry is removed from both
- [ ] A zod schema for the new channel exists in `src/main/ipcSchemas.cjs`, mirroring the shape the old browser channel validated
- [ ] The `'browser': 'browser'` entry in `src/main/lib/opsOwnership.cjs` is removed, and any `session-manager-operations/browser/` write grant in `src/main/config.cjs` is removed with it
- [ ] `npm run typecheck` passes, `npm run lint` passes, and `npm run test:unit` passes
- [ ] Manual-free verification: grep confirms zero remaining references to `browser.saveBinary` or `saveBinary` on the browser namespace anywhere in `src/`

# Implementation notes

Read `session-manager-operations/architecture/` and the repo CLAUDE.md single-writer-law section before touching `opsOwnership.cjs`.

Key facts already established (do not re-derive):
- The only caller is `src/renderer/components/epics/attachments.tsx:105`: `await window.api.browser.saveBinary(destPath, base64, 'epics')`. It ALREADY passes `'epics'` as the ops writer, and the files already land under `session-manager-operations/prompt-sessions/attachments/`. So only the channel name is wrong — the destination and writer are already correct. Do not change destPath computation.
- The handler currently lives in the Browser-tab main modules. Move the logic, don't rewrite it: keep base64 decode + `writeBinaryAtomic` semantics identical.
- `src/main/files.cjs` (409 L) is the natural home and already has an ipcMain registration block to extend.
- CLAUDE.md documents `browser` as "the one exception that IS in OWNERS" for Capture-panel scratch saves. Once this PRD lands, that exception is genuinely gone — but leave the CLAUDE.md edit to the docs PRD (`docs-pass-browser-webremote-removal`); this PRD only changes code.

This PRD BLOCKS `delete-browser-tab`. Land it first and leave the Browser tab otherwise untouched.

# Out of scope

- Deleting any Browser-tab file — that is the `delete-browser-tab` PRD
- Editing CLAUDE.md or any docs — that is the `docs-pass-browser-webremote-removal` PRD
- Changing where attachments are written on disk
- Adding any new capability to the files namespace beyond the one moved method

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
