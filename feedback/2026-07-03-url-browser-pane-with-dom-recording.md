---
title: Render URL targets in the text viewer/editor as an embedded browser pane, with a DOM-recording toggle
source: bilko (via burrow session, 2026-07-03)
type: enhancement
severity: normal
---

# What happens / what's missing

The session-manager text viewer/editor only renders local files. Bilko's directive
(2026-07-03): when the target is a **URL**, render it as an embedded browser pane
(Electron `<webview>`/`WebContentsView`) — "that way the utility will be inside the
session-manager." The utility in question is a **DOM interaction recorder**: while the
operator clicks/scrolls in the embedded page, every interaction is captured as a
structured trace an agent can later turn into automation.

Context: Burrow just shipped the CLI version of this recorder (Burrow PRD 358,
`scripts/dom_record.py` — attaches over CDP to Burrow's headed Chromium) and a
recording→selectors translator (PRD 359, `scripts/dom_recording_analyze.py`). First
consumer: rebuilding Facebook reels comment capture (PRD 360) from an operator
demonstration. Bilko wants this capability inside session-manager as a first-class UI
rather than a CLI.

# Evidence

- Burrow's recorder schema + docs: `~/Projects/burrow/app/shared/dom_recorder_js.py`
  (injected listener: click/scroll/keydown-identity events with aria-label, role, ranked
  CSS paths, scroll-container descriptors) and `~/Projects/burrow/docs/dom-recorder.md`
  (JSONL format, one event per line + header line). Reuse this schema **verbatim** — the
  translator and any agent consuming recordings must not care which tool produced them.
- Recordings land in `~/Projects/burrow/downloads/dom-recordings/<name>-<ts>.jsonl`
  today; a session-manager-produced recording should be saveable to a user-chosen path
  with that same default offered when the flow relates to a Burrow task.

# Ask

1. **URL targets in the viewer/editor:** opening a `http(s)://` target renders an
   embedded browser pane (persistent session partition so logins survive restarts)
   instead of a text buffer. Address bar + back/forward is enough chrome.
2. **Record toggle:** a Record button injects the shared listener (same event schema as
   Burrow's `dom_recorder_js.py` — port it, don't fork the field names) via webview
   preload; Stop writes the JSONL and shows the saved path. Never capture typed text or
   anything on `input[type=password]`; key events log key identity (Enter/Escape/Tab)
   only.
3. **Handoff affordance:** after Stop, offer "copy path" so the operator can hand the
   recording to an agent (e.g., Burrow's `dom_recording_analyze.py` report).

Acceptance sketch: open a URL in the viewer → Record → click around, scroll an inner
container → Stop → JSONL exists with events whose descriptors include aria-label/role +
scroll-container identity; a password field typed into leaves zero events.

# Notes / boundaries

- The embedded pane runs its **own** browser session — it does NOT share Burrow's headed
  Chromium profile. For flows requiring Burrow's logged-in identity, Burrow's CLI
  recorder remains the tool; this pane covers everything else (and FB works after a
  one-time login inside the pane). Both produce the same JSONL, so downstream tooling is
  agnostic.
- Cross-references: Burrow PRDs 358 (CLI recorder, completed 2026-07-03), 359
  (translator), 360 (reels capture consumer).
