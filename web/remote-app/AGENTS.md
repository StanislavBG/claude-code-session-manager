# web/remote-app/ — scoped context

WEB PRESENCE partition — see [`project-partition.md`](../../session-manager-operations/architecture/project-partition.md).

## What's here

The phone-remote PWA (`@session-manager/app`): a **separate npm project** with its own
`package.json`, vite, tsconfig and playwright config. Run from this directory:
`npm ci`, `npm test` (vitest), `npm run typecheck`, `npm run build` (tsc + vite +
`scripts/emit-manifest.mjs`, which writes the host-contract `dist/manifest.json`).
Root `npm run test:unit` / `test:e2e` do NOT cover it (root `playwright.config.ts` `testIgnore`).
`npm test`: vitest runs `src/**/*.{spec,test}.{ts,tsx}`; name new tests `*.spec.*`.

`tests/golden.spec.ts` is run by **no config** (playwright `testDir` is `src/__tests__`, `*.e2e.ts`);
it targets a live `/projects/session-manager/` URL `vite preview` can't serve — the Bilko publish-gate probe.

## Two deploy targets — do not conflate

1. **Bilko static-path copy** at `bilko.run/projects/session-manager/` — the live one. After
   `npm run build`, `node scripts/vendor-to-bilko.mjs` copies `dist/` into `~/Projects/Bilko`
   (`--target`/`--dist` override). Committing/pushing `~/Projects/Bilko` stays a human/architect step.
2. **Standalone Render static site** declared by `render.yaml` (`sm-app`,
   `session-manager.bilko.run`) — not how this ships today.

xterm stays off the critical path. Voice is browser Web Speech →
text; no audio crosses the wire. Browser auth is the host's Clerk.

## Desktop command protocol

Phone → desktop commands over the relay (stateless; drill down projects → sessions → chat):

- `cmd:projects:list` — projects.
- `cmd:project:sessions` — list a project's sessions (Epics).
- `cmd:session:transcript` — recent chat messages of a session.
- `cmd:session:prds` — PRDs attached to a session.
- `cmd:session:options` — agents, tags, macros, and the `macroInputs` capability flag.
- `cmd:session:create` — start a session; optional `macroId` + `inputs`, the desktop renders the macro's `{{name}}` placeholders.
- `cmd:app:info` — SAS-gated; version, platform, hostname (names desktops in the switcher).
- `cmd:chat:send` — send a prompt (target = epicId or main tab id). Optional `images` (≤6 `{name,mime,data}` base64) become `Attached:` lines; send only if `event:remote:ready` lists `chat-images`.
- `cmd:session:subscribe` — stream live updates for one session.
- `event:remote:ready` — desktop → phone: bridge up.
- Key-pinned browser: boxed `event:remote:ready` precedes plaintext `e2e:ready`; `RelaySocket` holds early boxes until `sas:pending` is decided.
- `e2e:rekey` — desktop → phone (plaintext): drop the session key and re-send `e2e:hello`; pinned phones re-authenticate without SAS.

A signed-in browser can drive any paired desktop, chosen in the header switcher (`src/devices.ts`).
Phone-class browsers (`PHONE_QUERY` in `src/viewMode.ts`) get the drill-down as primary UI, never the desktop renderer; wider browsers get the full UI; the header toggle overrides this, stored under `sm-remote-view-mode`.

`bilko.run` serves the built `dist/`; the app talks only to that host's relay route.

## What must NOT be assumed

- Editing here redeploys **nothing**.
- The relay is NOT in this repo. The live one is `~/Projects/Bilko/server/sm-relay/router.ts`;
  `web-remote/relay/` is dead — see [`web-remote/AGENTS.md`](../../web-remote/AGENTS.md).
  Never decommission the deployed relay (root `AGENTS.md`).
- `dist/`, `node_modules/` are build output — never hand-edit.
- Drill-down screens fill Cockpit's `<main>` (`flex-1 min-h-0`), never viewport-height classes (`h-dvh`, `h-screen`, `100vh`): a nested `h-dvh` clipped the composer (2026-11-15).
- [Relay rules](RELAY.md)

## Share image

`public/og.png` (1200x630) is the bilko.run `listing.shareImage` — X preview + `/projects` hero.
Source `og/og.html`; re-render: `node og/render-og.mjs`. Declared in `bilko.listing.json`.
