# Web Remote — Prior Art Research

**Status**: Reference  
**Produced by**: PRD 06 (headless `claude -p` research job)  
**Date**: 2026-06-07  
**Dependency**: Reads `ARCHITECTURE.md` (ADR 05). Open-questions list at §10 of that doc
drives this research.

This document informs PRDs 07–10. For each prior system it records (a) auth,
(b) device pairing, (c) relay/transport, (d) token revocation, the license, and
a one-line verdict on reusability. It ends with a recommendation table, a
mobile-terminal evaluation, and a list of ADR amendments.

---

## 1. VS Code Remote Tunnels (`code tunnel`)

**Pattern match**: outbound agent registers with managed relay; browser authenticates
separately; both bound to the same identity.

### (a) Auth

Both ends authenticate against the same identity provider: GitHub or Microsoft account.
The local machine (agent side) logs in once via device code flow
(`github.com/login/device`) and stores a credential. The browser side logs in
with the same GitHub/Microsoft account via standard OAuth redirect when it opens
the `vscode.dev/tunnel/…` URL. The relay (Azure Dev Tunnels) verifies that both
connections belong to the same account before routing.

### (b) Device pairing

Registration is implicit: when the agent first runs `code tunnel`, it registers
the machine against the authenticated account and receives a stable tunnel name.
Up to 10 tunnels per account; the CLI auto-removes an unused tunnel when the
limit is reached. There is no separate OTP or pairing code — registration is
gated by account auth alone.

### (c) Relay / transport

Microsoft's Azure-hosted **Dev Tunnels** service
(`*.rel.tunnels.api.visualstudio.com`). Agents connect outbound only; no
firewall changes needed on the machine. Once connected, VS Code creates an SSH
tunnel over the relay, giving **end-to-end encryption** (AES-256 CTR). The relay
sees TLS-encrypted SSH ciphertext — it routes by tunnel ID, not by inspecting
the payload.

### (d) Token revocation

`code tunnel unregister` on the local machine removes it from the account. The
tunnel name stops routing immediately. There is no web-UI revocation in the VS
Code sense (beyond removing the GitHub OAuth app or revoking the device
token in GitHub → Settings → Applications).

**License**: The VS Code source is MIT; the `vscode-dev-tunnels` protocol
library is MIT (`github.com/microsoft/dev-tunnels`). The *relay service itself*
is Microsoft SaaS — not self-hostable.

**Verdict**: Strongest architecture analogue (outbound agent + managed relay +
browser auth against same identity). Not reusable directly — relay is
Microsoft-proprietary; agent is Electron + VS Code extension, not a bare
Node.js module. Borrow the **pattern** (agent registers by auth, not by OTP;
browser authenticates independently; relay binds by userId), note that our
OTP pairing adds an explicit binding step that VS Code omits.

---

## 2. Tailscale / Funnel

**Pattern match**: device auth via cryptographic identity; relay as NAT-traversal
fallback; ACLs control routing.

### (a) Auth

Each device generates a **WireGuard keypair** at enrollment. The device registers
its public key with Tailscale's coordination server (proprietary SaaS). The
coordination server is the identity plane: it issues signed node records and
distributes the key list to all tailnet members. Users log into the coordination
server via SSO (Google, GitHub, etc.); each device is associated with a user
account.

### (b) Device pairing

A device joins the tailnet by running `tailscale up` and authenticating via
browser (or auth key). The coordination server adds the device's WireGuard
public key to the tailnet's distributed key table. ACL/grant policies then
control which tailnet members can reach which devices. There is no OTP or pairing
code — enrollment is gated by account auth and ACL policy.

**Tailscale Funnel** is a sub-feature: it accepts inbound TCP connections from
the public internet and forwards them to a specific local port on a tailnet
device. Funnel relay servers do not decrypt traffic (the relay TCP-proxies
WireGuard-encrypted bytes end-to-end).

### (c) Relay / transport

**DERP** (Designated Encrypted Relay for Packets): DERP servers are used as a
relay fallback when direct P2P cannot be established (symmetric NAT). DERP
servers authenticate connecting clients with a NaCl box construction over TLS —
the client proves ownership of its WireGuard private key before being allowed to
relay. DERP servers only handle already-WireGuard-encrypted packets; they never
see plaintext. The DERP server code is open-source (BSD 3-Clause,
`github.com/tailscale/tailscale`).

### (d) Token revocation

Remove the device from the tailnet in the Tailscale admin console. The
coordination server stops distributing that device's key. Next connection
attempt from the removed device fails the WireGuard key check. ACL changes
propagate within seconds.

**License**: Tailscale client and DERP server: **BSD 3-Clause** (open source).
Coordination server: proprietary Tailscale SaaS.

**Verdict**: Overkill — full VPN mesh is not the goal. DERP's design (relay
proves client owns its key before relaying; relay never sees plaintext) is
inspirational for our PRD 10 E2E encryption design. The "device ID =
cryptographic identity" principle maps to Syncthing (§5) more directly. Not
reusable as code.

---

## 3. ngrok and localtunnel

**Pattern match (by contrast)**: tunnel model — exposes a local port as a
public URL. Our design is explicitly NOT this model.

### ngrok

#### (a) Auth
Agents authenticate with an **authtoken** (long-lived secret issued per ngrok
account). Token sent in agent-to-ngrok handshake. Browser accessing the tunnel
URL receives whatever the local service serves, with optional HTTP basic auth
or OAuth guard configurable in the ngrok dashboard.

#### (b) Device pairing
No device pairing concept. The authtoken binds the agent to the account; the
tunnel URL is generated per session (or is a fixed subdomain on paid plans).

#### (c) Relay / transport
ngrok's cloud receives inbound TCP/HTTP(S)/TLS connections from the public
internet and multiplexes them down to the local agent over a persistent outbound
TCP connection. The relay *terminates* TLS for HTTP tunnels (ngrok sees plaintext
HTTP). For TCP pass-through tunnels it is E2E.

#### (d) Token revocation
Revoke the authtoken in the ngrok dashboard. The agent loses its relay
connection on next reconnect.

**License**: ngrok agent (open-source version): MIT. ngrok service: proprietary
commercial.

**Contrast with our model**: ngrok exposes a local service as a *publicly
addressable port* — anyone who knows the URL can reach it (subject to optional
extra auth). Our model does the opposite: the relay is NOT publicly reachable via
a raw URL; it only routes authenticated, paired WebSocket sessions. We want
zero-trust pairing, not a public tunnel.

### localtunnel

#### (a) Auth
None by default. Optional password via `--local-host`. No account required.

#### (b) Device pairing
None. A random subdomain is assigned per session.

#### (c) Relay / transport
Open-source Node.js relay server (`github.com/localtunnel/server`, MIT). Client
(`github.com/localtunnel/localtunnel`, MIT) makes outbound TCP connections to
the relay; relay creates a TCP tunnel per subdomain. Very ~400-line relay server
is readable and instructive.

#### (d) Token revocation
No concept of revocation — session ends when the client disconnects.

**License**: Both client and server: **MIT**.

**Verdict for both**: Wrong model for us. We must not expose a port to the
internet. The localtunnel relay server source is the closest open-source
reference implementation of "outbound agent + relay + inbound request", but it
has no auth layer and is too simplistic. Borrow its Node.js TCP relay pattern
conceptually; do not fork it.

---

## 4. Jupyter Server token/auth model

**Pattern match**: simple static bearer token; cookie upgrade after first
authenticated request.

### (a) Auth

Jupyter Server issues a **single random token** at startup (or reads one from
`JUPYTER_TOKEN` env var / `JUPYTER_TOKEN_FILE`). The token is a static bearer
secret; it never changes until the server restarts with a new token. Clients
provide it via:
- URL parameter: `?token=<token>` (first use, sets a cookie)
- HTTP header: `Authorization: token <token>`
- Login form password field

After a successful token request, the server sets an **HttpOnly session cookie**;
subsequent requests from that browser use the cookie without re-sending the token.

### (b) Device pairing

No device pairing concept. Single token = single gate; any client with the token
has full access.

### (c) Relay / transport

Local-only (no relay). JupyterHub adds an OAuth proxy (configurable: GitHub,
Google, LDAP) in front of multiple single-user Jupyter servers, but the per-server
auth remains token-based internally.

### (d) Token revocation

Restart the server with a new token. No runtime revocation API.

**License**: BSD 3-Clause (`github.com/jupyter-server/jupyter_server`).

**Verdict**: The **OTP-to-token upgrade pattern** is directly applicable. Our
system is a more sophisticated version: OTP (single-use, TTL) → device token
(long-lived, revocable), analogous to Jupyter's token → cookie upgrade. The
`Authorization: Bearer` / `Authorization: token` header convention is the
de-facto standard we should also use (and already do in our device ticket
endpoint). Not reusable as code (Python), but the auth model is a clean reference.

---

## 5. Syncthing device pairing

**Pattern match**: certificate-derived device IDs, mutual approval, no central
authority for pairing.

### (a) Auth

Each Syncthing instance generates a **self-signed TLS certificate** (3072-bit
RSA) at first start. The **device ID** is the SHA-256 hash of the DER-encoded
certificate, encoded as base32 (with Luhn check digits for typo detection),
formatted as `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX` (7 groups of 4). No
central auth server; identity is purely cryptographic.

### (b) Device pairing

Pairing is **mutual and explicit**: both devices must add the other's device ID
to their configuration. A connection attempt from an unknown device is rejected.
There is no OTP — the user manually enters or copy-pastes the 63-character
device ID from device A into device B's UI, and vice versa. This is intentionally
high-friction to prevent unauthorized pairing.

### (c) Relay / transport

Syncthing uses **STUN** for NAT traversal and a pool of community-run relay
servers (the Syncthing Relay Protocol, STR) as a fallback. Relay connections
are full-duplex tunnels; the relay does not decrypt (WireGuard-like posture: relay
handles opaque bytes). Protocol is BEP (Block Exchange Protocol) over TLS 1.3.

### (d) Token revocation

Remove the device ID from the configuration. Next connection attempt fails the
TLS mutual-auth check.

**License**: MPL 2.0 (`github.com/syncthing/syncthing`). Relay server
(`github.com/syncthing/relaysrv`): MPL 2.0.

**Verdict**: Device ID = cert hash is elegant — no separate token storage needed.
Our 256-bit random device token is simpler (no cert overhead) and sufficient for
a single-user system. The **Luhn-encoded base32 device ID display** is a UX
pattern worth borrowing for our `deviceId` hex display in the Settings UI (the
check digits prevent silent one-character paste errors). The MPL 2.0 relay server
could be forked for our relay, but it solves a different problem (file sync, not
command dispatch) and adding our message envelope would be more work than writing
a fresh relay.

---

## 6. OAuth 2.0 Device Authorization Grant (RFC 8628)

**Pattern match**: the canonical standard for "approve on one device, use on
another". Maps directly onto our OTP pairing.

### Flow summary

```
Device (constrained)            Auth Server          User (browser on another device)
────────────────────────────────────────────────────────────────────────────────────
POST /device_authorization ──►  Returns:             
  client_id                       device_code         
                                  user_code ──────►  User visits verification_uri,
                                  verification_uri    logs in, enters user_code
                                  expires_in          ◄── User approves
                                  interval

Loop: POST /token ──────────────►  Returns:           
  grant_type=urn:...device_code   access_token (if approved)
  device_code                     authorization_pending (if not yet)
                                  expired_token (if TTL passed)
```

**user_code** is typically 8 alphanumeric characters (e.g., `BDWP-HQTM`), displayed
to the user on the constrained device.

### Mapping to our pairing

| RFC 8628 concept | Our concept |
|---|---|
| `user_code` (shown on device, entered in browser) | Our OTP is inverted: **shown in browser, entered in local app** |
| `verification_uri` | Our relay's `/pair` endpoint |
| `device_code` | Not needed — our agent POSTs OTP directly (no polling) |
| `expires_in` | Our OTP TTL (5 minutes) |
| `interval` + polling | Not needed — agent makes a single POST |
| Access token on approval | Our device token (256-bit, returned in `/pair` 200 response) |

Our design is **RFC 8628 with roles swapped**: in RFC 8628, the constrained
device shows the code and the browser enters it. In our system, the browser
(which has the authenticated session) shows the code and the local app enters it.
Both flows bind the browser session and the local device to the same `userId`.
The inversion is correct for us: the browser session IS the authentication event
(Google OAuth), and the OTP is the proof that the person entering it on the
local machine is the same person who just authenticated.

**License**: IETF RFC — no code license; pure specification.

**Verdict**: Our pairing design IS RFC 8628 with inverted roles. The 8-character
alphanumeric code length, short TTL, and attempt-count limit in our spec are
directly informed by this RFC. No code to reuse (it's a spec), but implementations
exist in every OAuth library. The RFC's threat model analysis (§5 Security
Considerations) is required reading for PRD 08.

---

## 7. Managed realtime relays

### 7.1 Ably

**Auth**: Capability-scoped **API keys** (for server-side use) + **token auth** for
clients. Server generates a signed token (JWT or Ably Token) that scopes the
client to specific channels and capabilities. Clients cannot use raw API keys on
the frontend. This maps cleanly to our relay's OTP → device-token pattern.

**Persistence**: Optional **message history** (configurable retention). Presence
API (know which clients are online). Push notifications.

**Cost**:
- Free: 6M messages/month, 200 concurrent connections, no credit card
- Paid: $2.50/million messages; ~$138/mo for a moderately trafficked app

**Render fit**: Ably runs as a third-party SaaS. The relay on Render would call
Ably's REST/WebSocket APIs instead of managing its own `ws` connections.

**License**: Client SDKs: **Apache 2.0**.

**Verdict**: Adds $0–$2.50/M msgs cost and vendor dependency. For a single-user
app the free tier is sufficient, but third-party operator sees all message
payloads (breaks the self-hosting threat model in §1.3 of ARCHITECTURE.md:
"Managed relays add cost, vendor lock-in, and send data through a third-party
operator"). Token auth model is well-designed and worth studying.

### 7.2 Pusher

**Auth**: Server-side **channel auth** via `/pusher/auth` webhook. Client sends
`socket_id + channel_name` to the relay; relay signs with app secret and returns
an auth signature. Private and presence channels require auth; public channels do
not.

**Persistence**: No message history on standard channels (requires Pusher Cache
Channels, paid).

**Cost**:
- Free: 200 concurrent connections, 200K messages/day
- Paid: $49/mo (1000 connections, 5M messages/day)

**Render fit**: Same as Ably — third-party SaaS from Render.

**License**: Client SDKs: **MIT**.

**Verdict**: Tighter free tier than Ably (200K msgs/day vs 6M/month). Pusher's
channel-auth webhook pattern (relay asks your server to authorize a connection)
is directly analogous to our device-token verification — and is a proven
single-call auth pattern. Not the right choice (third-party operator problem),
but Pusher's auth webhook design is a cleaner API than building it fresh.

### 7.3 PartyKit (Cloudflare)

**Auth**: No built-in auth. Developers implement auth in `onConnect(conn, room, ctx)` and `onMessage(message, sender, room)` hooks. You check
headers/tokens and close unauthenticated connections manually.

**Persistence**: Cloudflare Durable Objects with SQLite storage (GA 2025). State
survives worker restarts.

**Cost**:
- Free: Deploy to your own Cloudflare account; CF Workers free tier (100K
  requests/day)
- Paid: CF Workers Paid ($5/mo) for higher limits

**Render fit**: **Incompatible with Render** — PartyKit deploys to Cloudflare
Workers/Durable Objects. Choosing PartyKit means leaving Render for the relay.

**License**: **MIT** (`github.com/cloudflare/partykit`). Acquired by Cloudflare
April 2024.

**Verdict**: PartyKit's `partysocket` client (auto-reconnect WebSocket with
backoff) is the best available open-source WebSocket client with built-in
reconnection logic — worth importing into our local agent and web app instead of
writing our own. However, the server-side requires Cloudflare Workers, not Render.
Use `partysocket` client library; do not use PartyKit's server.

### 7.4 Cloudflare Durable Objects / WebSockets

**Auth**: Must implement in Worker code. No built-in auth primitives.

**Persistence**: SQLite-backed DO (GA 2025). WebSocket Hibernation API: DO
sleeps between messages (no idle compute cost), wakes on incoming message.

**Cost**:
- Free tier: 100K DO requests/day, 1M Worker requests/day
- Paid: $5/mo Workers Paid + $0.15/million DO requests + $0.20/million DO
  read units

**Render fit**: Mutually exclusive with Render (Cloudflare vs Render).

**Verdict**: DO's WebSocket Hibernation API is architecturally superior to a
persistent in-process WS server (zero idle cost). But it requires moving the
relay to Cloudflare Workers. For a single-user relay with low traffic the cost
difference is negligible; the Render familiarity wins.

### 7.5 Self-hosting `ws` on Render (current plan)

**Cost**: Render Starter ($7/mo) for the relay Web Service (required for
persistent WS — free tier sleeps after 15 min inactivity).

**Persistence**: In-process `Map` for token/session state. **Lost on redeploy.**
Devices must re-pair after every relay redeploy. A Render Redis add-on
($10/mo) would persist tokens across redeploys.

**Auth**: Full control; we implement exactly what ARCHITECTURE.md specifies.

**Timeout**: **No hard idle timeout** (confirmed via Render docs). Connections
close only on instance replacement (deploy/maintenance). 30-second graceful
shutdown window (extendable to 300s). **This directly answers open question §10.1
of ARCHITECTURE.md.**

**Verdict**: Correct choice for v1. Lowest cost, no vendor dependency, relay
operator is the user. The in-process token map is the right starting point;
PRD 10 can add Redis if re-pair friction proves annoying.

---

## 8. Google OAuth libraries (Node.js / Render web app)

### 8.1 `google-auth-library`

**What it does**: Official Google Node.js auth library. Handles the full
authorization code flow server-side:

```
OAuth2Client.generateAuthUrl({ scope: ['openid', 'email', 'profile'] })
  → redirect user →
GET /auth/google/callback?code=...
  → oauth2Client.getToken(code) → { tokens }
  → oauth2Client.verifyIdToken({ idToken, audience: CLIENT_ID })
  → LoginTicket.getPayload() → { email, email_verified, sub, ... }
  → if (payload.email !== ALLOWED_EMAIL) → 403
  → else → set session cookie
```

**Email allowlist**: not a built-in feature — implemented in the callback handler
by comparing `payload.email` to `process.env.ALLOWED_EMAIL.split(',')`.
`payload.email_verified` must also be checked (prevents use of unverified emails).

**License**: **Apache 2.0** (`github.com/googleapis/google-auth-library-nodejs`).

**Verdict**: Exactly what ARCHITECTURE.md already specifies. Use this. No
competing library adds value for a single-provider, single-user relay. Implement
the comma-split `ALLOWED_EMAIL` parser in `relay/src/auth.ts` during PRD 07
(directly answers open question §10.6).

### 8.2 Auth.js (NextAuth v5)

**What it does**: Framework-agnostic auth library with adapters for
Next.js, Express, SvelteKit, etc. Google provider: `GoogleProvider({ clientId,
clientSecret })`. Email restriction via `callbacks.signIn`:

```js
callbacks: {
  async signIn({ user }) {
    return process.env.ALLOWED_EMAILS.split(',').includes(user.email)
  }
}
```

**Express adapter**: `ExpressAuth` from `@auth/express` (Auth.js v5).

**License**: **ISC** (`github.com/nextauthjs/next-auth`).

**Verdict**: Adds abstraction that isn't needed for a single-provider, single-relay
setup. `google-auth-library` is more direct and has fewer moving parts.
Auth.js becomes relevant if the web app grows to support multiple OAuth providers
or needs session adapters (DB-backed sessions for Redis). Defer.

---

## 9. Mobile-friendly terminal (xterm.js on touch)

The session-manager Electron app already ships `@xterm/xterm ^5.5.0`. The web
app (PRD 09) must reuse the same major version for consistent theming and
keybinding knowledge.

### What transfers from desktop

- Package: `@xterm/xterm` (same npm package — web and Electron use the same
  renderer)
- Color scheme / theme config: identical JSON blob
- `@xterm/addon-fit`: works in browser with `ResizeObserver`
- ANSI escape handling, VT100 compatibility: identical

### Known mobile limitations (open issues)

| Issue | Status (2025) | Impact |
|---|---|---|
| #5377 Limited touch support | Open | Touch events not natively handled; text selection broken on touch |
| #1101 Support mobile platforms | Long-standing open | No ballistic scroll, no native touch keyboard |
| #594 Ballistic touch scrolling | Open | Scrollback via swipe not implemented |
| #2403 Predictive keyboard handling | Open | iOS predictive text inserts suggestions into terminal incorrectly |

### Mobile-specific implementation required

1. **On-screen key bar** (required, not optional): ESC, Tab, ↑↓←→, Ctrl+C,
   Ctrl+Z, Ctrl+D. xterm.js itself does not render one. Build a fixed-position
   `<div>` above the terminal that calls `term.write()` / `term.sendText()` with
   the appropriate sequences. Look at Termius, Blink Shell, and mosh-chrome as
   UX references.

2. **Mobile keyboard input**: xterm.js requires a DOM element to receive keyboard
   input. On desktop, the terminal canvas handles it. On mobile, the software
   keyboard only appears for `<input>` or `<textarea>` elements.
   Pattern: render a hidden `<input type="text" style="opacity:0">` overlaid on
   the terminal; focus it on tap; relay `input` events to `term.write()`. Handle
   `compositionstart`/`compositionend` for IME input.

3. **Viewport + keyboard resize**: When the iOS/Android soft keyboard opens,
   `window.innerHeight` changes and the terminal must refit.
   Use the **VisualViewport API** (`window.visualViewport.onresize`) rather than
   `window.resize`, because `window.resize` does not fire reliably on mobile
   when only the virtual keyboard changes size.

4. **PTY resize on mobile**: The `cmd:pty:resize` command already exists in the
   allowlist (ARCHITECTURE.md §6.2). The web app must send it whenever the
   terminal dimensions change due to viewport resize.

5. **iOS Meta key**: iOS has no Meta key. Map `Option` to `Meta` in xterm
   options: `{ macOptionIsMeta: true }`. Map `Option+letter` combos for Vim
   users.

6. **Alternative to xterm.js on mobile**: **Hterm** (Chrome OS terminal) has
   better mobile support but is older and less maintained. **xterm.js** is the
   right choice given we already have desktop expertise with it; the mobile
   limitations are workable with the key bar pattern above.

### Package version

`@xterm/xterm 5.x` (the `@xterm/` scoped packages replaced the older `xterm`
package). Confirm current minor before PRD 09 scaffolding
(`npm view @xterm/xterm version`). Directly answers open question §10.8 of
ARCHITECTURE.md.

---

## 10. Recommendation table

| Building block | Recommendation | Reason | License implication |
|---|---|---|---|
| **Relay WebSocket server** | Build with `ws` (npm) | Full protocol control; zero dependencies; correct for self-hosted single-user relay | MIT |
| **Relay HTTP server** | `fastify` v5 | Already in bilko.run; house standard | MIT |
| **Agent WS client** | `partysocket` (from PartyKit) | Best open-source auto-reconnect WS client; MIT; battle-tested | MIT (cloudflare/partykit) |
| **Browser WS client** | `partysocket` | Same library as agent; handles reconnect + backoff in both environments | MIT |
| **Google OAuth (relay server)** | `google-auth-library` (official) | Apache 2.0; most direct path; handles PKCE, token verify; no framework overhead | Apache 2.0 |
| **Session cookies (relay)** | `@fastify/cookie` + `@fastify/session` | Fastify ecosystem; HttpOnly + SameSite=Strict | MIT |
| **Google Sign-In button (web app)** | `@react-oauth/google` | Standard GIS wrapper; renders canonical button; matches ARCHITECTURE.md spec | MIT |
| **CSPRNG (OTP + tokens)** | `node:crypto.randomBytes` | Built-in; no dependency; already in spec | n/a |
| **Message validation** | `zod` | Already a dep; share envelope schema between relay and agent | MIT |
| **Token store (relay, v1)** | In-process `Map` | Simplest; acceptable given Render's no-hard-timeout guarantee; re-pair on redeploy is acceptable friction | n/a |
| **Token store (relay, v2)** | Render Redis add-on | Survives redeploys; $10/mo; trivial to add later | n/a |
| **Pairing flow** | OTP (our design, RFC 8628-informed) | Correct for "browser has auth, local app enters code" direction | n/a (spec) |
| **Device token storage (local)** | `web-remote.json` (0600) | Consistent with existing `~/.claude/session-manager/` layout; equivalent to `~/.ssh/id_rsa` security | n/a |
| **E2E encryption (PRD 10)** | `libsodium.js` (browser) + `sodium-native` (agent) | Already specified in ARCHITECTURE.md; NaCl box = DERP/Tailscale pattern | ISC / MIT |
| **Managed relay (Ably/Pusher/PartyKit)** | Do not use | Third-party operator sees payloads; per-message billing; incompatible with self-host posture | — |
| **Mobile terminal** | `@xterm/xterm 5.x` + custom key bar | Same package as desktop; known gaps workable with key bar + hidden-input pattern | MIT |
| **OAuth framework (relay)** | `google-auth-library` directly (not Auth.js) | Single provider, single user; no abstraction needed | Apache 2.0 |

---

## 11. Mobile terminal deep-dive recommendation

For PRD 09, the terminal pane must be usable on a 390px-wide viewport (iPhone 15
width). The recommended implementation:

```
[on-screen key bar: ESC · TAB · ↑ · ↓ · ← · → · CTRL · C · Z]
┌─────────────────────────────────────────────────────────────────┐
│  xterm.js canvas                                                 │
│  (ResizeObserver + xterm-addon-fit)                              │
│                                                                  │
│  hidden <input> overlaid, focused on tap,                        │
│  input events relayed to term.write()                           │
└─────────────────────────────────────────────────────────────────┘
```

Key constraints:
- Use `window.visualViewport.onresize` (not `window.onresize`) to detect soft
  keyboard open/close; send `cmd:pty:resize` after each refit.
- Key bar buttons call `term.write(sequence)` directly (e.g., `\x1b` for ESC,
  `\t` for Tab, `\x03` for Ctrl+C).
- `options: { macOptionIsMeta: true, allowProposedApi: false }` as safe defaults.
- Do not set `disableStdin: false` on mobile without the hidden-input shim — the
  canvas cannot capture soft keyboard events.

---

## 12. Decisions that update the ARCHITECTURE ADR (§10 open questions)

The following findings from this research should be reflected as explicit answers
in PRD 07–09 specs. Do NOT edit ARCHITECTURE.md here — these are the amendments
to propose when authoring those PRDs:

1. **§10.1 Render WS persistence** → RESOLVED: Render Starter imposes **no hard
   idle timeout** on WebSocket connections. Connections close only on instance
   replacement (deploy/maintenance) with a 30-second graceful shutdown window
   (extendable to 300s). The agent's existing reconnect-with-backoff logic handles
   this. No change to §2.4 needed.

2. **§10.2 Token store** → RECOMMENDATION: Start with in-process `Map`; accept
   re-pair friction on relay redeploys (infrequent for a stable relay). Add Redis
   in PRD 10 only if re-pair becomes a real pain point. State this explicitly in
   PRD 07.

3. **§10.3 Binary vs JSON for PTY** → RECOMMENDATION: Use base64-encoded JSON
   for v1 (33% size overhead is acceptable for ≤256 KiB messages; simplifies relay
   routing which assumes all messages are JSON). PRD 10 can add binary frame
   forwarding (relay passes `Buffer` directly without `JSON.parse`). Note: the
   relay must be written to detect binary frames and pass them through opaquely
   even in v1, so v2 switching does not require a relay rewrite.

4. **§10.4 OTP flow direction** → CONFIRMED: Browser shows code, local app enters
   it. Rationale: the browser session IS the authenticated identity (post-Google
   OAuth); showing the code there means the OTP is only useful to someone who is
   already authenticated. This matches Jupyter's "server shows the token" pattern
   and is the reverse of RFC 8628 but for good reason.

5. **§10.5 Token expiry** → RECOMMENDATION: No hard TTL in v1 (revoke-only). Add
   90-day expiry in PRD 10 with a silent re-pair prompt. State v1 behavior
   explicitly in PRD 07 token schema.

6. **§10.6 ALLOWED_EMAIL as list** → IMPLEMENT in PRD 07: comma-split parser from
   day one (`process.env.ALLOWED_EMAIL.split(',').map(s => s.trim())`). Zero
   migration cost; directly supported by `google-auth-library` callback pattern.

7. **§10.7 Relay URL configurability** → Hardcode in v1. Add
   `relayUrl` field to `web-remote.json` schema in PRD 08 but leave it optional
   with a hardcoded default. Self-hosting the relay is low-priority.

8. **§10.8 xterm.js version** → Use `@xterm/xterm` (scoped package, v5.x).
   Confirm exact version with `npm view @xterm/xterm version` before PRD 09
   scaffolding. `@xterm/addon-fit` + `@xterm/addon-web-links` as minimum addons.

9. **§10.9 bilko.run deploy coordination** → No change needed. The dual-push
   contract in `docs/deployment.md` of the Bilko repo applies; PRD 09 must
   include the `standalone-projects.json` patch as a checklist item.

10. **§10.10 CSP via `_headers` file** → CONFIRMED: Render Static Sites support
    a `_headers` file at the root of the build output directory (same convention
    as Netlify `_headers`). The web app's `vite.config.ts` should copy
    `public/_headers` to `dist/_headers` in the build step. PRD 09 must include
    this file with at minimum:
    ```
    /*, Content-Security-Policy: default-src 'self'; connect-src 'self' wss://relay.session-manager.bilko.run; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'
    ```
    Verify `_headers` support in Render Static Site docs before finalising PRD 09
    (the format is confirmed working in Netlify; Render support should be
    double-checked).

---

## 13. Sources

- [VS Code Remote Tunnels docs](https://code.visualstudio.com/docs/remote/tunnels)
- [Tailscale DERP servers](https://tailscale.com/docs/reference/derp-servers)
- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)
- [Tailscale encryption](https://tailscale.com/kb/1504/encryption)
- [Render WebSockets docs](https://render.com/docs/websocket)
- [RFC 8628 — OAuth 2.0 Device Authorization Grant](https://datatracker.ietf.org/doc/html/rfc8628)
- [Syncthing device IDs](https://docs.syncthing.net/dev/device-ids.html)
- [Jupyter Server security](https://jupyter-server.readthedocs.io/en/latest/operators/security.html)
- [ngrok agent docs](https://ngrok.com/docs/agent)
- [localtunnel server (GitHub)](https://github.com/localtunnel/server)
- [Ably pricing](https://ably.com/pricing)
- [Pusher pricing](https://pusher.com/pricing)
- [PartyKit (GitHub, MIT)](https://github.com/cloudflare/partykit)
- [PartyKit acquired by Cloudflare](https://blog.cloudflare.com/cloudflare-acquires-partykit/)
- [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Cloudflare DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [google-auth-library-nodejs (GitHub)](https://github.com/googleapis/google-auth-library-nodejs)
- [Auth.js Google provider](https://authjs.dev/getting-started/providers/google)
- [xterm.js mobile support issue #5377](https://github.com/xtermjs/xterm.js/issues/5377)
- [xterm.js mobile platform issue #1101](https://github.com/xtermjs/xterm.js/issues/1101)
- [Render community: WebSocket disconnection](https://community.render.com/t/websocket-disconnection/36492)
