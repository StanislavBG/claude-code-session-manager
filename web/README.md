# web/ — the WEB PRESENCE partition

This directory collects every producer of content displayed on **bilko.run**. It is one of the
four partitions described in
[`session-manager-operations/architecture/project-partition.md`](../session-manager-operations/architecture/project-partition.md)
— PRD 1184 made this partition PHYSICAL so the boundary is visible in the tree, not just on
paper.

**The user-facing pages themselves are NOT here.** They live in `~/Projects/Bilko`, a sibling
repo. This directory only holds the tooling that *produces* what Bilko serves:

- `manual/` — builds and captures figures for the Field Manual, the paid product sold at
  bilko.run/manual. Source content lives in `session-manager-operations/manual/` (OPERATIONS
  STATE, unmoved); output lands in `~/Projects/Bilko/data/manual/releases/`.
- `remote-app/` — the phone-remote PWA, the live source of the bundle published at
  `bilko.run/projects/session-manager/`. A **separate npm project** with its own install/test/build
  that root test runners ignore; see [`remote-app/CLAUDE.md`](remote-app/CLAUDE.md).

`web/manual/build.mjs` and `web/manual/capture-figures.mjs` are the only manual builders.

Archived web-remote ADRs: see `docs/README.md` (link target may not exist yet).

## Staged for extraction

This directory is staged for a future `git subtree split --prefix=web` into its own repo. That
split has NOT happened yet — this PRD only collected the partition under one path so the split
becomes mechanical later. Before actually running it, the human still needs to decide:

- **Reverse edge into `src/renderer`.** `web/manual/__tests__/figure-captures.test.cjs` imports
  `src/renderer/lib/navGroups`, so `web/` is not self-contained — undecided (the remaining blocker).
- `web-remote/relay/` is dead code that was deliberately NOT moved here — it stays where it is
  pending a separate decision on whether to delete it.
