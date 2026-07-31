---
title: Route conversation links to the real embedded Browser; reuse EditorView for files/MDs
cwd: ~/Projects/session-manager
estimateMinutes: 20
---

# Goal

Link 4/5. Inside the new scoped Agent conversation view (PRD 804), make external links open in
Session Manager's existing embedded Browser instead of the OS default browser, and make
file/markdown references render via the same component the File Explorer and PRD viewer already
use, instead of the conversation's separate markdown renderer. Both surfaces already exist in
this codebase — this PRD is pure reuse/wiring, not new rendering infrastructure:
- The embedded Browser is real and functional: `src/main/browserView.cjs` implements a native
  `WebContentsView`-backed browser (`registerBrowserView`, wired at `src/main/index.cjs:1078`);
  `<webview>`/iframes are blocked app-wide (`will-attach-webview` deny + CSP `frame-src 'none'`
  per `browserView.cjs:2-5`), so this `WebContentsView` mechanism is the only correct way to show
  remote content, and it is already used by the `browser` nav tab today.
- File/markdown rendering already has one shared implementation:
  `src/renderer/components/tabs/editor/MarkdownPreview.tsx` (`marked` + `DOMPurify`), used by
  `EditorView.tsx`, which `SchedulerPrdsView.tsx` already reuses directly for PRDs
  (`EditorView.tsx:38`, comment at `SchedulerPrdsView.tsx:140`: "a PRD opened here shows up as a
  tab there too"). The conversation view currently uses a separate renderer,
  `src/renderer/lib/renderChatMarkdown.ts`, with no shared file-rendering path.

# Acceptance criteria

- [ ] Clicking an `http(s)://` link inside the scoped conversation view (PRD 804) opens it via
  the existing embedded Browser mechanism (`browserView.cjs`/`registerBrowserView` IPC path) —
  not `shell.openExternal` (`src/main/index.cjs:683-707`, the OS-browser path currently used by
  the Terminal's `WebLinksAddon`, `Terminal.tsx:81-85`) and not a bare `<a href>` default
  navigation
- [ ] A link/reference to a local file or `.md` path inside the conversation renders using the
  same component File Explorer/PRD viewer use (`EditorView`/`MarkdownPreview.tsx`), not
  `renderChatMarkdown.ts` — verify by confirming the conversation view imports `EditorView` (or
  the shared `MarkdownPreview` it wraps) for this code path rather than duplicating rendering
  logic
- [ ] `renderChatMarkdown.ts` continues to work unchanged for the existing per-tab
  `TerminalChat.tsx` view (out of scope to migrate that view in this PRD — only the new PRD 804
  conversation view adopts the shared renderer)
- [ ] `timeout 300 npm run typecheck` passes
- [ ] A test covers: an `http(s)` link click dispatches through the Browser IPC path (not
  `shell.openExternal`); a file/markdown reference renders via the shared `EditorView`/
  `MarkdownPreview` path

# Implementation notes

Depends on PRD 804 (the conversation view this wires into) — read its actual landed diff first.
Read `src/main/browserView.cjs` in full (in particular how `registerBrowserView` exposes an
open/navigate IPC call — reuse that exact call, do not add a second IPC path for opening URLs)
and `src/renderer/components/tabs/Browser.tsx` for how the renderer currently talks to it. Read
`src/renderer/components/tabs/editor/EditorView.tsx` and `MarkdownPreview.tsx` and
`SchedulerPrdsView.tsx:140` for the existing reuse pattern to follow exactly (don't invent a
third markdown component).

This is link 4 of the 5-PRD chain (802-806). PRD 806 (final link) adds the completion/archive
workflow.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

# Out of scope

- Migrating the existing per-tab `TerminalChat.tsx` view to the shared renderer/browser path
- Any change to `browserView.cjs`'s core WebContentsView mechanism — reuse its existing IPC only
- Adding new Browser features (capture/recorder/observe) — out of scope, unrelated to this PRD
