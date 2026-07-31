---
title: Inline thumbnail preview for pasted clipboard images
cwd: ~/Projects/session-manager
estimateMinutes: 20
---
# Goal

When a user pastes an image (Ctrl+V) into the Terminal pane or the Turn-panel chat input, the app currently only types the raw tmp file path (`os.tmpdir()/session-manager-clipboard/clipboard-<ts>.png`) into the input — giving zero visual confirmation of what was pasted, forcing the user to open the file manually to see it. Add a small inline thumbnail preview, shown immediately after paste, next to/above the input, so the user can confirm the pasted image without leaving the app. The path text still gets typed into the input/PTY unchanged (Claude CLI still needs the literal `@path` reference) — this is a visual affordance only.

# Acceptance criteria

- [ ] After a successful image paste in `src/renderer/components/Terminal.tsx` (the `isPaste` handler ~lines 147-164, specifically the `img.ok` branch ~150-155), render a dismissible thumbnail chip near the terminal input area showing the pasted PNG, in addition to the existing `writeInChunks(tabId, img.path + ' ')` behavior which must be unchanged.
- [ ] After a successful image paste resolved via `src/renderer/lib/pasteImageIntoChat.ts`'s `resolveChatPaste()` (consumed by `src/renderer/components/TerminalChat.tsx` ~line 446), render the same style of thumbnail chip near the chat input, without changing the existing textarea-splice/toast behavior in `resolveChatPaste()`.
- [ ] The thumbnail reuses the existing `smfile://` protocol pattern from `src/renderer/components/tabs/editor/ImagePane.tsx` (`smfileUrl(path)` from `src/renderer/state/editor.ts`) to render `<img src={smfileUrl(img.path)}>` — do NOT add a new IPC channel, base64 round-trip, or new main-process handler; the CSP `img-src` allowance for `smfile://` already covers this.
- [ ] Thumbnail is capped to a small fixed max size (e.g. ~120px) via CSS `object-contain`, matching `ImagePane.tsx`'s existing `max-w-full max-h-full object-contain` convention, and does not visually disrupt the existing input layout.
- [ ] Thumbnail auto-dismisses after the input is submitted/cleared, or is manually dismissible (an X button) — pick whichever fits each component's existing state model with the least structural change; do not add a new global store for this, keep it local component state per input.
- [ ] If `smfileUrl(path)` fails to load (e.g. file missing), fail silently (no broken-image icon left dangling) — reuse the pattern already established for error handling in this repo's image components.
- [ ] Both Terminal.tsx and TerminalChat.tsx paste flows are covered by a component test or existing test file extension verifying the thumbnail renders on a successful `img.ok` paste result and does not render on a text-only paste.
- [ ] npm run typecheck passes.
- [ ] npm run test:unit passes (or the relevant scoped subset).

# Implementation notes

Read first: `src/main/index.cjs:486-505` (clipboard:paste-image handler + its docblock explaining the @path-reference rationale — do not change this handler, it's out of scope), `src/renderer/components/Terminal.tsx:147-165` (isPaste handler), `src/renderer/lib/pasteImageIntoChat.ts` (pure resolver used by TerminalChat.tsx, already returns `{path, bytes}` on success — the caller in TerminalChat.tsx around line 446 is where the thumbnail should be triggered from), `src/renderer/components/tabs/editor/ImagePane.tsx` (the exact pattern to reuse: `smfileUrl(path)` + `<img>` with object-contain), `src/renderer/state/editor.ts` (smfileUrl implementation + the smfile:// CSP allowance — confirm CSP already covers non-editor-tab contexts, it should since it's a protocol-level allowance not scoped to one component). Keep this additive/presentation-only — do not touch the clipboard:paste-image main-process handler, the tmp-file write path, or the existing path-into-input behavior.

# Out of scope

- Changing what gets typed into the terminal/chat input (the @path reference) — must remain unchanged
- New IPC channel or base64 image transport — must reuse smfile://
- Persisting or listing paste history
- Deleting/cleaning up the tmp clipboard PNG files (separate concern, not part of this UI feature)
- Any change to the main-process clipboard:paste-image handler

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
