# Project Pages — two generated artifacts

Project Home hosts two independently generated, self-contained documents:

```
session-manager-operations/project-pages/
  home.html               — overview: what it is, who it's for, structure, how to run, key commands
  demo-video/index.html   — a 30-second self-contained HTML/JS animation of the project's goals + features
```

## Who writes them

Each artifact has exactly one writer route, reached through its own MCP tool:

- `project_home_write` -> `POST /admin/project-home/write` -> `home.html`
- `project_demo_video_write` -> `POST /admin/project-home/demo-video/write` -> `demo-video/index.html`

Both routes live in `src/main/lib/projectHomeAdminRoutes.cjs` and write as writer
`project-home` — `project-pages` is an `OWNERS` namespace
(`src/main/lib/opsOwnership.cjs`), so these two routes are the only sanctioned writers.

Both documents must be self-contained: no `<script src>`, remote `<link>`, `@import`,
or remote `url(...)`. The demo video is additionally validated because it runs inline
JavaScript (the home page does not):
- it must declare `<meta name="sm-demo-duration" content="N">` with `5 <= N <= 30`;
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
`src/main/lib/builtinMacros.cjs`, launched through the same `useMacroLaunch` authority
the Sessions HOT KEYS strip uses:

- `builtin-project-home` — agent `project-home-builder`, writes via `project_home_write`.
- `builtin-demo-video` — agent `demo-video-builder`, writes via `project_demo_video_write`.

A project with neither artifact shows an empty state offering these actions.
