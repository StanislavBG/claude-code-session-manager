# web-remote/ — scoped context

Part of the **WEB PRESENCE** partition — see
[`project-partition.md`](../session-manager-operations/architecture/project-partition.md).

## What's here

- `app/` — the phone-remote PWA. **This is the LIVE SOURCE** of the bundle published to
  `bilko.run/projects/session-manager/`. Verified 2026-09-12: the live manifest there
  (`~/Projects/Bilko/public/projects/session-manager/manifest.json`) records
  `"gitSha": "69c1d7a"`, which is this repo's last commit touching `web-remote/` — i.e. the
  deployed bundle and this folder are in sync, not drifted.
- `relay/` — **DEAD.** Superseded by a diverged port at `~/Projects/Bilko/server/sm-relay/router.ts`,
  whose own file header literally says `Ported from session-manager web-remote/relay/src/router.ts`.
  Changes here do not reach production. Do not delete it in the course of unrelated work — that's a
  separate decision the human hasn't made yet.

## What must NOT be assumed

- Do **not** assume editing `app/` here requires a separate deploy step you need to trigger —
  check how `~/Projects/Bilko` currently pulls/builds this bundle before assuming it's automatic
  or manual.
- Do **not** edit `relay/` expecting it to affect the live relay. The live relay is
  `~/Projects/Bilko/server/sm-relay/router.ts`, a different, diverged file.
- Do **not** decommission, delete, or route around **the bilko.run relay itself** (the deployed
  service, not this dead folder) — root `CLAUDE.md`'s law: *"The bilko.run relay stays live —
  desktop half of web remote removed 2026-08-06 (restore `b014cc2`)."* That law is about the
  running production relay, unaffected by anything in this folder.
- Do not assume `~/Projects/Bilko` is in scope for changes made while working in this repo — it's
  a separate repo; see root `CLAUDE.md`'s Out-of-scope conventions for cross-repo boundaries.
