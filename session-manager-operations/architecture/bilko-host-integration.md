# Host on Bilko.run — architecture spec

Canonical design for the **"Host on Bilko.run"** Configure-face left-nav tab: a
per-project surface that turns an already-generated [Project Page](project-pages-pipeline.md)
(the `marketing` lens) into a real listing on bilko.run, with a one-click
**Publish** action. This is the single source of truth for the `bilko-host`
OWNERS namespace, the `bilko-host-publisher` Epic tag + local agent, and the
`HostBilko.tsx` tab — edit here, not in any of those, when the design
changes.

## Bilko.run already has a self-service publish pipeline — use it, don't rebuild it

`~/Projects/Bilko` (the sibling repo backing bilko.run) is a host **platform**:
apps declare a `host.kind` in its project registry —
`react-route` (tightly coupled, shares Bilko's own Vite bundle/Fastify
server/auth/Stripe), `static-path` (loose — host just serves prebuilt static
bytes at `/projects/<slug>/`, **the default for new/sibling apps**), or
`external-url` (just a link). The full contract is
`~/Projects/Bilko/docs/host-contract.md`.

Critically, Bilko already ships **`mcp-host-server`**
(`~/Projects/Bilko/mcp-host-server/`, built, `dist/server.js` present) — an
MCP server explicitly designed for sibling-repo Claude sessions to publish
themselves **without hand-editing the Bilko repo**:

| MCP tool | Purpose |
| --- | --- |
| `get_host_contract` | returns `docs/host-contract.md` verbatim — ground the agent on current rules, never hardcode them |
| `list_projects` | check whether a slug is already registered |
| `register_static_project` | writes the registry entry (first publish only) |
| `publish_static_project` | copies a built `dist/` into `public/projects/<slug>/`, gated by 5 checks (manifest schema, size budget, a Playwright "golden path" spec, an a11y scan, `pnpm audit`), commits + pushes `origin/main` (Render auto-deploys) |
| `unregister_project` | remove a listing |
| `status` | git status / last commits, to confirm a publish landed |

This means **"Host on Bilko.run" is a thin cockpit over tools that already
exist**, not a new hosting mechanism. Nothing in this design re-implements
registry writes, gates, or deploy triggering — those stay Bilko's
responsibility, invoked through the MCP. Do not add a second, competing
publish path (e.g. hand-writing to `standalone-projects.json` via `gh`/raw
git from this app) — that would drift from Bilko's own gates and rules.

**Known landmine (flag, don't route around silently):** as of this design's
research (2026-08-02), `mcp-host-server`'s commit step still attempts to
push to a second, retired `content-grade` remote in addition to `origin` —
Bilko's own `CLAUDE.md` says that remote's history has diverged and pushes
there are expected to fail harmlessly. The `bilko-host-publisher` agent
persona (below) is told explicitly to treat a `content-grade` push failure
in the tool's output as expected noise, not a publish failure — checking
`origin`'s push result and the final `status` call is what actually confirms
success.

**Two separate deploy targets exist for session-manager specifically — don't
conflate them.** `~/Projects/session-manager/web-remote/app/` (the mobile
cockpit) already has its own `render.yaml` deploying to a standalone
`session-manager.bilko.run` Render *static site* — a parallel, ungated,
direct-git-push pipeline unrelated to the Bilko monorepo's registry/gates.
"Host on Bilko.run" in this design means the **Bilko-repo `static-path`
route** (`bilko.run/projects/<slug>/`, the gated MCP pipeline) exclusively.
The `web-remote/app` Render site is out of scope here and unaffected.

## One Bilko project, many hosted documents

A Bilko `static-path` app is **one registry slug pointing at one directory
tree** (`public/projects/<slug>/`), served verbatim by Fastify static —
there is nothing in Bilko's host contract that requires that tree to
contain only a single page. So "host N explanatory HTMLs alongside the
project itself, as one Bilko project, not N" doesn't need any new Bilko
capability: it's a `dist/` tree with more than one HTML file in it.

This app therefore models a project's Bilko presence as **one document
list**, not one document:

- Exactly one **root document** (`subpath: ''`) → `dist/index.html` →
  `bilko.run/projects/<slug>/`. This is "the project itself" — by default
  the Marketing Project Page, same as the original single-document design.
- Any number of **sub-path documents** (`subpath: 'special-doc/01'`) →
  `dist/special-doc/01/index.html` → `bilko.run/projects/<slug>/special-doc/01/`.
  A document's `source` is either another already-generated Project Page
  lens (`{ kind: 'project-page-lens', lens: 'home'|'feature'|'architecture' }`
  — `marketing` is reserved for the root) or an arbitrary local HTML file
  under the project (`{ kind: 'file', path }` — e.g. a `HUMAN_LEARN/` page).

Stored in `session-manager-operations/bilko-host/documents.json`
(`{ documents: [{ id, subpath, title, source, addedAt }] }`), owned by the
`bilko-host` namespace same as `dist/`. Add/remove is a plain IPC round-trip
(`bilko-host:add-document` / `bilko-host:remove-document`) — no Epic
involved, since it's just editing a list, not generating content or talking
to Bilko.

### Deletion — confirmed mechanism, not a guess

`removeDocument` only edits `documents.json`. Whether that document
actually disappears from bilko.run depends entirely on Stage A + Stage B
running again — and that's guaranteed to work because
`~/Projects/Bilko/mcp-host-server/src/server.ts`'s `publish_static_project`
does, verbatim: `await rm(target, { recursive: true, force: true })` then
`cp -r distAbs target` on **every** publish — a full wholesale replace of
`public/projects/<slug>/`, never a merge. So:

1. `prepareBundle` (Stage A) rebuilds `dist/` from scratch every time
   (`rm` then rewrite from the current `documents.json`) — the bundle on
   disk can never contain a document that's no longer in the list.
2. The next successful Publish (Stage B) replaces the *entire* live
   directory with that bundle — a document missing from `dist/` is
   therefore guaranteed missing from the live site afterward.

There is deliberately no separate "delete this one live document" API call
— re-running the existing publish pipeline over an updated `dist/` already
does it correctly, and reusing one mechanism instead of adding a second
narrower one halves the surface that can drift from Bilko's actual
behavior. The tab surfaces this honestly: removing a document immediately
updates the local list, but `get()`'s `bundleStale` flag (and, once
published, the fact that the old URL is still live) makes clear that
**Publish**, not the Remove click, is what takes it down — never implying
a deletion is live before it actually is.

## Why this builds on Project Pages instead of inventing new content

Project Home already computes, per project, a static self-contained
`marketing.html` (`session-manager-operations/project-pages/output/
marketing.html`) from a `ProjectPageSummary` that traces every field back to
something real. That artifact — not new copy written by this feature — is
what gets published. A project with no `project-pages/output/marketing.html`
yet cannot publish; the tab's empty state deep-links to Project Home's
"Generate Now" first (same handoff Project Pages' own empty state uses).

## Two-stage pipeline: deterministic bundle prep, then an agent-driven publish

Publishing a project onto bilko.run has one deterministic half (build the
static bundle bytes) and one half that must react to Bilko's own
possibly-changing gate requirements (satisfying `publish_static_project`'s
manifest/budget/golden/a11y/audit checks) — so it's split the same way
Project Pages splits deterministic rendering from agent-authored content:

### Stage A — Bundle (deterministic, main-process, this app's own IPC)

`src/main/bilkoHost.cjs`, IPC `bilko-host:prepare-bundle`, writer id
`bilko-host` (new OWNERS namespace). Reads `documents.json` (see "One Bilko
project, many hosted documents" above) plus each document's source
(`project-pages/output/<lens>.html` or an arbitrary local file) + the
project's `package.json`. **Wholesale rebuild, not an incremental patch**:
`rm -rf session-manager-operations/bilko-host/dist/` then rewrite every
document from the current list —

- one `dist/<subpath or index>.html` per document, byte-for-byte from its
  source (never re-authored here; Project Pages/the source file already
  owns "is this content honest").
- one `dist/manifest.json` for the whole bundle — schema per
  `docs/host-contract.md` §Manifest contract (`schemaVersion`, `slug`,
  `version` from `package.json`, `builtAt`, `gitSha`/`gitBranch` via
  `git rev-parse`, `hostKit.version`, `golden.path`/`golden.expect` — always
  pointed at the root document, `bundle.sizeBytesGz`/`fileCount` summed
  across all documents) — mirrors the pattern already proven in
  `web-remote/app/scripts/emit-manifest.mjs`, generalized from one Vite
  build to N static HTML files.

Pure/no-LLM, same "Prepare Bundle" cost-free button pattern as everywhere
else pure computation is exposed as a manual trigger. Idempotent and safe
to re-run any time the document list changes — the `rm` first is exactly
what makes a removed document impossible to leave behind by accident. Slug
defaults to the project's directory name (kebab-cased), editable in the tab
before first publish — `register_static_project` will refuse a taken slug,
surfaced as a toast, not silently retried with a mangled name.

### Stage B — Publish (agent-driven, `bilko-host-publisher` Epic)

The gates (`manifest`/`budget`/`golden`/`a11y`/`audit`) live in
`~/Projects/Bilko/mcp-host-server/src/gates/*.ts` and can change shape
independently of this app's release cycle — especially the **golden**
gate, which requires a `tests/golden.spec.ts` Playwright spec to exist
*somewhere Bilko's tool can run it* (asserting the published page loads and
its title/content matches `manifest.golden.expect`). Hardcoding a golden
spec generator in this app's own main process would silently drift the day
Bilko's gate contract changes. So Stage B is an ordinary Epic (TAB-scoped,
runs in the *source* project's own tab — no cross-repo Epic needed, because
the MCP tool does the cross-repo write, not this app):

1. Human clicks **Publish** in `HostBilko.tsx`. If no bundle exists yet,
   Stage A runs first automatically (bundle prep has no meaningful "skip"
   state — it's free and idempotent).
2. `bilko-host:publish` IPC creates (or resumes, same "refuse a second live
   session" guard `deleteEpic`/Project Pages already use) an Epic tagged
   `bilko-host-publisher` in the current project's tab. Opening prompt
   (built by `lib/epicIntake.ts`'s existing AIM composer) embeds: the
   absolute `dist/` path, the slug, and the instruction to call
   `bilko-host__get_host_contract` and read
   `~/Projects/Bilko/mcp-host-server/src/gates/*.ts` **live** before doing
   anything else — never assume a cached understanding of the gates.
3. The Epic's session runs the documented MCP sequence: `list_projects`
   (slug check) → `register_static_project` (first publish only) →
   author whatever `tests/golden.spec.ts` + minimal package scaffold the
   *current* golden gate actually requires (written under
   `session-manager-operations/bilko-host/`, alongside `dist/` — this part
   is properly agent-authored artifact output, same class as
   `project-pages/output/*`, not an OWNERS-enforced write) →
   `publish_static_project` → `status` to confirm. On any gate failure, the
   Epic reports the specific failing gate and does **not** retry with
   `bypass`/`bypassReason` on its own initiative — bypassing a gate is a
   human decision, surfaced back to the human, never auto-applied.
4. The Epic writes `session-manager-operations/bilko-host/publish-state.json`
   (`{ status, slug, url, lastAttemptAt, lastError? }`) as its own final
   step — same agent-Write-tool pattern `project-pages/output/manifest.json`
   already uses, not a second IPC round-trip.

`HostBilko.tsx` reads `publish-state.json` (via `bilko-host:get`) to render
status: `not-published` → `bundle-ready` → `publishing` (Epic active) →
`published` (with the live `bilko.run/projects/<slug>/` link) →
`publish-failed` (with the reported gate + a retry button, which just
re-runs Stage B).

## Compatibility gate (Stage 0)

Before showing "Publish" at all:

1. No `project-pages/output/marketing.html` → **"Generate a Project Page
   first"**, deep-links to Project Home.
2. `package.json` has `"private": true` and no `homepage`/npm publish
   history → require an explicit extra confirm click before Stage A runs
   (never silently bundle a project that's never been public).
3. Slug already registered under a *different* `sourceRepo` in Bilko's
   registry (checked via `list_projects` at Stage B time, not guessed
   client-side) → block with a clear "slug taken by &lt;other repo&gt;"
   message; publishing never silently overwrites someone else's listing.

## Left-nav wiring

- New `NavKey`: `'bilko-host'`, Configure face, project-scoped (same group
  as `agent-library`/`tag-library`).
- `HostBilko.tsx` (new, `components/tabs/`) — single-panel status card
  (compat check → bundle preview/Prepare Bundle → Publish → live status),
  reusing `ph-primitives.tsx` visuals where they overlap rather than a third
  copy of empty-state/status-pill components.
- No new zustand store — `bilko-host:get` reads the same small-JSON-files
  pattern `project-pages:get` already uses.

## `config.cjs`'s write-boundary allowlist

`src/main/config.cjs`'s `validateWrite` has a second, narrower gate on top
of `OWNERS`: a hardcoded per-namespace allowlist of which
`session-manager-operations/<namespace>/` subtrees a project root may
actually write to at all (`browser`, `feedback`, `prompt-sessions`,
`scheduler`, `project-brief` each have their own carve-out). `bilko-host`
needed the same carve-out added — without it every `config.writeJson`/
`writeTextAtomic` call in `bilkoHost.cjs` throws "Write outside allowed
write boundaries" regardless of `OWNERS`, since `OWNERS` and this allowlist
are two independent checks that both have to pass. Any future namespace
that writes through `config.cjs`'s helpers needs both, not just an `OWNERS`
entry — caught here by the integration test actually exercising a real
`prepareBundle` call against a temp project dir instead of only unit-testing
the pure logic.

## `bilko-host` OWNERS namespace

Added to `OWNERS` in `src/main/lib/opsOwnership.cjs`: `'bilko-host':
'bilko-host'`. Only `dist/manifest.json` + `dist/index.html` are written by
this app's own IPC (Stage A, enforceable — same class as `project-brief`).
`publish-state.json` and anything the Epic authors under `bilko-host/`
beyond `dist/` (e.g. a golden-spec scaffold) is agent-Write-tool output, same
unenforceable-by-construction class as `project-pages/output/*` — document
this split explicitly in `session-manager-operations/bilko-host/README.md`
once the first file lands, mirroring `project-pages/README.md`'s own
"why this is NOT [fully] an OWNERS namespace" explanation.

## Epic tag: `bilko-host-publisher`

Added to `EpicTag` (`tagLibrary.ts`) and `AGENT_TAG_DEFS`
(`agentTagDefs.ts`), `developEagerness: 'expected-default'` (same as
`project-home-builder` — running the publish sequence is the expected next
step, not a discussion). Like `build` and `project-home-builder`, **not**
added to the New Epic composer's `AGENT_TAG_ORDER` — its only creation path
is the Publish button in `HostBilko.tsx`.

## `.mcp.json` wiring

This repo's `.mcp.json` gets a new `bilko-host` server entry pointing at
`~/Projects/Bilko/mcp-host-server/dist/server.js` (absolute path, mirrors
the exact snippet `docs/host-contract.md` documents for sibling repos) —
this alone makes `bilko-host__*` tools available to *any* Claude Code
session in this repo, not just Epics; ordinary `/develop` sessions can use
it too once wired.

## Non-goals for v1

- No automatic Render deploy polling — `publish_static_project`'s `status`
  call plus a human hitting the live URL is the confirmation loop; no
  webhook integration.
- No auto-bypass of a failing gate, ever — a human decides.
- No multi-project batch publish — one project, one bundle, one publish Epic,
  same "one Epic, one unit of work" discipline as everywhere else.
- No content rewriting in this app — the marketing HTML was already authored
  by Project Pages; Stage B ships it verbatim.
- No support for `react-route` hosting (Bilko's own Vite bundle) — that
  requires editing Bilko's frontend source tree directly and is explicitly
  the higher-friction, "only when genuinely needed" path per Bilko's own
  contract; v1 targets `static-path` only.
