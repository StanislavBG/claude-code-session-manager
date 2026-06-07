# Web Remote — Architecture Decision Record

**Status**: Accepted  
**Decision scope**: PRDs 07–10  
**Date**: 2026-06-06  
**Author**: Bilko (headless claude -p, ADR 06)

This document is the load-bearing design reference for the web remote control
channel. Build PRDs 07–10 defer protocol and library specifics here; read this
before authoring or executing any of those PRDs.

---

## 0. Context and invariants

session-manager is a deliberately local Electron app. The CLAUDE.md codifies
several hard invariants that this design must preserve:

- No inbound internet traffic on the local machine. The agent connects
  **outbound** only.
- All filesystem access goes through `validatePath` in `src/main/config.cjs`,
  which rejects paths outside `allowedRoots` (home dir) and resolves symlinks
  before checking.
- All IPC payloads are validated by zod schemas in `src/main/ipcSchemas.cjs`
  before reaching any handler.
- `setWindowOpenHandler` denies all new windows; `will-navigate` allows only
  the Vite dev URL (`src/main/index.cjs`). The navigation lock must not be
  relaxed for the remote channel.
- Remote control is **OFF by default**. Every opt-in is explicit and local.

---

## 1. Threat model

### 1.1 Assets

| Asset | Value |
|---|---|
| Local shell (pty) | Full command execution on the user's machine |
| Local filesystem (via `validatePath`) | All files under `$HOME` |
| Claude credentials (`~/.claude/.credentials.json`) | Billable API access |
| Scheduler PRDs | Automated workload definitions |
| Session transcripts | Conversation content |

### 1.2 Trust boundaries

```
[Google Identity Provider]
         │  OAuth token
         ▼
  ┌──────────────┐   TLS    ┌──────────────────────────┐   TLS    ┌──────────────┐
  │  Browser     │◄────────►│  Relay (Render)           │◄────────►│  Local agent │
  │  (web app)   │          │  (user's own Render acct) │          │  (Electron)  │
  └──────────────┘          └──────────────────────────┘          └──────────────┘
                                    ▲
                             routes by userId
                             (no device tokens)
```

**Boundary 1**: Browser ↔ Relay — authenticated by Google-issued session token
(verified by the relay). The relay strips the token after verification; it is
never forwarded to the agent.

**Boundary 2**: Agent ↔ Relay — authenticated by a device token issued at
pairing time. The relay verifies the token on every connection upgrade. The
browser never sees device tokens.

**Boundary 3**: Relay ↔ local IPC — the relay does NOT have a direct IPC
connection. The local agent receives a relay message, validates it against the
allowlist + zod schema, then calls the relevant IPC handler internally. The
relay cannot bypass this.

### 1.3 Actors and capabilities

| Actor | Can do | Cannot do |
|---|---|---|
| **Relay operator** (user's own Render account) | Read plaintext message payloads in transit (no E2E in v1); observe routing metadata (userId, deviceId, message types); drop or delay messages | Issue commands — has no device tokens; forge `userId` routing — relay enforces same-user constraint at the routing layer; bypass local zod validation |
| **Network attacker** (on path between browser/agent and relay) | Observe encrypted bytes | Decrypt (TLS mandatory); inject messages (no valid auth token) |
| **Stolen device token** (file leaked from `~/.claude/session-manager/web-remote.json`) | Connect to the relay as that device; receive commands; stream PTY output | Issue commands autonomously — commands must originate from an authenticated browser session belonging to the correct `userId`; gain shell access without a paired browser session |
| **Compromised web session** (stolen session cookie or XSS) | Send commands to paired devices owned by that `userId`, subject to the command allowlist and rate limits | Execute arbitrary shell commands — `app:test-fire-hook` and `watchers:add` are not on the allowlist; write arbitrary files — `config:write-json/text` are not on the allowlist; access devices belonging to other users |
| **Local user** | Everything — they own the machine and the credentials | — |

### 1.4 What full relay compromise enables

An attacker who fully controls the relay (including its memory and network) can:

- **Read** all command payloads and PTY output streams in transit (no E2E in v1).
- **Drop or delay** messages, causing UX degradation.
- **Observe** which devices are connected and when.

An attacker who fully controls the relay **cannot**:

- Issue commands to a device without also controlling a valid browser session
  authenticated to the correct `userId`, because the routing rule is enforced
  by the relay's own session table — and the agent additionally validates every
  incoming command against the local allowlist and zod schemas regardless of
  relay trust.
- Access the local filesystem or shell directly — there is no direct relay →
  local connection; the agent mediates everything.
- Escalate to arbitrary-code execution — the command allowlist and IPC schemas
  are enforced locally, not by the relay.

The primary residual risk from a compromised relay is **confidentiality** of
PTY output and command content. This is addressed in PRD 10 (E2E encryption —
see §5).

---

## 2. Relay protocol

### 2.1 Message envelope

Every WebSocket message is a UTF-8 JSON object:

```json
{
  "type":     "<string>",
  "id":       "<uuid-v4>",
  "deviceId": "<string>",
  "payload":  { ... },
  "ts":       <unix-epoch-ms>
}
```

- `type`: namespaced string — `cmd:*` (browser → device), `event:*` (device →
  browser), `resp:<id>` (device response to a specific `id`), `ping`, `pong`,
  `auth:ok`, `auth:fail`, `error`.
- `id`: UUID v4, CSPRNG. The device echoes this as `resp:<id>` so the browser
  can correlate responses.
- `deviceId`: set by the browser to target a specific device; echoed back in
  device → browser events.
- `payload`: command- or event-specific body; validated by zod on the agent
  before dispatch (§6).
- `ts`: client-generated Unix millisecond timestamp; the relay adds
  `relay_ts` to forwarded messages for audit purposes. Not trusted for
  ordering.

### 2.2 Auth handshake

**Browser → relay:**

1. Browser obtains a short-lived WS ticket: `POST /api/ws-ticket` with its
   HttpOnly session cookie. Relay returns a one-time opaque ticket (128-bit
   random, 30-second TTL, stored in-process).
2. Browser opens `wss://relay.session-manager.bilko.run/ws?ticket=<ticket>`.
3. Relay verifies ticket → resolves `userId` → confirms email is on the
   allowlist → sends `{"type":"auth:ok"}` and marks the connection as
   authenticated.
4. Ticket is immediately invalidated (one-time use).

**Agent → relay:**

1. Agent reads device token from `~/.claude/session-manager/web-remote.json`.
2. Agent calls `POST /api/device-ticket` with `Authorization: Bearer <device-token>`
   (never a URL parameter — URL query params appear in Render access logs).
   Relay verifies the device token, returns a 30-second single-use opaque
   ticket (128-bit random, stored in the in-process ticket map alongside the
   resolved `userId`/`deviceId`).
3. Agent opens `wss://relay.session-manager.bilko.run/ws?ticket=<ticket>`.
4. Relay verifies ticket → resolves `userId` and `deviceId` → confirms email
   allowlist → invalidates ticket immediately.
5. Relay sends `{"type":"auth:ok","deviceId":"<id>"}`.

**Routing rule (enforced at relay):**

A `cmd:*` message from browser session `B` targeting `deviceId: D` is
forwarded iff:
1. `B` is authenticated and `B.userId === devices[D].userId`.
2. Device `D` has an open, authenticated connection.

**Security invariant**: the relay MUST derive `userId` exclusively from the
authenticated WS session record (set at ticket verification time), never from
the `deviceId` field in the message envelope. An attacker controlling a browser
session cannot escalate to another user's device by crafting a `deviceId` in
the envelope — the `userId` lookup is keyed on the session record, not the
envelope.

An `event:*` or `resp:*` message from device `D` is forwarded to all
authenticated browser sessions where `session.userId === D.userId`.

No cross-user forwarding is possible at the routing layer.

### 2.3 Heartbeat

- Both ends send `{"type":"ping","id":"<uuid>","ts":<ms>}` every **30 seconds**.
- The receiver responds `{"type":"pong","id":"<echo-id>","ts":<ms>}` within 10 seconds.
- Three consecutive missed pongs (90-second window) → connection closed, agent
  reconnects with backoff.

### 2.4 Reconnect and backoff

The local agent reconnects on any close (code ≥ 1001) with **full jitter
exponential backoff**: initial delay 1 s, multiplier 2×, cap 60 s, ±20%
uniform jitter. The agent does not reconnect if `remoteEnabled` has been set to
`false` or if the device token has been revoked (relay closes with code 4001).

### 2.5 Max message size

Hard cap: **256 KiB** per message (matching `PRD_WRITE_MAX_BYTES` in
`src/main/ipcSchemas.cjs` — the largest legitimate single payload is a PRD
body write). The relay closes the connection with code 1009 on oversize frames.
PTY output that exceeds this is chunked by the agent before sending.

### 2.6 Backpressure

If the relay's write buffer for a browser session exceeds **1 MiB**, the relay
drops the oldest buffered messages and emits a `{"type":"error","code":"buffer_overflow"}`
event to the browser. For PTY data streams the browser must implement a
`cmd:pty:pause` / `cmd:pty:resume` flow-control protocol (added in PRD 09) to
prevent this in normal operation.

---

## 3. Pairing flow

### 3.1 Step-by-step

```
Web browser                         Relay                         Local Electron app
─────────────────────────────────────────────────────────────────────────────────────
1. Sign in with Google ────────────►  OAuth callback, sets
                                      session cookie, verifies
                                      email against allowlist ◄─── ALLOWED_EMAIL env var
                                      (blocks otherwise)

2. Clicks "Add Device" ────────────►  Generates OTP:
                                      - 8 alphanumeric chars (CSPRNG)
                                      - TTL: 5 minutes
                                      - Max 3 verification attempts
                                      - Max 10 OTP requests/hour/user
                                      Returns OTP to browser

3. Browser shows OTP code
   ("Open your local Session Manager
    and enter: XXXXXXXX")

                                                                  4. User opens Settings →
                                                                     Remote Access tab,
                                                                     enables Remote Control
                                                                     toggle (OFF by default),
                                                                     clicks "Pair Device",
                                                                     enters the 8-char OTP

                                                                  5. Agent POST /pair:
                                                                     { code: "XXXXXXXX",
                                                                       deviceId: "<new-uuid>" }
                                                                     over HTTPS

6.                                    Relay verifies:
                                      - OTP exists + not expired
                                      - Under 3 attempts
                                      - userId from OTP matches no
                                        other device token conflict
                                      Issues device token (256-bit
                                      random, stored in relay's
                                      token map keyed by deviceId)
                                      Invalidates OTP immediately
                                      Returns { deviceToken, deviceId }

                                                                  7. Agent writes token to
                                                                     ~/.claude/session-manager/
                                                                     web-remote.json (mode 0600)
                                                                     via config.cjs writeJson
                                                                     (atomic tmp+rename)

                                                                  8. Agent opens outbound
                                                                     WebSocket to relay
                                                                     (see §2.2 agent handshake)

9. Browser WS receives
   device:connected event,
   shows device as paired
```

### 3.2 OTP properties

| Property | Value |
|---|---|
| Charset | `[A-Z0-9]`, case-insensitive entry |
| Length | 8 characters |
| Entropy | ~41 bits (38^8 ≈ 2^41) |
| TTL | 5 minutes |
| Max attempts | 3 (OTP invalidated after 3 failures) |
| Rate limit | 10 OTP generation requests per user per hour |

### 3.3 Pairing endpoint

`POST https://relay.session-manager.bilko.run/pair`

Request: `Content-Type: application/json`
```json
{ "code": "XXXXXXXX", "deviceId": "<uuid-v4>" }
```

Response (success, 200):
```json
{ "deviceToken": "<256-bit-base64url>", "deviceId": "<uuid-v4>" }
```

Response (failure, 400/429): `{ "error": "<reason>" }`

The `deviceId` in the request is agent-generated (UUID v4, CSPRNG). The relay
stores `{ deviceId, userId, token, issuedAt }`. The `/pair` endpoint is NOT
behind the WebSocket auth — it is a plain HTTPS endpoint, authenticated by the
OTP alone (which is bound to a `userId` at generation time).

---

## 4. Token storage (local)

**Location**: `~/.claude/session-manager/web-remote.json`

**File mode**: `0600` (owner read/write only). Written via `config.cjs`'s
`writeJson` (atomic tmp + rename pattern). The existing `validateWrite` in
`config.cjs` already allows writes under `~/.claude/` — this path is within
that prefix.

**Schema**:
```json
{
  "remoteEnabled": false,
  "devices": [
    {
      "deviceId": "<uuid-v4>",
      "deviceToken": "<256-bit-base64url>",
      "deviceName": "MacBook Pro (paired 2026-06-06)",
      "issuedAt": "<ISO-8601>",
      "lastConnectedAt": "<ISO-8601>"
    }
  ]
}
```

The `remoteEnabled` flag is the master kill switch (see §6). Default: `false`.

**Why this location over the OS keychain:**  
The app already stores all state under `~/.claude/session-manager/` (logs,
scheduler PRDs, agent memory, etc.). Using the OS keychain would require
`keytar` (a native Node.js addon) — another `electron-rebuild` target with
platform-specific failure modes. Given the file is 0600 and under the user's
home directory (already within `validatePath`'s `allowedRoots`), the security
model is equivalent to `~/.ssh/id_rsa`. Token rotation (§4.1) mitigates the
risk of long-lived static exposure.

**Caveat**: On shared machines with root access, 0600 does not protect against
root. For a single-user dev machine (the target deployment) this is
acceptable. A hardening PRD (10) may add an optional keychain backend.

### 4.1 Rotation and revocation

- **Manual rotation**: User clicks "Revoke" in the web UI → relay marks the
  device token as revoked in its token map → closes the device's WS connection
  with code 4001 → agent stops reconnecting and removes the token entry from
  `web-remote.json`.
- **Automatic rotation**: Not implemented in v1. PRD 10 will add a 90-day
  expiry with a silent re-pair prompt.
- **Revocation propagation**: Agent receives close code 4001 or a
  `{"type":"error","code":"token_revoked"}` message → sets `remoteEnabled:
  false` in `web-remote.json` → user must explicitly re-enable and re-pair.
  This is intentionally conservative: silent auto-reconnect after revocation
  would defeat the purpose of revocation.

---

## 5. Transport security

### 5.1 TLS (mandatory, v1)

All WebSocket connections use `wss://` over TLS 1.2+. Render provides managed
TLS certificates for custom domains. Plain `ws://` connections are rejected by
the relay. The agent hard-codes `wss://` in its relay URL constant — no
configuration allows downgrade. This addresses network attackers (§1.3).

### 5.2 End-to-end encryption (deferred to PRD 10)

**The trade-off**: E2E encryption (e.g., NaCl `box`, where the relay sees only
ciphertext) would make the relay blind to payload content, eliminating the
confidentiality risk from relay compromise (§1.4). The implementation cost is
moderate: key exchange at pairing time, box/unbox on both ends, key storage
alongside the device token.

**The recommendation**: Defer E2E to PRD 10 for two reasons:

1. The relay is hosted under the user's own Render account. The relay operator
   IS the user. The threat of a rogue relay operator is therefore low compared
   to a third-party managed relay service (Ably, Pusher, etc.).
2. E2E adds protocol complexity (key rotation, backward compatibility, key
   loss recovery) that would slow PRD 07–09 delivery without addressing the
   primary attack vectors (a network attacker is already blocked by TLS; a
   compromised relay is low-likelihood given self-hosting).

PRD 10 will implement E2E using `libsodium.js` (browser) and `sodium-native`
(agent), with a fresh keypair generated at pairing time and the public key
exchanged via the `/pair` endpoint.

---

## 6. Command model

### 6.1 Master kill switch

`remoteEnabled` in `~/.claude/session-manager/web-remote.json`. Default:
`false`. The local agent module (`src/main/remoteAgent.cjs`, added in PRD 08)
checks this flag:

- At startup: if `false`, does not open the relay WebSocket.
- On each incoming message: re-reads the flag (cached with a 1-second TTL);
  if `false`, drops the message and responds with `{"type":"error","code":"disabled"}`.
- The Settings tab (Remote Access section) exposes a toggle that writes this
  flag via the existing `config:write-json` IPC, which goes through `config.cjs`
  `validateWrite`.

### 6.2 Command allowlist (v1)

The relay forwards a `cmd:*` message to the agent's WebSocket. The agent's
dispatch loop enforces TWO independent guards before any IPC call:

1. **Allowlist check**: the `type` field must be in the explicit list below.
   Unknown types are dropped (no IPC call, no error leakage).
2. **Schema validation**: `ipcSchemas.cjs`'s existing zod schemas are reused.
   A new `remoteCommand` zod discriminated union wraps them with the relay
   envelope fields.

| Remote `type` | Dispatches to | Existing schema |
|---|---|---|
| `cmd:sessions:load` | `sessions:load` | — (no payload) |
| `cmd:sessions:save` | `sessions:save` | `sessionsPayload` |
| `cmd:pty:spawn` | `pty:spawn` | `ptySpawn` |
| `cmd:pty:write` | `pty:write` | `ptyWrite` (64 KiB cap) |
| `cmd:pty:resize` | `pty:resize` | `ptyResize` |
| `cmd:pty:kill` | `pty:kill` | `ptyTabId` |
| `cmd:schedule:state` | `schedule:state` | — |
| `cmd:schedule:read-prd` | `schedule:read-prd` | `scheduleSlug` |
| `cmd:schedule:read-log` | `schedule:read-log` | `scheduleReadLog` |
| `cmd:schedule:write-prd` | `schedule:write-prd` | `scheduleWritePrd` (256 KiB cap) |
| `cmd:schedule:reset-job` | `schedule:reset-job` | `scheduleSlug` |
| `cmd:schedule:run-now` | `schedule:run-now` | — |
| `cmd:schedule:set-config` | `schedule:set-config` | `setConfigSchema` |
| `cmd:history:aggregate` | `history:aggregate` | `historyAggregate` |
| `cmd:app:version` | `app:version` | — |

**Streaming events (device → browser, not commands):**

| Event `type` | Triggered by |
|---|---|
| `event:pty:data` | PTY output (agent → relay → browser) |
| `event:pty:exit` | PTY process exit |
| `event:transcript:event` | Transcript classification event |
| `event:device:status` | Heartbeat-derived connection state |

### 6.3 Explicitly forbidden (never proxied)

These IPC channels handle arbitrary shell execution, arbitrary file writes, or
software installation. They are NOT on the allowlist and the agent's dispatch
loop will silently drop any `cmd:*` type that resolves to them:

- `app:test-fire-hook` — spawns `{ shell: true }` with user-supplied command.
- `watchers:add` — spawns `{ shell: true }` watcher process.
- `config:write-json` / `config:write-text` — arbitrary path write (even
  though `validateWrite` restricts destinations, arbitrary JSON/text to
  `~/.claude/` from a remote caller is not acceptable in v1).
- `app:open-in-editor` / `app:open-file-in-editor` — opens editor processes
  on the local machine.
- `app:open-external` — opens URLs in the local browser.
- `plugins:install` / `plugins:abort` — installs/manages software.
- `files:*` — direct filesystem read/write.
- `search:*` — arbitrary cwd filesystem search.
- Any command not in the explicit allowlist table above.

### 6.4 Rate limiting

Per device connection: **100 commands/minute** (leaky bucket, 1-command/600ms
drain). Per browser session: **60 commands/minute**. Exceeded: relay responds
with `{"type":"error","code":"rate_limited","retryAfterMs":N}` and does not
forward the message to the device.

### 6.5 Audit log

The agent writes one line per dispatched command to
`~/.claude/session-manager/logs/remote-audit-<YYYY-MM-DD>.log` (mode 0600):

```
<ISO-8601>  <command-type>  deviceId=<id>  msgId=<uuid>  result=ok|error:<code>
```

This log is local-only and is never sent to the relay. It is the authoritative
record of what remote commands were executed on the machine.

---

## 7. Repo and deploy shape

### 7.1 Monorepo layout

```
session-manager/               ← existing npm package root
  src/
    main/
      remoteAgent.cjs          ← new, PRD 08 (local WS client + dispatcher)
  web-remote/
    relay/                     ← PRD 07: Node.js relay service
      package.json
      src/
        index.ts               ← Fastify + ws server
        auth.ts                ← Google OAuth + OTP logic
        router.ts              ← message routing
        tokens.ts              ← device token issuance
    app/                       ← PRD 09: web app
      package.json
      vite.config.ts
      src/
        ...                    ← React mobile-first UI
  docs/
    web-remote/
      ARCHITECTURE.md          ← this file
  package.json                 ← existing, `files` allowlist unchanged
```

**Decision rationale**: A single repository keeps the relay message envelope
types and the agent's dispatch schemas in one place. Shared TypeScript
interfaces under `web-remote/shared/` (added in PRD 07) can be imported by
both relay and app without a publish step. Separate repos would require
versioned protocol packages and coordinated releases — unjustified overhead for
a single-author project.

### 7.2 Keeping web-remote OUT of the npm package

The existing `files` field in `package.json` is an explicit allowlist:

```json
"files": [
  "bin/",
  "src/main/",
  "src/preload/",
  "dist/index.html",
  "dist/assets/",
  "dist/vad/",
  "screenshots/",
  "README.md"
]
```

`web-remote/` is not in this list and is therefore **automatically excluded**
from `npm publish` — no `.npmignore` entry is needed. This is verified by
`npm pack --dry-run` before each release (add to the PRD 07 checklist).

### 7.3 Render deploy targets

| Service | Type | Source dir | Plan |
|---|---|---|---|
| `sm-relay` | Web Service (Node.js) | `web-remote/relay/` | Starter ($7/mo) — required for persistent WebSocket connections (Render free tier sleeps after 15 min inactivity) |
| `sm-app` | Static Site | `web-remote/app/` | Free — Vite build, no server process needed |

Both services are in the user's existing Render account (same as fizzpop,
etch-engine, bilko.run). Each has its own `render.yaml` in its source dir.

**Relay environment variables** (set in Render dashboard, never committed):

- `RELAY_SECRET` — 32-byte hex; used to HMAC-verify device tokens at startup.
  Rotated by redeploying with a new value (invalidates all existing device
  tokens, requiring re-pair — acceptable for v1).
- `ALLOWED_EMAIL` — the user's email address (`stanislavbg@gmail.com`). Single
  value for v1 (one user). PRD 10 can expand to a comma-separated list.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — OAuth app credentials.
- `SESSION_SECRET` — HMAC key for session cookies.

### 7.4 bilko.run portfolio integration

**Finding**: The bilko.run portfolio is at `/home/bilko/Projects/Bilko`. It is
a React 18 + React Router v6 + Vite + Fastify app deployed on Render. Project
entries are defined in:
- `/home/bilko/Projects/Bilko/src/data/standalone-projects.json` —
  the `session-manager` entry currently points to npmjs.com.
- `/home/bilko/Projects/Bilko/src/data/projectsRegistry.ts` —
  defines the `ProjectHost` union (`react-route | static-path | external-url`).

**Decision**: The new dedicated web app is a **separate Render Static Site**
(not a route inside bilko.run). Rationale: the web app has a distinct auth flow
(Google OAuth against the relay), PTY streaming, and a mobile-first layout that
would be awkward inside the bilko.run Fastify/React Router shell. Keeping it
separate also means it can have its own Content-Security-Policy tuned for
WebSocket connections.

**Wiring the launch point**: In PRD 09, update
`standalone-projects.json` (session-manager entry):

```json
{
  "host": {
    "kind": "external-url",
    "url": "https://session-manager.bilko.run",
    "sourceRepo": "github.com/StanislavBG/session-manager"
  }
}
```

This change goes in the `Bilko` repo, not the `session-manager` repo. The
`HubRow` card's "Visit" / "Launch" link already renders `host.url` as an
`<a href>` — no component changes needed.

**Domain**: `session-manager.bilko.run` (Render Static Site, custom domain via
Render dashboard + DNS CNAME to Render's CDN). The relay lives at
`relay.session-manager.bilko.run` (Render Web Service, same DNS zone).

**Hard constraint for PRD 09**: The web app is MOBILE-FIRST. The primary
surface is a device connection panel. Desktop is a wider layout of the same
components — no desktop-only features. This constraint is non-negotiable and
must be stated in the PRD 09 acceptance criteria.

---

## 8. Library choices

| Component | Library | Reason |
|---|---|---|
| Relay WebSocket server | `ws` (npm) | Minimal, zero dependencies, battle-tested, full control over framing. Socket.IO's rooms/namespaces are not needed — the routing logic is simple (one user, N devices, M browser sessions). Managed relays (Ably, Pusher) add cost, vendor lock-in, and send data through a third-party operator — incompatible with the self-hosting posture. |
| Relay HTTP server | `fastify` v5 | Already used in bilko.run; familiar; typed plugin ecosystem. Express would work equally well but Fastify is the house standard. |
| Google OAuth (relay) | `google-auth-library` (npm) | Official Google library; handles token verification, PKCE, and refresh internally. The relay uses the authorization code flow (server-side): `OAuth2Client.generateAuthUrl` → callback → `getToken` → `verifyIdToken`. No need for `passport` in a single-provider flow. |
| Google Sign-In button (web app) | `@react-oauth/google` | React wrapper for Google Identity Services (GIS). Renders the canonical "Sign in with Google" button; returns a credential that the web app POSTs to the relay for verification. |
| Session cookies (relay) | `@fastify/cookie` + `@fastify/session` | HttpOnly, Secure, SameSite=Strict. Session data stored in-process (single Render instance). A Render Redis add-on is not required in v1 — single-instance relay is sufficient for one user. |
| Agent WS client | `ws` (npm) | Same library as the relay server — no extra dependency; the agent already runs in Node.js (main process). |
| CSPRNG (OTP + tokens) | `node:crypto.randomBytes` | Built-in, no dependency. |
| Zod (relay message validation) | `zod` (npm) | Already a dependency of session-manager; relay imports the shared envelope schema. |

---

## 9. Build breakdown

### PRD 07 — Relay service (`web-remote/relay/`)

**Deliverables:**

1. `relay/src/index.ts` — Fastify server on port 3010; `ws` WebSocket server
   attached to the same HTTP server.
2. `relay/src/auth.ts` — Google OAuth endpoints: `GET /auth/google` (redirect),
   `GET /auth/google/callback` (token exchange + allowlist check + session
   cookie issuance).
3. `relay/src/tokens.ts` — OTP generation/verification, device token issuance,
   in-process token map, revocation.
4. `relay/src/router.ts` — WebSocket auth handshake, connection registry,
   message routing logic (§2.2 routing rule), heartbeat.
5. `relay/render.yaml` — Render Web Service config.
6. `relay/package.json` — dependencies: `ws`, `fastify`, `@fastify/cookie`,
   `@fastify/session`, `google-auth-library`, `@react-oauth/google` (app only),
   `zod`.

**Done when**: relay deployed to Render, can route a ping from a test browser
session to a test device session.

### PRD 08 — Local agent (`src/main/remoteAgent.cjs`)

**Deliverables:**

1. `src/main/remoteAgent.cjs` — WS client (outbound), pairing call, command
   dispatcher, PTY event forwarder, audit logger. Reads `web-remote.json` for
   config; writes token at pair time.
2. `src/main/ipcSchemas.cjs` — new `remoteCommand` discriminated union schema
   (the allowlist table from §6.2 in zod form).
3. Settings tab — "Remote Access" section: toggle for `remoteEnabled`, pairing
   code entry UI, paired device list with "Revoke" button.
4. Unit tests for the dispatch allow/deny logic (vitest).

**Done when**: local app can pair, connect to the deployed relay, and echo a
`cmd:app:version` from a browser session back as a `resp:`.

### PRD 09 — Web app (`web-remote/app/`)

**Deliverables:**

1. Mobile-first React + Vite app.
2. Google Sign-In flow (session managed by relay cookie).
3. "Add Device" pairing flow (OTP entry on the web side).
4. Device list with connect/disconnect/revoke actions.
5. Terminal pane: xterm.js rendering `event:pty:data` streams; PTY spawn/write
   UI (minimal: a "New Terminal" button + keyboard input).
6. Scheduler pane: PRD list (read), PRD editor (write), trigger-now button.
7. Session list (read-only in v1).
8. Render Static Site deploy + custom domain `session-manager.bilko.run`.
9. bilko.run `standalone-projects.json` patch to update the session-manager
   `host.url`.

**Hard constraint**: every pane must be usable on a 390px-wide viewport (iPhone
15 width) as the primary use case. Desktop layout is a wider reflow of the same
components.

**Done when**: full round-trip from mobile browser → relay → local agent →
PTY spawn → terminal output visible in the browser.

### PRD 10 — Hardening

**Deliverables:**

1. End-to-end encryption: `libsodium.js` (app) + `sodium-native` (agent);
   keypair generated at pairing and stored alongside device token; relay sees
   only ciphertext.
2. Automatic device token rotation: 90-day expiry, silent re-auth prompt.
3. Device revocation from web UI (relay-side endpoint + agent close-code 4001
   handling).
4. Rate limiting: leaky bucket in relay (§6.4).
5. Content-Security-Policy headers for the web app: `connect-src wss://relay.session-manager.bilko.run`.
6. Security audit checklist: OWASP Top 10 review of the relay and web app.
7. Penetration test: replay attack, token theft simulation, command injection
   attempt against the allowlist.
8. Optional OS keychain backend for device token storage (behind a feature flag
   in `web-remote.json`).

**Done when**: E2E encryption passes a relay-observer test (relay logs show
ciphertext, not command payloads); rotation works end-to-end; security checklist
reviewed and signed off.

---

## 10. Open questions for PRD 06 (prior-art research)

1. **Render WebSocket persistence**: Does Render's Starter ($7/mo) Web Service
   keep long-lived WebSocket connections alive for the full session duration,
   or does it impose an idle timeout? (Confirm in Render docs before finalising
   PRD 07 — if there's a hard timeout, the agent needs to detect relay-side
   force-closes and reconnect faster.)
2. **Device token storage in relay**: In-process `Map` (lost on Render redeploy
   → all devices re-pair) vs Render Redis add-on (persistent, $10/mo). The
   correct choice for v1 depends on acceptable re-pair friction. Recommendation:
   start with in-process; add Redis in PRD 10 if churn is annoying.
3. **Binary vs JSON for PTY streaming**: PTY output is binary (terminal escape
   sequences). Sending it as base64-encoded JSON is correct but 33% larger.
   Binary WebSocket frames are more efficient but require the relay to frame-
   forward without JSON-parsing. Decide before PRD 07 finalises the envelope
   spec.
4. **OTP flow direction**: The current design has the web show the code and the
   local app enter it. The inverse (local app shows the code, web enters it) is
   equally valid and may feel more natural for "I'm on mobile, want to connect
   to the machine in front of me". Evaluate in PRD 08 UX.
5. **Device token expiry**: Should device tokens have a hard TTL (e.g., 90
   days), or be revoke-only? Hard TTL adds safety but requires re-pair.
   Defer to PRD 10 but state the v1 behaviour clearly in PRD 07.
6. **Single `ALLOWED_EMAIL` vs a list**: v1 uses a single env var for one user.
   If the relay schema is `ALLOWED_EMAIL=a@b.com,c@d.com` from day one, no
   migration is needed. Add the comma-split parser in PRD 07.
7. **Relay URL configurability**: Should the relay URL in `remoteAgent.cjs` be
   hardcoded or configurable via `web-remote.json`? Hardcoding simplifies PRD
   08 but makes self-hosting the relay impossible. Low priority for v1.
8. **xterm.js version in web app**: The session-manager already ships
   `@xterm/xterm ^5.5.0`. The web app must use the same major version to share
   keybinding/colour knowledge. Confirm the xterm.js package name and version
   before PRD 09 scaffolding.
9. **bilko.run deploy coordination**: The `standalone-projects.json` patch in
   PRD 09 targets the `Bilko` repo. Confirm the dual-push contract
   (`docs/deployment.md` in `Bilko`) still applies and that the content-grade
   branch must receive the patch too.
10. **CSP for `session-manager.bilko.run`**: The Render Static Site serves
    the app as static files; CSP headers must be set via a `_headers` file
    (Render Static Site convention) rather than a server middleware. Verify
    Render's Static Site supports `_headers` before PRD 09.
