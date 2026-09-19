# web/ — the WEB PRESENCE partition

This directory collects every producer of content displayed on **bilko.run**. It is one of the
four partitions described in
[`session-manager-operations/architecture/project-partition.md`](../session-manager-operations/architecture/project-partition.md)
— PRD 1184 made this partition PHYSICAL so the boundary is visible in the tree, not just on
paper.

**The user-facing pages themselves are NOT here.** They live in `~/Projects/Bilko`, a sibling
repo. This directory only holds the tooling that *produces* what Bilko serves:

- `project-pages/` — legacy renderer toolchain for the old multi-page Project Pages (Project Home is now
  a single agent-written `home.html`; see `session-manager-operations/project-pages/README.md`). Consumed by the `project-home-builder` agent
  persona and by `src/main/lib/projectHomeAdminRoutes.cjs` (an Electron IPC handler that stays
  in `src/main/` — it's DESKTOP HARNESS runtime that *calls* this WEB PRESENCE toolchain, not
  part of it).
- `manual/` — builds and captures figures for the Field Manual, the paid product sold at
  bilko.run/manual. Source content lives in `session-manager-operations/manual/` (OPERATIONS
  STATE, unmoved); output lands in `~/Projects/Bilko/data/manual/releases/`.
- `remote-app/` — the phone-remote PWA, the live source of the bundle published at
  `bilko.run/projects/session-manager/`.

## Staged for extraction

This directory is staged for a future `git subtree split --prefix=web` into its own repo. That
split has NOT happened yet — this PRD only collected the partition under one path so the split
becomes mechanical later. Before actually running it, the human still needs to decide:

- **How the extracted repo reaches `src/main`'s IPC handlers.** `projectHomeAdminRoutes.cjs`
  currently reads the `project-pages/renderer/dist/` and `project-pages/logic/dist/` bundles by
  a relative path assuming both live in the same repo checkout. Once `web/` is a separate repo,
  something has to publish those bundles somewhere the harness can still read them (a build
  step that vendors them back in, a package dependency, a fetched artifact — undecided).
- **Who then owns the npm `files` array entries.** `package.json`'s `files` array currently
  lists `web/project-pages/render.cjs`, `web/project-pages/renderer/dist/`,
  `web/project-pages/logic/dist/`, and `web/project-pages/validate-summary.cjs` directly. If
  `web/` moves to its own repo, either the harness repo re-vendors those specific build outputs
  before packing, or the split repo publishes them and the harness repo depends on that package
  — undecided.
- `web-remote/relay/` is dead code that was deliberately NOT moved here — it stays where it is
  pending a separate decision on whether to delete it.
