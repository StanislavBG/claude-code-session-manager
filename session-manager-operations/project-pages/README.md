# Project Pages — two generated artifacts

Project Home hosts two independently generated, self-contained documents:

```
session-manager-operations/project-pages/
  home.html               — overview: what it is, who it's for, structure, how to run, key commands
  demo-video/index.html   — a 30-second or 1-minute self-contained HTML/JS animation of the project's goals + features
```

## Who writes them

Each artifact has exactly one writer route, reached through its own MCP tool:

- `project_home_write` -> `POST /admin/project-home/write` -> `home.html`
- `project_demo_video_write` -> `POST /admin/project-home/demo-video/write` -> `demo-video/index.html`

Both routes live in `src/main/lib/feedback-remote/projectHomeAdminRoutes.cjs` and write as writer
`project-home` — `project-pages` is an `OWNERS` namespace
(`src/main/lib/opsOwnership.cjs`), so these two routes are the only sanctioned writers.

Both documents must be self-contained: no `<script src>`, remote `<link>`, `@import`,
or remote `url(...)`. The demo video is additionally validated because it runs inline
JavaScript (the home page does not):
- it must declare `<meta name="sm-demo-duration" content="N">` with `5 <= N <= 60`;
- it is rejected if it references any network-capable API (`fetch`, `XMLHttpRequest`,
  `WebSocket`, `EventSource`, `sendBeacon`, dynamic `import(...)`, `importScripts`,
  `<iframe>`/`<object>`/`<embed>`, `window.open`, or any `src=`/`href=` pointing at
  `http(s)://` or `//`);
- before it is written, a `Content-Security-Policy` meta tag (`default-src 'none';
  script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;
  media-src data: blob:; font-src data:; connect-src 'none'`) is injected as the first
  child of `<head>` — the real network fence, since the player renders the file via
  `smfile://` in a sandboxed iframe that sends no CSP header itself. The regex checks
  above are defence in depth, not the control.

## Who reads them

`src/main/projectPages.cjs` is read-only: `project-pages:get` returns `home.html`'s
content plus `demo-video/index.html`'s `{ path, mtimeMs }` (or `null` if absent), and a
per-cwd watcher pushes `project-pages:changed` with both whenever either file is
added/changed/removed. Project Home shows `home.html` in a sandboxed frame and, when
present, plays the demo video via `DemoVideoFrame`.

**The demo video only plays for projects under `$HOME`.** The player loads the file
over the `smfile://` scheme, which `assertInsideHome` (`src/main/index.cjs`) enforces —
containment to the user's home directory plus symlink-escape rejection — so a project
outside `$HOME` never renders a demo video even if `demo-video/index.html` exists on disk.

## Who triggers generation

Project Home's two buttons are the built-in Macros in
`src/main/lib/persona-macro/builtinMacros.cjs`, launched through the same `useMacroLaunch` authority
the Sessions HOT KEYS strip uses:

- `builtin-project-home` — agent `project-home-builder`, writes via `project_home_write`.
- `builtin-demo-video` — agent `demo-video-builder`, writes via `project_demo_video_write`.

A project with neither artifact shows an empty state offering these actions.

## Library: Knowledge Pages + Videos

**The split: HTML pages explain, videos show.** A Knowledge Page is a static, script-free
document that explains a topic. A video is a self-contained HTML/JS animation that shows
the project. A project holds many of each; the folder listing IS the library (no manifest).

### Folder contract

```
project-pages/
  knowledge/<id>/index.html + meta.json     one folder per Knowledge Page
  videos/<id>/index.html   + meta.json      one folder per video
  videos/_character/                        shared mascot assets; never an entry, skipped by
                                            the lister, the watcher, rename and delete
```

`<id>` matches `ENTRY_ID_RE` (`/^[a-z0-9][a-z0-9-]{0,63}$/`, `src/main/ipcSchemas.cjs`);
`_character` can never match. `index.html` is written first, then `meta.json`, both
atomically as writer `project-home`. Storage code: `src/main/lib/project-pages/pagesLibrary.cjs`
(`listLibrary` is newest-first, capped at 500 entries).

### meta.json schemas (`ipcSchemas.cjs`, both `.strict()`)

- **Knowledge** (`projectPageMeta`): `id`, `title` (1-120), `topic` (<=120), `createdAt`
  (ISO datetime), `model` (<=60).
- **Video** (`projectVideoMeta`): `id`, `title` (1-120), `kind` (`project-demo` | `blog-post`
  | `feature`), `style` (<=40), `lengthS` (int 5-60), `createdAt`, `character` (<=80 or
  null), `sources[]` (`{claim, source, ref}`, <=40), `report` (`lufs`, `truePeakDb`,
  `speechS`, `readingGrade`, all number|null; `checks[]` of `{id, ok, detail}`; `bytes`),
  `macroVersion`, `seedVersion`, `model`, `effort`. The server stamps `id`, `createdAt` and
  `report.bytes`.

### Write tools and routes

All in `projectHomeAdminRoutes.cjs`, writer `project-home`; each rewrite of an existing id
replaces that entry.

| MCP tool | Route | Target |
| --- | --- | --- |
| `project_page_write` | `POST /admin/project-home/pages/write` | `knowledge/<pageId>/` |
| `project_video_write` | `POST /admin/project-home/videos/write` | `videos/<videoId>/` |
| `project_home_write` (alias) | `POST /admin/project-home/write` | `knowledge/overview/` |
| `project_demo_video_write` (alias) | `POST /admin/project-home/demo-video/write` | new `videos/vid-<id>/`, kind `project-demo`, length read from `sm-demo-duration` |

Burrow (and any older caller) keeps using `/admin/project-home/demo-video/write`; the alias
is permanent, not a shim to remove. Limits: a page is <= 1 MB; a video is <= 2 MB per
started 30 s (`maxVideoBytes`), and its `sm-demo-duration` must equal `lengthS`.

### Player bridge

On video writes `injectPlayerBridge` (`lib/project-pages/playerBridge.cjs`) adds an inline
`postMessage` bridge after the CSP. Project Home posts `{smPlayer: 1, cmd}` with `cmd` in
`play | pause | restart | seek (t) | mute | unmute | hello`; the video replies to
`event.source` with `{smPlayer: 1, type: 'state', duration, t, playing, muted, scenes}`. It
drives `window.smDemo` when present, else the first `<audio>`/`<video>`.

### Migration

`migrateLegacy` runs once per project and is idempotent: `home.html` becomes
`knowledge/overview/` and `demo-video/index.html` becomes `videos/legacy-<sha10>/`
(kind `project-demo`, style `legacy`). The originals are kept as `home.html.migrated` and
`demo-video/index.html.migrated`; do not delete or restore them.

### Rename and delete

`project-pages:rename` rewrites only `meta.json`'s `title` (validated before and after).
`project-pages:delete` removes exactly one entry folder. Both refuse a bad id,
`_character`, a missing entry, and any entry whose realpath is not a direct child of its
kind folder (symlink escape).

The sections above describe the legacy single-file layout up to "Who triggers generation";
where they differ, this section wins.
