---
title: Terminal Chat — make http(s) markdown links actually open (currently silently swallowed)
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

`src/renderer/components/TerminalChat.tsx`'s assistant-message rendering (line ~340-342) renders
chat text through `renderChatMarkdown` (`src/renderer/lib/renderChatMarkdown.ts`, which uses
`marked` + DOMPurify) via `dangerouslySetInnerHTML` — `marked` correctly parses
`[text](https://...)` markdown links into real `<a href>` tags. But clicking one does nothing:
this app's main process installs a global `will-navigate` handler
(`src/main/index.cjs:873-884`) that blocks navigation to any URL not in the dev-server allowlist
(empty in production) via `event.preventDefault()`, with no fallback to open the link externally
— so a rendered chat link is present in the DOM, looks clickable, and silently does nothing when
clicked. This is confirmed already fixed correctly elsewhere in this exact app:
`src/renderer/components/tabs/editor/MarkdownPreview.tsx` (the Document Editor's preview pane,
lines 95-104) already intercepts anchor clicks and routes `http(s)` links through
`window.api.shell.open({ as: 'external', url })` instead of letting the browser attempt in-app
navigation. `TerminalChat.tsx` is the one place in the app still missing this fix.

# Acceptance criteria

- [ ] Add an `onClick` handler to the message container in `TerminalChat.tsx` that currently
  renders via `dangerouslySetInnerHTML={{ __html: renderChatMarkdown(turn.text) }}` (~line
  340-342), reusing the **exact same pattern** already proven in
  `MarkdownPreview.tsx:95-104`: find the closest `<a>` ancestor of the click target, read its
  `href`, and if it matches `/^https?:\/\//i`, call `e.preventDefault()` and
  `window.api.shell.open({ as: 'external', url: href }).catch(() => {})`. Do not invent a new
  pattern — copy this one, since it's already correct and tested in production use.
- [ ] Relative/in-page links (anchors without an `http(s)://` href) fall through unhandled,
  exactly as `MarkdownPreview.tsx`'s comment documents ("in-page (#anchor) and relative links
  fall through harmlessly") — this PRD does not need to do anything special for those; PRD 710
  (queued separately, depends on this one landing first) adds bare-file-path link detection as
  its own follow-up.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] Add/extend a test (search `find src/renderer -iname '*terminalchat*spec*' -o -iname
  '*terminalchat*test*'` first) asserting: a rendered assistant message containing a markdown
  link, when clicked, calls `window.api.shell.open` with `{ as: 'external', url: <href> }` and
  does not navigate the window; a click on a non-link part of the message does nothing. Mirror
  whichever mocking convention an existing `MarkdownPreview` test (if one exists — search for it
  too) already uses for `window.api.shell.open`, rather than inventing a new mock shape. Run via
  `timeout 120 npx vitest run <files touched>`.

# Implementation notes

- Read `src/renderer/components/tabs/editor/MarkdownPreview.tsx` lines 85-134 first — this PRD
  is almost entirely "port this exact, already-correct handler," not new design work.
- Read `src/renderer/components/TerminalChat.tsx` around line 310-345 (the assistant-turn render
  branch) to find the exact container to attach `onClick` to — it should wrap the element with
  `dangerouslySetInnerHTML`, same relationship `MarkdownPreview.tsx` has between its outer
  `onClick`-bearing div and the inner `dangerouslySetInnerHTML` div (a single delegated handler
  on an ancestor, not one per rendered link).

# Out of scope

- Do not add bare-file-path auto-linking — that's PRD 710, sequenced after this one.
- Do not change `renderChatMarkdown.ts`'s parsing/sanitization — this PRD only adds a click
  handler around already-correctly-rendered `<a>` tags.
- Do not touch `MarkdownPreview.tsx` — it's already correct; this PRD only ports its pattern to
  `TerminalChat.tsx`.
- Do not change the global `will-navigate` handler in `index.cjs` — the fix here is the same
  per-component interception `MarkdownPreview.tsx` already uses, not a change to the app-wide
  navigation lock (which exists for real security reasons and stays as-is).

## Engineering standards

Before writing any code, read `~/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).
