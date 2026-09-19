# web/remote-app/ — scoped context

WEB PRESENCE (see [`project-partition.md`](../../session-manager-operations/architecture/project-partition.md)).
A **separate npm project** — its own `package.json`, vite, tsconfig and playwright config. The root
repo's runners do not reach it.

## What's here

The mobile cockpit shipped at `bilko.run/projects/session-manager/`: a session-centric phone app
over the bilko.run relay. `src/` holds `App.tsx`, the zustand `store.ts`, the relay client `ws.ts`,
`api.ts`, `e2eKeyStore.ts` and `components/`. `scripts/emit-manifest.mjs` writes the host-contract
`dist/manifest.json`. `tests/` holds the vitest suite plus `golden.spec.ts`.

Commands run **from this directory**: `npm ci`, `npm run dev`, `npm run typecheck`,
`npm run build` (tsc → vite build → emit-manifest), `npm test`, `npm run test:e2e`.

## Locked decisions

These were fixed at design time (2026-06-07) and still hold — changing one is a product decision,
not a refactor.

| Decision | Choice | Consequence |
| --- | --- | --- |
| App hosting | `static-path` sibling at `bilko.run/projects/session-manager/` | Published by dropping `dist/` into the Bilko repo + dual-push (or the `bilko-host` MCP). No DNS/Render/OAuth of its own. Must pass the host gates. |
| Relay hosting | Same-origin on the bilko.run Fastify host — `wss://bilko.run/projects/session-manager/relay` | Covered by the host's `connect-src 'self'`, so it survives CSP enforcement and shares host uptime. |
| Browser auth | The host's **Clerk** (replaced v1's Google-OAuth-in-relay) | The relay route runs inside the host, so `requireAuth(req)` is available. Pairing ties a Clerk user to a device. |
| Voice | Browser **Web Speech API** → text → `cmd:pty:write` | `Permissions-Policy: microphone=(self)` is live on bilko.run. **No audio ever crosses the wire.** iOS Safari is best-effort. |
| Mobile summary | Local agent + Claude Haiku (`claude-haiku-4-5-20251001`), pushed to the phone | The desktop transcript is unchanged. Needs an Anthropic API key on the local machine, separate from OAuth billing. |

**Bundle budget: 200 KB gz.** xterm is deliberately absent from the critical path — it was v1's
single biggest weight and the v2 flow (summary + mic + state) does not need it. Any raw-terminal
view must be lazy-loaded behind a route. Keep the dependency set minimal.

## Who consumes this

`bilko.run` serves the built `dist/`. The app talks only to the relay route on that same host.

## What must NOT be assumed

- **The relay is NOT in this repo.** The live one is `~/Projects/Bilko/server/sm-relay/router.ts`,
  a diverged port. `web-remote/relay/` here is dead — see [`web-remote/CLAUDE.md`](../../web-remote/CLAUDE.md).
  Root `CLAUDE.md`'s law stands: never decommission the deployed relay.
- The root `npm test` / `npm run typecheck` do **not** cover this directory; run them here.
- `dist/` and `node_modules/` are build output — never hand-edit.
- `render.yaml` describes a deploy target that is not how this ships today (the static-path drop is).
