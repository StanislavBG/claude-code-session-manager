# Project Pages — one generated overview page

The whole Project Home page is ONE self-contained HTML file:

```
session-manager-operations/project-pages/
  home.html   — overview: what it is, who it's for, structure, how to run, key commands
```

## Who writes it

A `project-home-builder` Epic reads the real project (persona:
`src/seed/agents/project-home-builder.md`) and calls the `project_home_write`
MCP tool once with the full HTML. The tool posts to
`/admin/project-home/write` (`src/main/lib/projectHomeAdminRoutes.cjs`), which
validates the document (<= 1 MB; no `<script src>`, remote `<link>`,
`@import`, or remote `url(...)`) and writes `home.html` through `config.cjs`'s
`writeTextAtomic` as writer `project-home`. `project-pages` is an `OWNERS`
namespace (`src/main/lib/opsOwnership.cjs`), so that route is the only sanctioned writer.

## Who reads it

`src/main/projectPages.cjs` is read-only: `project-pages:get` plus a per-cwd
watcher that pushes `project-pages:changed` to Project Home, which shows the
page in a sandboxed frame. The Host-on-Bilko.run tab also reads `home.html` as
its default root document (see
[`bilko-host-integration.md`](../architecture/bilko-host-integration.md)).

There is no summary, picks, or per-lens output; a project with no `home.html`
shows an empty state with a Generate action.
