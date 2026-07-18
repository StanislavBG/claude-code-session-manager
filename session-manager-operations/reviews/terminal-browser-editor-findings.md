# Terminal / Browser / Editor — review-and-fix pass

Scope: `TerminalChat.tsx` + `pty.cjs`/`chatRunner.cjs`; the Browser tab family
(`Browser.tsx`, `browser/*`, `browserView.cjs`, `browserCapture.cjs`,
`browserAgentServer.cjs`, `browserAgentActions.cjs`); the Editor scene family
(`EditorView.tsx`, `editor/*`, `FileTree.tsx`, `FileTabBar.tsx`,
`DocumentViewer.tsx`, `state/editor*.ts`, `state/browser.ts`, `state/chat.ts`,
`files.cjs`, `insideHome.cjs`).

Method: read every file in scope, ran the full unit-test gate, launched the
app under Playwright/xvfb and drove Terminal (sent a command, exercised
"New thread"/"Open raw session"), Browser (address bar, zoom/find popover,
bookmarks popover, capture panel), and Editor (opened a file from the Files
sidebar, exercised the toolbar) — zero console/pageerror events during the
walkthrough.

## Fixed

**Browser**

- `AddressBar.tsx` — removed the "DevTools" and "Page settings" `IconBtn`s.
  Both rendered with no `onClick` and no backing IPC/handler anywhere in
  `browserView.cjs` (`grep` confirmed) — permanently inert buttons.
- `CapturePanel.tsx` — removed the "raw HTML" disclosure toggle. `rawOpen`
  was flipped on click (chevron rotated) but no JSX ever read it — for text
  modes the raw text is already shown unconditionally in the `<pre>` block;
  for screenshot mode there's no captured HTML to disclose (`capture()` never
  fetches DOM text for `mode: 'shot'`). Dead state + dead button.
- `RecorderPanel.tsx` — deleted a byte-for-byte duplicate local `IconBtn` and
  imported the shared one from `browser-primitives.tsx` (the file's own
  purpose per its header comment). Minor visual side effect: disabled state
  now uses the shared `text-rule` + gains a `hover:text-fg` on enabled state,
  matching every other icon button in the Browser family.
- `AddressBar.tsx` — the address bar always rendered a hardcoded `https://`
  label regardless of the tab's actual scheme. `browserView.cjs`'s
  `normalizeUrl` force-upgrades navigation to https but explicitly allows
  falling back to plain `http://` on redirect, so a downgraded page showed a
  correctly-dimmed lock icon (`isSecure: false`) next to a false "https://"
  label. Added `schemeOf(url)` and render it instead of the literal string.
- `CapturePanel.tsx` — Screenshot mode routed into the picker/Capture-panel
  UI but `capture()` (browser.ts) ignores selectors entirely for
  `captureMode === 'shot'` (always captures the full view via `captureShot`).
  The panel nonetheless started the element picker, disabled the Capture
  button until an element was picked, and labeled it "— pick an element" —
  busywork with no effect, since whatever was picked never mattered. The
  captured-output footer also mislabeled the result `element · WxH · PNG`
  even though it's always the full view. Fixed: the picker no longer starts
  in shot mode, the button reads "Capture full page" and is enabled
  immediately, and the footer reads `full page · WxH · PNG`.
- `browserCapture.cjs` `captureSelection()` — the `a11y` and `agent` modes
  only ever queried `selectors[0]`, unlike `html`/`selector`, which already
  applied to the full `selectors` array — a real multi-select gap (⌘-click
  adds multiple picker selections; only the first was ever captured for
  those two modes, with no error/warning). Fixed to loop/map over all
  selectors and join results. No dedicated unit test exists for
  `captureSelection` itself (only its pure helpers — `filterTree`,
  `buildAgentCapture`, `formatA11yTree`, etc. — are covered in
  `tests/unit/browserCapture.spec.ts`); a `captureSelection`-level test needs
  a mocked Electron `webContents` + CDP debugger and is a reasonable
  follow-up, not added here.
- `state/browser.ts` `openTab()` — `window.api.browser.create(...)` failures
  were swallowed by an empty `.catch(() => {})`, leaving a tab in the strip
  with no backing native view (every subsequent navigate/show call would
  silently no-op). Now logs via `window.api.logs.write` on failure, matching
  the store convention documented on `capture()` ("stores don't import toast
  — background paths log instead").

**Editor**

- `FileTabBar.tsx`/`ImagePane.tsx` — doc comments updated: `FileTabBar.tsx`'s
  was stale (claimed "no dirty bit yet — the DocumentViewer doesn't edit"
  when the dirty dot has been wired for a while); `ImagePane.tsx`'s referenced
  a component (`DocumentViewer`) that turned out not to be the actual prior
  implementation being compared against.
  (Note: `DocumentViewer.tsx` itself is confirmed dead code — nothing under
  `src/renderer` imports it, `ProjectsWorkspace.tsx` wires `FileTree`'s
  `onPreviewFile` straight to `useEditor.openFile`/`EditorView` instead — but
  a concurrent job on this shared checkout committed `753b9f9 revert: restore
  DocumentViewer.tsx accidentally swept into prior commit` while this review
  was in progress. Left the file in place rather than re-deleting it into a
  second job's already-landed revert; flagged here instead as confirmed-dead,
  not-yet-removed.)
- `FileTree.tsx` `PREVIEWABLE_EXTS`/`isPreviewable` — hand-maintained a
  second, independent "can the Editor scene render this" extension set that
  diverged from the real source of truth (`editor.ts`'s `IMAGE_EXTS`/`isPdf`,
  which `EditorView.tsx` actually dispatches on). It omitted `pdf`, `ico`,
  `avif`, and `bmp`. Single-clicking any of those file types in the File
  Explorer fell through to `window.api.shell.open` and launched the OS's
  default viewer instead of the Editor scene's in-app `PdfPane`/`ImagePane` —
  those panes were unreachable from the tree (still reachable via terminal
  file-link opens). Fixed by reusing `IMAGE_EXTS` from `editor.ts` plus an
  explicit `pdf` check instead of a parallel hand-maintained set.
- `FileTree.tsx` `commitRename`/`commitCreate`/`confirmDelete` — CRUD
  failures only set local `error` state, rendered as a small red line at the
  top of the (possibly scrolled) tree with no timeout — easy to miss, and
  inconsistent with `EditorView.tsx`'s own `save()`, which correctly routes
  failures through `toast.error(...)`. Added `toast.error(msg)` alongside the
  existing inline banner for all three CRUD failure paths.
- `EditorView.tsx` — `loadState`/`reloadTokens` (keyed by file path) were
  never pruned by `closeFile`/`closeOthers`/`closeToTheRight`/`closeAll` —
  only the editor store's own `buffers`/`dirty`/`viewMode` got cleaned up.
  Not user-visible today (re-open re-derives correctly), but an unbounded
  leak for a long session that opens many files. Added `pruneClosed()` /
  `omitKeys()` and wired it into every close path.
- `CodeEditorPane.tsx` — deleted a local `extOf()` that was byte-identical to
  `state/editor.ts`'s exported `extOf`; imports the shared one now.
- `FileTree.tsx` — the two inline `name.toLowerCase().split('.').pop() || ''`
  extraction sites (`isPreviewable`, `getExtColor`) now go through the same
  shared `extOf` instead of re-deriving the extension per call site.

**Terminal**

- `chatRunner.cjs` `pump()` — queue-position broadcasts (`chat:run:queued`)
  were sent for every waiting job including silent (automated `/context`
  probe) runs, which should stay invisible to the renderer per the module's
  own doc comment (only silent jobs ever enter the `waiting` FIFO — manual
  runs bypass the queue per PRD 493). A queued probe would flip a tab's
  `running`/`queuedPosition` UI for a run the user never initiated. Fixed to
  skip the broadcast for `silent` jobs; covered by a new `chat-queue.test.cjs`
  case asserting zero `chat:run:queued` broadcasts for an all-silent queue.
- `TerminalChat.tsx` — question/stop-signal turns didn't render
  `ToolUseTraceStrip`, even though a run that stops with a clarifying
  question still accumulates `liveToolUses` (attached to the turn by
  `pushTurn`) — so a run's tool activity vanished from view whenever it
  ended in a question instead of a normal completion. Fixed. Also: the paste
  handler's clipboard-unavailable catch silently discarded the error instead
  of toasting (violates the "Toast is the user-facing error channel"
  convention used elsewhere in this file) — now calls `toast.error`; and
  "Open raw session"/its model-picker dropdown were clickable while a chat
  run was in flight — `Terminal.tsx` unmounts `TerminalChat` (and its only
  Cancel button) once a tab leaves `dormant`, so clicking either mid-run
  orphaned the running headless job with no way to see/cancel it. Both
  buttons are now `disabled={running}`, matching the existing "New thread"
  button.

## Not fixed — noted only (cross-family or out of scope)

- **Cross-family duplication (not touched, per task scope):** `MarkdownToolbar.tsx`
  (Monaco source-mode toolbar) and `TiptapBody.tsx`'s `ToolbarBtn` block define
  the same button set (Bold/Italic/H1-H3/lists/code/quote/link) by hand against
  two different editor backends (Monaco text-splice vs ProseMirror commands).
  The `apply` implementations genuinely can't merge, but the label/title/icon
  metadata could live in one shared table to stop them drifting independently.
  Left as-is — a bigger change than the confirmed bugs here justify.
- `MarkdownPreview.tsx` — `extractHeadings` and the `renderer.heading`
  override each maintain their own `seen: Map<string, number>` slug-dedup
  pass over the same token stream. They currently stay in lockstep (same
  iteration order), so `DocOutline`'s anchor links resolve correctly, but
  it's fragile duplicated logic rather than one shared slug-assignment pass.
  Left as-is — functioning correctly today, and consolidating risks a
  behavior change to `DocOutline` link resolution.
- `chatRunner.cjs`'s `/context` usage-probe (`probeContextUsage`,
  `chat:probe-context`, `chat:context-usage`) is fully implemented in main
  but has zero wiring in `preload/index.cjs` or the renderer — unreachable
  dead plumbing. Not touched: wiring it up is a new feature, not a bug in the
  existing surface.

## 2026-07-18 follow-up pass (headless-safe re-run, PRD 561 fix-plan)

The original interactive click-through pass above (this same file) already
landed the substantive fixes. This follow-up re-ran as a **headless-safe
static + unit-test pass** (no app launch, no Playwright) per the corrected
PRD: read every file in the family fresh, confirmed the prior fixes are
still in place (shared `extOf`/`IconBtn`, `pruneClosed` wiring, silent-queue
broadcast skip, `ToolUseTraceStrip` on question turns, real `schemeOf`
label), ran the full unit-test gate, and looked for anything new.

### Fixed

- `pty.cjs` `registerPtyHandlers()`'s `pty:kill` listener called
  `superagent.dropTab(tabId)` directly, immediately after `manager.kill(tabId)`
  — which already calls the same `dropTab(tabId)` internally (see `kill()`
  above it). Harmless (idempotent, map-delete-if-present) but redundant.
  Removed the duplicate call; `manager.kill()` remains the single call site.

### New findings — noted only, not fixed

- **`CapturePanel.tsx`'s pre-capture "Send to" segmented control (`dest`
  state / `DESTS` buttons) has no effect.** Selecting `claude`/`scratch`/
  `clip`/`prd` before capturing only toggles the button's own highlight —
  `onCapture`/`capture()` never read `dest`, and once a capture completes,
  all four destination buttons (`onClipboard`/`onClaudeSession`/`onScratch`/
  `onPrdFixture`) render unconditionally regardless of which one was
  pre-selected. Not a crash and not clearly wrong (the component's own header
  comment frames "destination tracking" as scaffolding for a future PRD that
  routes the Capture button straight to the picked destination), so left as a
  finding rather than a fix — resolving it either way (wire it up, or drop
  the pre-selection control) is a product decision, not a bug fix.
- **`browser:capture-dom` (`captureDom` in `browserView.cjs` + its preload/
  `api.d.ts` surface) is fully wired end-to-end but has zero callers.** It
  was superseded by the PRD-404 selection-scoped `capture`/`captureSelection`
  pipeline (`browserCapture.cjs`), confirmed via `grep -rn captureDom src/`
  turning up only the main handler, the preload bridge, and the type decl —
  no renderer call site, no test. Same class of dead plumbing as the
  already-documented `/context` probe above. Not removed here — deleting an
  IPC handler + preload API + type surface is a bigger structural change than
  a headless bounded pass should make unilaterally; flagged for a deliberate
  follow-up decision.
- Re-confirmed `DocumentViewer.tsx` is still fully orphaned (no importer
  anywhere under `src/renderer`) and still present, consistent with the note
  above about the concurrent revert. No change made.

### Verification run this pass

- `timeout 180 npm run typecheck` — clean, both as the pre-edit baseline and
  the post-edit final gate.
- Named specs, run with `node --test` (not `vitest run` — these `.cjs` files
  under `src/main/__tests__/` use Node's built-in test runner per their own
  file-header `Run:` comments; `vitest.config.ts`'s `include` list does not
  cover this directory except one unrelated scheduler file, so `vitest run
  <path>` reports "No test files found" for them): `chat-stop-signal.test.cjs`,
  `exchanges.test.cjs`, `files-reject-credentials.test.cjs` — 18/18 pass.
- Additional family specs discovered via the step-3 grep and actually
  relevant (import-checked, not just a substring hit on "Editor"/"Browser"):
  `tests/unit/chatRunner.spec.ts`, `tests/unit/ipc-pty.spec.ts`,
  `src/renderer/state/__tests__/editor.closeToTheRight.test.ts`,
  `src/renderer/lib/__tests__/browserExport.test.ts`,
  `tests/unit/pasteImageIntoChat.spec.ts` (vitest) — 63/63 pass.
  `src/main/__tests__/browserAgentServer.test.cjs`, `chat-queue.test.cjs`,
  `chat-cancel-terminal.test.cjs`, `chat-mcp-consent-notice.test.cjs`,
  `extractJson.test.cjs` (node --test) — 39/39 pass.

### Deferred to interactive session

A headless `claude -p` run cannot safely launch the Electron app or drive it
via Playwright (this project's own policy: session-manager's own app-launch/
e2e must not run as a scheduled job — a worktree doesn't fix it, since the
scheduler root is a fixed homedir path). The following needs a human (or a
locally-run, non-scheduled Playwright pass) to actually exercise:

- Terminal: send a chat command end-to-end, confirm streaming output +
  `ToolUseTraceStrip` render live, confirm "Cancel" actually interrupts a
  running `claude -p` child, confirm "Open raw session" correctly hands off
  to the live xterm PTY.
- Browser: click through AddressBar (back/forward/reload/bookmark/zoom/find
  popovers), ActionBar verbs (Capture/Record/Observe/Screenshot), the
  element picker's hover/click/⌘-click multi-select overlay inside a real
  embedded page, and the Recorder's record → replay round-trip against a
  live site.
- Editor: open files of every dispatched type (image/PDF/binary/CSV/JSONL/
  markdown in all four view modes/HTML preview/plain code) from the Files
  sidebar and from a terminal file-link, confirm autosave, confirm the
  close-guard modals actually block navigation away from unsaved edits, and
  confirm the Wysiwyg (Tiptap) round-trip doesn't corrupt frontmatter on a
  real file.

## Note on the working tree

This review ran in the same shared checkout as at least two other concurrent
scheduler jobs (Scheduler-family and Subagents-family reviews, evidenced by
untracked `session-manager-operations/reviews/scheduler-findings.md`,
modified `SchedulePanel.tsx`/`SchedulerHistoryView.tsx`/
`SchedulerPrdsView.tsx`/`sched-primitives.tsx`, and untracked
`tests/e2e/_scratch-subagents-review.spec.ts` /
`tests/e2e/scheduler-supervisor-panel.spec.ts`). None of that is part of this
family; it was left untouched and unstaged so the other jobs can commit their
own work independently.
