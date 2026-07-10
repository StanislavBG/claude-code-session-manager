# Browser Tab — Pre-Design Feature Spec

> **Status:** Pre-design brainstorm / input to designer
> **Author:** Bilko (via Claude Code)
> **Date:** 2026-07-09
> **Audience:** Product designer, then /develop for PRD decomposition
> **One-liner:** An embedded, agent-aware web browser inside Session Manager so you never leave the tool to capture DOM, record click-sequences, or hand a live page to Claude Code.

---

## 1. Why a Browser Inside Session Manager

Session Manager is the local cockpit for Claude Code. Today, whenever a task needs the web — grab a page's DOM, reproduce a bug flow, record a click path for an e2e test, capture a selector — you leave the tool, use Chrome + DevTools, then copy-paste back. That context switch is the whole friction.

A **Browser tab** closes the loop:

1. **DOM Capture** — point at any live page and export a filtered, agent-ready DOM / accessibility snapshot straight into a Claude Code session or a scratch file.
2. **Click-sequence recording** — record a real interaction once, replay it, and emit it as a Playwright spec, a step list, or a scheduler PRD fixture.
3. **Agent-in-the-loop browsing** — let a Claude Code session drive or observe the page (the agentic-browser pattern), gated by the same permission model the rest of the app uses.

This is *not* trying to out-browse Chrome. It is a **developer surface**: the browser exists to feed the agent and the test harness, matching the "nav items = micro-services" and "extend, don't add tabs unnecessarily" principles — this is a genuinely new capability, not a duplicate of an existing tab.

---

## 2. Competitive Research — AI Browser Landscape (2026)

The market has split into three camps. Sources at the end.

| Browser | Camp | Signature capability | Relevant-to-us takeaway |
|---|---|---|---|
| **Perplexity Comet** | Agentic leader | Autonomous multi-step tasks (book flights, manage email, checkout); uses **raw DOM + accessibility tree**, not screenshots | Their DOM pipeline (filter → prune → summarize → chunk) is *exactly* the DOM Capture spec we need |
| **ChatGPT Atlas** | Agentic leader | **Agent Mode** — opens tabs, clicks, fills forms while narrating; permission-gated; cannot run code / download / read passwords | Their permission + narration UX is the safety model to copy |
| **Dia (The Browser Company)** | Agentic + workflow | **Record a workflow once, replay with different inputs**; "skills" scoped to tabs; memory tied to tabs not blanket history | This is our click-sequence recorder, validated as a headline feature |
| **Arc Max** | Assistant | Sidebar chat, tab summaries, cleaner org | Lower ambition; not our model |
| **Brave Leo** | Assistant / privacy | Local models, privacy-safe execution | Privacy posture worth noting for our local-first ethos |
| **Edge + Copilot** | Assistant | Built-in chat/summarize | Not our model |

**Cross-cutting 2026 themes:**
- **Agentic browsing** — read tabs, summarize, execute multi-step tasks. Every serious contender ships some form.
- **DOM over screenshots** — Comet reads roles/ARIA/labels/states for precise interaction. Faster, cheaper context, but blind to unlabeled `<img>`/SVG/icons and cross-origin iframes. **Design implication:** we should offer *both* DOM snapshot and screenshot capture so the agent isn't blind to non-semantic UI.
- **Permission + narration** — Atlas asks before acting and narrates each step; can't touch passwords/filesystem/downloads. Users trust agents only when they can watch and interrupt.
- **Workflow record/replay** — Dia's differentiator. Record once, parameterize inputs, replay. Directly maps to our test-fixture / click-sequence goal.
- **Persistent memory** — tied to tabs/skills rather than blanket history (Dia's more privacy-conscious take).

### What we borrow vs. skip
- **Borrow:** Comet's DOM filter/prune/summarize/chunk pipeline; Atlas's permission-gated, narrated agent actions; Dia's record-once/replay-with-inputs.
- **Skip (for MVP):** consumer concierge tasks (book flights, checkout, price hunting), cross-session browsing memory, ad-blocking / general-purpose browsing polish. We are a dev tool, not a daily driver.

---

## 3. Our Version — Feature Set

Tiered so the designer knows what is MVP vs. aspirational, and so /develop can slice PRDs.

### Tier 0 — Baseline browser (table stakes)
- Embedded Chromium view (Electron `WebContentsView`/`<webview>`), address bar, back/forward/reload/stop, page title.
- Multiple in-tab browser sub-tabs (lightweight tab strip *inside* the Browser Session Manager tab).
- Basic history + bookmarks (local, per the `config.cjs` fs layer + `validatePath`).
- Zoom, find-in-page, devtools toggle.
- Respects app navigation lock philosophy: external nav sandboxed to the embedded view, never the app shell.

### Tier 1 — DOM Capture ⭐ (signature)
The reason this tab exists. Point → capture → hand to agent.
- **Element picker** — hover to highlight, click to select; `Cmd/Ctrl+Click` multi-select; `Enter` to finish (Factory/DevTools-style overlay).
- **Capture modes:**
  - *Full DOM snapshot* — outer HTML of selection or whole page.
  - *Agent-ready DOM* — Comet-style pipeline: **filter** (interactive/task-relevant elements only) → **prune** (drop scripts/styles/hidden) → **summarize** (flatten hierarchy, group by ARIA landmark) → **chunk** (split large DOM).
  - *Accessibility tree* — roles, ARIA attributes, labels, states for the selection.
  - *Computed selector* — robust CSS + XPath + ARIA/role selector for the picked element (for test authoring).
  - *Screenshot* — element or full-page PNG (covers the non-semantic `<img>`/SVG/iframe blind spot Comet has).
- **Destinations:** copy to clipboard · save to scratch file · **push into an active Claude Code session** as context · attach to a scheduler PRD fixture.

### Tier 2 — Click-Sequence Recorder ⭐ (signature)
Dia's record-once model, aimed at test authoring & repro.
- **Record** — capture real user interactions (navigate, click, type, select, scroll, wait-for) as an ordered step list with robust selectors.
- **Annotate** — per-step description, expected result, assertions.
- **Parameterize** — mark inputs as variables (record once, replay with different data).
- **Replay** — run the sequence back in the embedded view, step or continuous, with pass/fail per step.
- **Export targets:**
  - **Playwright spec** (`tests/e2e/*.spec.ts`) — first-class, matches our existing harness.
  - Step list / markdown (human repro).
  - **Scheduler PRD fixture** — feed a recorded flow into a `claude -p` job.
- Guardrail: recorder must never emit self-e2e jobs against the live scheduled-plans dir (see project memory `no-schedule-self-e2e`).

### Tier 3 — Agent-in-the-loop browsing (aspirational)
The agentic-leader pattern, permission-gated.
- **Observe mode** — an active Claude Code session reads the current page (auto DOM Capture on navigation) as live context.
- **Act mode** — the agent proposes actions (click X, fill Y); **each action is permission-gated and narrated** before execution (Atlas model). Hard stops: no filesystem, no downloads, no saved-password access from the page context.
- **Logged-in vs logged-out** run modes (reuse existing session cookies vs. clean context), user-selected per run.
- Reuses the app's existing permission surface — do **not** invent a second one.

---

## 4. Pixel Mock (ASCII wireframes — input to designer)

### 4.1 Browser tab, default state
```
┌──────────────────────────────────────────────────────────────────────────────┐
│  LeftNav │  ┌───────────────────────────────────────────────────────────────┐ │
│  ...     │  │ [+] ▸ example.com ×  │ docs.page ×  │ + │        Browser        │ │
│  Browser │  ├───────────────────────────────────────────────────────────────┤ │
│  ◀ ●     │  │ ◀  ▶  ⟳  ⌂ │ 🔒 https://example.com/pricing        │ ⤓ ⧉ ⚙  │ │
│  ...     │  ├───────────────────────────────────────────────────────────────┤ │
│          │  │                                                                 │ │
│          │  │                    [ live web page render ]                     │ │
│          │  │                                                                 │ │
│          │  │                                                                 │ │
│          │  ├───────────────────────────────────────────────────────────────┤ │
│          │  │  ⛶ Capture DOM   ⏺ Record   👁 Observe   📷 Screenshot         │ │
│          │  └───────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```
Bottom action bar = the "this is a dev browser, not Chrome" tell. Four verbs: Capture DOM · Record · Observe · Screenshot.

### 4.2 DOM Capture — element picker active
```
┌───────────────────────────────────────────────────────────────┐
│ ◀ ▶ ⟳ │ 🔒 example.com/pricing         │  ⛶ PICKING… (Esc)    │
├───────────────────────────────────────────┬───────────────────┤
│                                           │  CAPTURE           │
│   ┌───────────────────────────────┐       │  ┌──────────────┐  │
│   │  Pro Plan     $20/mo   ╔═════╗ │◀─hover│  │ button.btn-  │  │
│   │                        ║ Buy ║ │highlt │  │  primary     │  │
│   │                        ╚═════╝ │       │  └──────────────┘  │
│   └───────────────────────────────┘       │  Mode:             │
│                                           │  ◉ Agent-ready DOM │
│   selected: 1 element   ⌘+click = multi   │  ○ Full HTML       │
│                                           │  ○ A11y tree       │
│                                           │  ○ Selector (CSS/  │
│                                           │     XPath/ARIA)    │
│                                           │  ○ Screenshot      │
│                                           │ ───────────────    │
│                                           │  Send to:          │
│                                           │  ▸ Claude session  │
│                                           │  ▸ Scratch file    │
│                                           │  ▸ Clipboard       │
│                                           │  ▸ PRD fixture     │
│                                           │  [  Capture  ]     │
└───────────────────────────────────────────┴───────────────────┘
```

### 4.3 Agent-ready DOM output (right panel, post-capture)
```
  Filter → Prune → Summarize → Chunk       ✓ 1 of 1 chunk · 412 tok
  ┌─────────────────────────────────────────────────────────┐
  │ <region aria-label="Pro Plan">                          │
  │   <heading level=3>Pro Plan</heading>                   │
  │   <text>$20/mo</text>                                   │
  │   <button name="Buy" data-testid="buy-pro">Buy</button> │
  │ </region>                                               │
  └─────────────────────────────────────────────────────────┘
  [ Copy ]  [ → Claude session ]  [ Save .txt ]   raw HTML ⌄
```

### 4.4 Click-Sequence Recorder
```
┌──────────────────────────────── Recording ● 00:42 ──────────────────────────┐
│  Steps                                          │  Step detail               │
│  1 ▸ navigate  example.com/login                │  Step 3 — type             │
│  2 ▸ click     #email                           │  selector: input#password  │
│  3 ▸ type      input#password   ●var: pw        │  value:  ●●●●●●  → {{pw}}   │
│  4 ▸ click     button[type=submit]              │  ☑ parameterize as {{pw}}  │
│  5 ▸ wait-for  text="Dashboard"                 │  expect: field accepts     │
│                                                 │  assert: ▸ url contains    │
│  ⏺ recording…  ⏸  ⏹  │  ▶ Replay  ⏭ step       │        /dashboard          │
├─────────────────────────────────────────────────┴────────────────────────────┤
│  Export ▸  Playwright spec   ·   Markdown steps   ·   PRD fixture             │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 4.5 Observe / Act mode (agent-in-the-loop)
```
┌──── page render ────────────────┐  ┌─── Claude session (live) ──────────┐
│                                 │  │ 👁 Observing example.com/pricing    │
│   [ pricing table ]             │  │ DOM auto-captured (412 tok)         │
│                                 │  │                                     │
│                                 │  │ Agent wants to:                     │
│                                 │  │   click  button[data-testid=buy-pro]│
│                                 │  │   ┌─────────────────────────────┐   │
│                                 │  │   │ Allow  ·  Allow all  ·  Deny │   │
│                                 │  │   └─────────────────────────────┘   │
│                                 │  │ Mode: ◉ logged-in  ○ logged-out     │
└─────────────────────────────────┘  └─────────────────────────────────────┘
```

Design language: follow the **Almanac** shell already used app-wide (per project memory — TerminalChat was the last holdout). Bottom action bar and side capture panel should read as the same family as the Scheduler/Subagents cockpits.

---

## 5. Technical Notes (for architecture, not for the designer)

- **Embed:** Electron `WebContentsView` (successor to `BrowserView`) layered over the React renderer, or `<webview>` if we need it inline in the DOM flow. `WebContentsView` gives cleaner z-ordering + isolation and is the current-Electron path.
- **DOM/a11y extraction:** run in the guest page context via `webContents.executeJavaScript` / the debugger protocol (`Page`, `DOM`, `Accessibility` CDP domains). The filter/prune/summarize/chunk pipeline lives in main (`.cjs`) or a preload bridge, not the renderer.
- **Recorder:** capture input events via CDP `Input`/`DOM` domains or an injected content script; selector generation should prefer `data-testid` → ARIA/role → CSS → XPath (fallback chain) for stable replays.
- **Security:** all captured files route through `config.cjs` `writeTextAtomic` + `validatePath` (allowedRoots = home). Guest page gets no Node integration, strict `contextIsolation`. Agent Act-mode reuses the existing IPC permission gate — no second auth surface. Never expose saved passwords / filesystem to the guest context (Atlas rule).
- **Reuse:** IPC schemas via `ipcSchemas.cjs` (zod at the boundary); Playwright export should target the existing `tests/e2e` conventions; PRD fixture export must honor `PRD_AUTHORING.md` guardrails and the `no-schedule-self-e2e` rule.
- **Playwright already vendored** in this repo (MCP + e2e harness) — the recorder's replay/verify engine can lean on the same primitives rather than a new dependency.

---

## 6. Open Questions for the Designer

1. **Tab-in-tab model** — do browser sub-tabs live as a strip inside the Browser Session Manager tab, or do we reuse the app's main tab bar? (Recommend inside, to keep the app tab bar for cockpit destinations.)
2. **Capture-to-session UX** — when "Send to Claude session" has 0 or >1 active sessions, how do we pick the target? (Picker vs. active-tab default.)
3. **Recorder assertion depth** — MVP = url/text assertions only, or full attribute/network assertions from step one?
4. **Observe-mode aggressiveness** — auto-capture DOM on every navigation (rich context, more tokens) vs. capture-on-demand?
5. **How much baseline browser polish** — is Tier 0 a real browsing experience, or deliberately minimal (capture-first, browsing-second)?
6. **Screenshot vs DOM default** — which capture mode is the default click, given DOM is cheaper but blind to non-semantic UI?

---

## 7. Suggested MVP Cut (for /develop slicing)

- **PRD 1** — Tier 0 embedded `WebContentsView` browser: address bar, nav controls, in-tab sub-tabs, devtools toggle. No AI.
- **PRD 2** — DOM Capture: element picker overlay + full-HTML + selector capture → clipboard/scratch file.
- **PRD 3** — Agent-ready DOM pipeline (filter/prune/summarize/chunk) + a11y tree + screenshot; "Send to Claude session" destination.
- **PRD 4** — Click-Sequence Recorder: record/annotate/replay + Playwright export.
- **PRD 5** — Observe/Act agent-in-the-loop with permission-gated, narrated actions.

Tiers 0–2 (PRDs 1–4) are the honest MVP — the DOM Capture + recorder value the tab was requested for. Tier 3 is the stretch.

---

## Sources

- [Perplexity Comet — official](https://www.perplexity.ai/comet) · [Comet (Wikipedia)](https://en.wikipedia.org/wiki/Comet_(browser))
- [Reverse-engineering Comet — DOM/a11y pipeline (Harness)](https://www.harness.io/blog/reverse-engineering-comet)
- [Introducing ChatGPT Atlas (OpenAI)](https://openai.com/index/introducing-chatgpt-atlas/) · [Ask ChatGPT sidebar & Agent on Atlas](https://help.openai.com/en/articles/12628199-using-ask-chatgpt-sidebar-and-chatgpt-agent-on-atlas)
- [AI Browser Landscape 2026: Atlas vs Comet vs Arc vs Dia (Digital Applied)](https://www.digitalapplied.com/blog/ai-browser-landscape-2026-atlas-comet-arc-dia)
- [Agentic Browsers: Atlas, Comet, Dia & WebMCP (Tandem)](https://usetandem.ai/blog/agentic-browsers-atlas-comet-dia-webmcp)
- [AI Browsers Reviewed 2026: Comet vs Dia vs Edge Copilot (llmx)](https://llmx.tech/blog/ai-browsers-reviewed-2026-comet-vs-dia-vs-the-rest/)
- [Browser Automation — pick tool / element picker (Factory docs)](https://docs.factory.ai/guides/skills/browser)
- [Building a Chrome extension that records & replays web interactions (Medium)](https://djajafer.medium.com/building-a-chrome-extension-that-records-and-replays-web-interactions-11a548271125)
