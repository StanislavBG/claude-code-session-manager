# Host on Bilko.run — generated artifact (split ownership)

Canonical spec: [`session-manager-operations/architecture/bilko-host-integration.md`](../architecture/bilko-host-integration.md)
— read it before touching anything in this folder. This README only
documents what's on disk; the spec is the source of truth for the pipeline.

## What's here

```
session-manager-operations/bilko-host/
  dist/
    index.html      — this project's Marketing Project Page, verbatim
    manifest.json    — host-contract manifest (schemaVersion, slug, version,
                        gitSha/gitBranch, golden.path/expect, bundle size)
  publish-state.json — { status, slug, url?, lastAttemptAt?, lastError? }
  tests/              — (only if a golden-path gate needed one) a minimal
                        Playwright spec the bilko-host-publisher Epic authored
```

## Who writes what — split ownership, unlike most ops folders

Unlike a normal single-writer `OWNERS` namespace, this folder has **two**
legitimate writers for different files:

- **`dist/index.html` + `dist/manifest.json`** — written by this app's own
  main process (`src/main/bilkoHost.cjs`'s `prepareBundle`, IPC `bilko-host:
  prepare-bundle`), through `config.cjs`'s write helpers with writer id
  `bilko-host`. This part IS `OWNERS`-enforceable (`src/main/lib/
  opsOwnership.cjs`) — a second writer here would be refused.
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
