# web/remote-app/ — scoped context

WEB PRESENCE partition — see [`project-partition.md`](../../session-manager-operations/architecture/project-partition.md).

## What's here

The phone-remote PWA (`@session-manager/app`): a **separate npm project** with its own
`package.json`, vite, tsconfig and playwright config. Run from this directory:
`npm ci`, `npm test` (vitest), `npm run typecheck`, `npm run build` (tsc + vite +
`scripts/emit-manifest.mjs`, which writes the host-contract `dist/manifest.json`).
Root `npm run test:unit` / `test:e2e` do NOT cover it (root `playwright.config.ts` `testIgnore`).

`tests/golden.spec.ts` is run by **no config**: this project's playwright `testDir` is
`src/__tests__` (`*.e2e.ts`), and the spec targets a live `/projects/session-manager/` URL,
which `vite preview` does not serve. It stays unrun; it is the Bilko publish-gate probe.

## Two deploy targets — do not conflate

1. **Bilko static-path copy** at `bilko.run/projects/session-manager/` — the live one. `dist/`
   is copied into `~/Projects/Bilko` **by hand**; no script automates it.
2. **Standalone Render static site** declared by `render.yaml` (`sm-app`,
   `session-manager.bilko.run`) — not how this ships today.

Bundle budget 200 KB gz; xterm stays off the critical path. Voice is browser Web Speech →
text; no audio crosses the wire. Browser auth is the host's Clerk.

## Who consumes this

`bilko.run` serves the built `dist/`. The app talks only to the relay route on that host.

## What must NOT be assumed

- Editing here does **not** redeploy anything by itself.
- The relay is NOT in this repo. The live one is `~/Projects/Bilko/server/sm-relay/router.ts`;
  `web-remote/relay/` is dead — see [`web-remote/CLAUDE.md`](../../web-remote/CLAUDE.md).
  Never decommission the deployed relay (root `CLAUDE.md`).
- `dist/` and `node_modules/` are build output — never hand-edit.
