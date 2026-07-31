---
title: Terminal Chat — auto-link bare file paths (in-app editor) + style inline code/code blocks
cwd: ~/Projects/session-manager
estimateMinutes: 28
---

# Goal

**Depends on PRD 709 (`709-terminalchat-external-link-clicks.md`) — do not start until it has
landed** (verify via `git log --oneline -- src/renderer/components/TerminalChat.tsx`; if 709's
commit isn't present, halt with `SCHEDULER_VERDICT: FAIL blocked-on-709`). This PRD adds a second
click behavior to the same delegated `onClick` handler 709 creates on the chat message container
— building both independently would produce two competing handlers on the same element.

Two confirmed gaps in Terminal Chat's rendering (`TerminalChat.tsx` via
`src/renderer/lib/renderChatMarkdown.ts`, `marked` + DOMPurify):

1. **Bare file-path mentions are never clickable at all.** Unlike a real markdown link
   (`[text](url)`, fixed by PRD 709), a plain mention like `docs/fb-bilko-samples-2026-07-27/
   README.md` in assistant text has no markdown link syntax — `marked` renders it as plain text,
   full stop. The raw interactive terminal already solves exactly this for xterm output
   (`src/renderer/components/Terminal.tsx`'s `FILE_LINK_RE`-based custom link provider, lines
   20, 84-113 — matches path-like tokens and opens them in the in-app Editor scene via
   `useEditor.getState().openFile(absPath, { line, col })` + `window.dispatchEvent(new
   CustomEvent('sm:open-editor'))`), but that mechanism is xterm-specific (xterm's
   `ILinkProvider` API) and doesn't apply to Terminal Chat's HTML-rendered markdown bubbles.
2. **Inline code and code blocks in chat messages have no visual styling.**
   `src/renderer/styles.css:49-51` defines `.markdown-body code`/`.markdown-body pre` (monospace
   box, background, border) but has no equivalent `.prose-chat` rule — chat messages are the
   *other* documented call site (`styles.css:58`'s own comment: "assistant chat turns
   (`.prose-chat`, TerminalChat.tsx) — one rule, two call sites" for the table styling that
   already covers both) but code/pre styling was never extended the same way.

# Acceptance criteria

- [ ] Detect file-path-like tokens in a chat message's rendered output and make them clickable,
  reusing `Terminal.tsx`'s `FILE_LINK_RE` regex (`/(?:^|[\s(])((?:\.{1,2}\/)?[\w./-]+\.[A-Za-z]\w*(?::(\d+))?(?::(\d+))?)/g`)
  verbatim rather than writing a second pattern. Implement this as a **post-process pass over the
  rendered DOM** (after `renderChatMarkdown`'s HTML is inserted, walk text nodes), **skipping
  text already inside an `<a>`, `<code>`, or `<pre>` element** — a file-looking token that's
  already a real link (post-709) or inside a code span/block must not be double-wrapped or
  corrupted. Do not regex the raw markdown *source* string before parsing — that risks mangling
  real markdown syntax and code-block contents; operate on the parsed DOM instead.
- [ ] A matched token gets wrapped in a `<span>`/`<a>`-like clickable element (e.g. a `data-`
  attribute marking it as a file-link) with the same delegated `onClick` handler PRD 709 added:
  when clicked, resolve the path the same way `Terminal.tsx:103-107` does (strip trailing
  `:line:col`, resolve relative paths against the tab's `cwd`), then call
  `useEditor.getState().openFile(absPath, { line, col })` + dispatch `'sm:open-editor'` — same
  in-app-editor behavior as the terminal, not an OS file-open dialog.
- [ ] **Security (mandatory, not deferred):** a matched "file path" is untrusted text — it comes
  from assistant output, which can echo content the model read from anywhere (a fetched URL, a
  file, prior conversation). Before calling `openFile`, resolve the absolute path and validate it
  through the same home-scoping boundary the rest of the app uses for file access (`checkInsideHome`/
  `validatePath` pattern referenced in `Terminal.tsx`'s own link-provider comment — "Resolves
  relative paths against the tab's cwd in the main process via fs.access + validatePath"). A path
  that resolves outside the allowed root must silently no-op (or toast a clear "path outside
  project" message) — never open it. Add a test asserting a `../../etc/passwd`-style traversal
  attempt in chat text does NOT open.
- [ ] Add `.prose-chat code` / `.prose-chat pre` / `.prose-chat pre code` rules to
  `src/renderer/styles.css`, matching `.markdown-body`'s existing values exactly (or, better,
  fold `.prose-chat` into the *same* selector list as the existing `.markdown-body code`/`pre`
  rules at lines 49-51, the same "one rule, two call sites" pattern already used for the table
  rule at line 62 — reuse, don't duplicate the declaration block).
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] Add/extend tests (search `find src/renderer -iname '*terminalchat*spec*'` first, reuse
  PRD 709's test file if it added one) covering: a bare file-path mention becomes clickable and
  opens via `useEditor.openFile` + `sm:open-editor`; a path-like token already inside a code span
  or an existing `<a>` is left untouched (not double-linked); a path-traversal attempt does not
  open (security case above). Run via `timeout 120 npx vitest run <files touched>`.

# Implementation notes

- Read `src/renderer/components/Terminal.tsx` lines 20 and 84-113 in full first — `FILE_LINK_RE`
  and the exact `activate()` resolution logic are the reusable core; port them, don't
  reinterpret them.
- Read `src/renderer/lib/renderChatMarkdown.ts` in full (short, 37 lines) — it already wraps
  `marked`'s table renderer for one post-process concern (the `.prose-chat-table-wrap`
  container); the file-link pass in this PRD is a second, separate post-process step, most
  naturally done in `TerminalChat.tsx` after the HTML is mounted (e.g. a `ref`-based DOM walk in
  a `useEffect`), not inside `renderChatMarkdown.ts` itself (which returns a sanitized HTML
  *string*, not a live DOM you can walk/attach behavior to).
- `useEditor.getState().openFile` and the `'sm:open-editor'` custom event are the existing,
  already-working navigation mechanism `Terminal.tsx` uses — confirm `TerminalChat.tsx`'s
  rendering context can reach `useEditor` (it's a zustand store, importable anywhere) and that
  dispatching `'sm:open-editor'` correctly routes to the Editor scene from wherever Terminal Chat
  itself is mounted (check `App.tsx`'s listener for this event, added for `Terminal.tsx`, to
  confirm it fires regardless of which component dispatched it).

# Out of scope

- Do not change `MarkdownPreview.tsx` (Document Editor preview) — it doesn't have this bare-path
  gap in the same way (it's editing a document, not chatting), and this PRD is scoped to Terminal
  Chat.
- Do not add auto-linking for anything other than file-path-like tokens (no email addresses, no
  bare domain-name detection beyond what `marked`'s own link parsing already covers).
- Do not change `Terminal.tsx`'s own xterm link provider — only reuse its regex/resolution logic,
  don't refactor it to be shared code unless doing so is trivial; a duplicated small regex
  constant is acceptable here, per this PRD's own scope, over a forced cross-cutting refactor.

## Engineering standards

Before writing any code, read `~/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).
