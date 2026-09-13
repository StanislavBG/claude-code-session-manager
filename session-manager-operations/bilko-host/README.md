# Host on Bilko.run — generated artifact (split ownership)

Canonical spec: [`session-manager-operations/architecture/bilko-host-integration.md`](../architecture/bilko-host-integration.md)
— read it before touching anything in this folder. This README only
documents what's on disk; the spec is the source of truth for the pipeline.

## What's here

```
session-manager-operations/bilko-host/
  documents.json      — the hosted document list (root doc + any sub-path
                         docs); source of truth for dist/ — seeded with a
                         single root document on first prepare
  dist/                — fully rebuilt on every Prepare Bundle run (rm -rf
                         then rewrite from documents.json); NOT tracked by
                         git — swallowed by the bare `dist` pattern in the
                         root .gitignore, same as any other `dist/` in this
                         repo. Disposable regenerated output, no retention
                         obligation.
    <subpath>/index.html — one HTML file per document in documents.json
                         (the root document lands at dist/index.html)
    manifest.json      — host-contract manifest (schemaVersion, slug,
                         version, gitSha/gitBranch, golden.path/expect,
                         bundle size, documentCount/documents[])
    assets/, dashboard/, _headers — present on disk today but NOT written
                         by prepareBundle itself; the next Prepare Bundle
                         run's rm -rf removes them along with everything
                         else under dist/
  publish-state.json  — { status, slug, url?, lastAttemptAt?, lastError? }
  tests/               — (only if a golden-path gate needed one) a minimal
                         Playwright spec the bilko-host-publisher Epic authored
```

## Who writes what — split ownership, unlike most ops folders

Unlike a normal single-writer `OWNERS` namespace, this folder has **two**
legitimate writers for different files:

- **`documents.json` + everything under `dist/`** — written by this app's
  own main process (`src/main/bilkoHost.cjs`'s `prepareBundle`, IPC
  `bilko-host:prepare-bundle`), through `config.cjs`'s write helpers with
  writer id `bilko-host`. `prepareBundle` `rm -rf`'s the whole `dist/` tree
  before rewriting it (one `index.html` per document, plus
  `dist/manifest.json`) so it can never drift from `documents.json`. This
  part IS `OWNERS`-enforceable (`src/main/lib/opsOwnership.cjs`) — a second
  writer here would be refused.
- **`publish-state.json` and anything under `tests/`** — written by the
  `bilko-host-publisher` Epic's own claude session, directly, with its own
  `Write` tool. There is no IPC call for these, so `assertOpsWrite` cannot
  intercept them — same unenforceable-by-construction class as
  `project-pages/output/*` (see that folder's own README for the full
  explanation of why).

## Why bundle prep and publish are split this way

`dist/` is a pure, deterministic transform (no LLM, no network) — safe to
run from the main process on a button click. Publishing has to react to
`~/Projects/Bilko`'s own gate requirements (manifest schema, size budget,
golden-path spec, a11y, audit), which can change independently of this
app's release cycle — so it runs as an ordinary Epic that reads the current
gate code live rather than a hardcoded main-process implementation that
would silently drift. See the architecture spec's "Two-stage pipeline"
section for the full reasoning.
