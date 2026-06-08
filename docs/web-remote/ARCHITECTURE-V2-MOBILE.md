# Web Remote v2 — Mobile Cockpit (Design)

Supersedes the device-centric v1 UX (PRDs 07–10) with a **session-centric** mobile
app. v1's relay/agent/auth security work is reused; the UX, transport host, auth
source, and three net-new features (session-state, mobile summary, voice) are new.

Status: **design — pending build**. Companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md)
(the v1 ADR; still authoritative for threat model, token storage, rate limits, audit log).

## 0. Locked decisions (2026-06-07)

| Decision | Choice | Consequence |
|---|---|---|
| **App hosting** | `static-path` sibling at `bilko.run/projects/session-manager/` | Published via Bilko repo drop + dual-push (or `bilko-host` MCP). No DNS/Render/OAuth for the app. Must pass host gates incl. **200 KB gz budget**. |
| **Relay hosting** | **Same-origin** on bilko.run Fastify — `wss://bilko.run/projects/session-manager/relay` | Covered by host `connect-src 'self'` → survives CSP enforcement. No extra Render svc / DNS / OAuth app. Relay shares host uptime. |
| **Browser auth** | Reuse bilko.run **Clerk** (replaces v1 Google-OAuth-in-relay) | The relay route runs inside the host, so `requireAuth(req)` is available. Pairing ties a Clerk user → device. |
| **Voice** | Browser **Web Speech API** (`SpeechRecognition`) → text → `cmd:pty:write` | `Permissions-Policy: microphone=(self)` is live on bilko.run. No audio over the wire. iOS Safari is best-effort. |
| **Mobile summary** | **Local agent + Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) → pushed to phone | Desktop transcript unchanged. Needs an Anthropic API key on the local machine (separate from OAuth billing). |

## 1. Topology

```
┌─────────────┐   Clerk-authed WSS        ┌──────────────────────────┐   device WSS    ┌───────────────────┐
│  Phone      │ ────────────────────────▶ │  bilko.run (Fastify)     │ ──────────────▶ │ Local Session Mgr │
│ /projects/  │   wss://bilko.run/        │  • static: /projects/    │   (paired,      │ webRemote.cjs     │
│ session-    │   projects/session-       │      session-manager/    │    token-auth)  │  • transcripts    │
│ manager/    │   manager/relay           │  • relay WS route        │                 │  • pty            │
│ (Web Speech)│ ◀──────────────────────── │  • pair REST (Clerk)     │ ◀────────────── │  • Haiku summary  │
└─────────────┘   state/summary push      └──────────────────────────┘   events        └───────────────────┘
```

Three units:
1. **App** — `web-remote/app`, rebuilt mobile-first, base `/projects/session-manager/`, drops into Bilko `public/projects/session-manager/`.
2. **Relay route** — the v1 `web-remote/relay` router logic remounted as a Fastify WS route **inside the Bilko repo** (`server/routes/sm-relay.ts`), auth via host Clerk instead of standalone Google OAuth. Keeps v1 rate-limit / audit-log / canRoute logic.
3. **Local agent** — `src/main/webRemote.cjs`, extended with state + summary push and Anthropic key resolution; relay URL repointed to bilko.run.

## 2. Auth & pairing (Clerk-based)

- Browser hits `/projects/session-manager/` → app calls `GET /api/sm-relay/me` → host `requireAuth` returns Clerk email or 401 → app shows Clerk sign-in (host chrome) if needed.
- **Pair a device**: app calls `POST /api/sm-relay/pair/start` (Clerk-authed) → relay returns a 6–8 digit OTP (TTL 90s, single-use — v1 §3.2 properties retained). User types OTP into the local Session Manager's Web Remote tab → local agent calls `POST /api/sm-relay/pair/claim {otp, devicePubKey}` → relay binds `{clerkUserId → deviceId}` and returns a long-lived device token (stored locally 0600, v1 §4).
- **WS auth**: browser presents Clerk session (cookie, same-origin) + relay issues a short-lived WS ticket; device presents its device token. `canRoute(browser, device)` requires `browser.clerkUserId === device.clerkUserId` (v1 §router, unchanged logic, key swapped from `userId`→`clerkUserId`).

## 3. Protocol additions

v1 envelope unchanged (`{type,id,deviceId?,payload?,ts,relay_ts?}`). New message types:

### Device → browser (events, pushed)
| Type | Payload | Source (single source of truth) |
|---|---|---|
| `event:session:list` | `{ sessions: SessionMeta[] }` | reuse `cmd:sessions:load` data + live add/remove |
| `event:session:state` | `{ tabId, state: 'idle'\|'thinking'\|'running'\|'awaiting-input'\|'error', since }` | derived from `transcripts.cjs` ring-buffer event classification + pty activity — **no new classifier**, reuse `classifyLine` |
| `event:session:summary` | `{ tabId, summary, ofMessageId, model, ts }` | Haiku summary of the last assistant message (see §4) |

`SessionMeta = { tabId, cwd?, title?, startedAt?, state, lastSummary? }` — extends v1 `SessionRecord`.

### Browser → device (commands, allowlisted in relay)
| Type | Payload | Maps to |
|---|---|---|
| `cmd:session:subscribe` | `{ tabId }` | agent starts pushing state+summary for that tab |
| `cmd:session:unsubscribe` | `{ tabId }` | stop pushing |
| `cmd:pty:write` | `{ tabId, data }` | **existing** — voice text and typed follow-ups both route here |

All new `cmd:*` added to the relay allowlist (v1 §6.2). Forbidden set (v1 §6.3) unchanged.

## 4. Mobile summary (local agent + Haiku)

- Trigger: on each `event:transcript` that classifies as an assistant turn **completing** (not mid-stream), for any subscribed tab.
- The agent takes the final assistant message text, calls Claude **Haiku 4.5** with a fixed system prompt: *"Summarize this Claude Code assistant turn for a phone screen in ≤2 sentences + an optional ≤3-item action list. Plain text, no markdown headers."*
- Debounce 1.5s + skip if message < 280 chars (push raw). Cache by `ofMessageId` so re-subscribe doesn't re-bill.
- **Key resolution**: `ANTHROPIC_API_KEY` env → else `~/.claude/web-remote.json` `anthropicApiKey` field (0600) → else feature degrades to **raw last message** (no summary) and the app shows a "set API key" hint. (Mirrors the cycle-3 Files-API key-resolution note in CLAUDE.md.)
- Implementation will consult the `claude-api` skill for exact params/pricing before writing the call. Cost is ~Haiku input+output per completed turn per subscribed tab; only subscribed tabs summarize.

## 5. Voice (Web Speech)

- Mic button in pane 3. `new webkitSpeechRecognition()` (or `SpeechRecognition`), `interimResults` for live caption, `lang` from browser.
- On final result → show editable text → user confirms (or auto-send after 1.2s idle, reusing the desktop voice store's auto-submit pattern conceptually) → `cmd:pty:write {tabId, data: text + '\n'}`.
- Graceful fallback: if `SpeechRecognition` undefined (iOS Safari often), show a text input instead. No audio leaves the browser.
- Privacy: a visible recording indicator whenever the mic is live (mirrors the desktop `RecordingStatus` invariant in spirit).

## 6. UI / UX

Mobile-first, single column. Shell = collapsible **left-nav** + **3-pane main**.

```
┌───────────────────────────────┐
│ ☰  Session Manager      ● live │  top bar: hamburger toggles left-nav, conn dot
├──────────┬────────────────────┤
│ LEFT-NAV │  PANE 1: STATE      │  ← state chip + minimal busy animation
│ (drawer) │   ◐ thinking… 0:12  │     (idle/thinking/running/awaiting/error)
│          ├────────────────────┤
│ ▸ proj-a │  PANE 2: SUMMARY    │  ← mobile summary of last assistant message
│   ● s-1  │   "Refactored the   │     (scrollable; tap → expand to raw)
│   ◐ s-2  │    reaper; 2 tests…"│
│ ▸ proj-b │                     │
│   ● s-3  ├────────────────────┤
│          │  PANE 3: MIC/INPUT  │  ← 🎤 hold-to-talk + text fallback + send
└──────────┴────────────────────┘
```

- **Left-nav**: sessions grouped by `cwd` (project), **dynamically expanding** — groups collapse/expand, live sessions sort first, per-session state dot. Tapping a session selects it + sends `cmd:session:subscribe`. This is the "one source, N display sites" rule: session list comes from `event:session:list` only.
- **Pane 1 (state)**: a small animated indicator — `idle` (still dot), `thinking` (slow pulse/orbit), `running` (progress shimmer), `awaiting-input` (amber blink), `error` (red). Honor `prefers-reduced-motion` (a11y gate). Minimal, no heavy lib — CSS keyframes only.
- **Pane 2 (summary)**: the Haiku summary; tap to expand to raw last message; auto-updates on `event:session:summary`.
- **Pane 3 (mic)**: Web Speech mic + text fallback → `cmd:pty:write`.

Desktop app view: **unchanged** (summary only affects the pushed mobile payload, never the local transcript).

## 7. Budget & gates (200 KB gz)

- **Drop xterm from the default bundle.** The full terminal pane is v1's biggest weight (~250 KB). v2's main flow is summary + mic + state, none of which need xterm. If a raw-terminal view is still wanted, lazy-load it behind a route so it's out of the initial budget.
- Keep deps minimal: react, react-dom, zustand. No xterm in the critical path.
- Emit `dist/manifest.json` via `scripts/emit-manifest.mjs` (host-contract §Manifest). `golden.path = /projects/session-manager/`, `golden.expect = "Session Manager"`.
- Add `tests/golden.spec.ts` (Playwright) + ensure axe-core clean (reduced-motion honored) + `pnpm audit` clean.

## 8. Build sequence (proposed PRDs)

1. **SM-V2-01 — Relay-on-host**: remount v1 relay router as Fastify WS route in Bilko (`server/routes/sm-relay.ts`) + Clerk auth + pair REST. Reuse v1 rate-limit/audit/canRoute.
2. **SM-V2-02 — Agent protocol**: add `event:session:state`, `cmd:session:(un)subscribe`; derive state from `transcripts.cjs` (reuse `classifyLine`); repoint relay URL to bilko.run.
3. **SM-V2-03 — Summarizer**: Haiku summary push + key resolution + debounce/cache (consult `claude-api` skill).
4. **SM-V2-04 — App shell**: base path, Clerk sign-in, left-nav + 3-pane, zustand store from `event:session:list`. Drop xterm.
5. **SM-V2-05 — State animation + summary pane**: CSS-only indicators, reduced-motion, summary render/expand.
6. **SM-V2-06 — Voice**: Web Speech mic + text fallback + recording indicator.
7. **SM-V2-07 — Publish**: manifest + golden + a11y + budget; register `static-path` in `standalone-projects.json`; drop `dist/` → Bilko; dual-push; verify live.

## 9. Risks / open items

- **Relay coupling to host uptime** — accepted (decision §0). If bilko.run is down, remote control is down.
- **Clerk on a static-path page** — host contract says static-path gets "nothing", but our relay route lives *in* the host so it can call `requireAuth`; the app reads Clerk session same-origin. Verify Clerk's client SDK is reachable from `/projects/*` (it's in host `script-src`).
- **CSP currently report-only** — don't rely on it; design already assumes enforced (`connect-src 'self'` covers same-origin relay).
- **iOS Safari Web Speech** — unreliable; text fallback is mandatory, not optional.
- **200 KB budget** — must be guarded in CI; dropping xterm should clear it with headroom.
- **Anthropic key** — summary degrades gracefully to raw message if absent; never blocks core remote control.
