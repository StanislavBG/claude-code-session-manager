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
  http(s):// or `//`);
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
added/changed/removed. Project Home shows a knowledge page in `HtmlFrame` (a `srcDoc`
iframe sandboxed to `allow-same-origin`, so no script runs) and plays a video in
`VideoPlayer` (an `allow-scripts`-only sandboxed iframe over `smfile://`).

**The demo video only plays for projects under `$HOME`.** The player loads the file
over the `smfile://` scheme, which `assertInsideHome` (`src/main/index.cjs`) enforces —
containment to the user's home directory plus symlink-escape rejection — so a project
outside `$HOME` never renders a demo video even if `demo-video/index.html` exists on disk.

## Who triggers generation

Project Home is `src/renderer/components/tabs/projecthome/ProjectHome.tsx`; every other
component named below sits in its `projectpages/` folder. It opens on three key buttons
(`ProjectHomeKeyButtons.tsx`) that switch the section below them:

- **Pages** — the knowledge-page library (`PagesPane.tsx`). Badge = ready + building pages;
  meta line `Nothing generated yet`, `<n> building · <m> ready` while a build is queued or
  running, else `<n> pages · latest <ago>`.
- **Videos** — the video library (`VideosPane.tsx`), with the same badge and meta line.
- **Tools** — `ToolsPane.tsx`. Meta line `Review MD network`; once Tools has scanned this
  project, ` · <n> findings` and an accent badge carry the last link-map scan's findings
  count (hidden until then, and after a failed scan).

Every press goes through `useMacroLaunch` (`src/renderer/lib/useMacroLaunch.ts`), the
authority the Sessions HOT KEYS strip uses. Pages and Videos build with the two library
Macros in `src/main/lib/persona-macro/builtinMacros.cjs`:

- `builtin-project-home` — agent `project-home-builder`, writes `knowledge/<id>/` via `project_page_write`.
- `builtin-demo-video` — agent `demo-video-builder`, writes `videos/<id>/` via `project_video_write`.

Both declare a `job`, so a press is a background build: after a delegation-readiness check,
`macros.dispatchJob` (`lib/persona-macro/macroJobDispatch.cjs`) queues one artifact-only
scheduler PRD in the macro's active Epic (`launchSession` mints that Epic first when there is
none), and Project Home stays where it is. While the job is queued or running the list shows a
building row (`BuildingPanel.tsx`) — for a Regenerate from this window, the entry's own row —
and a `“<title>” is ready` toast fires when it is done.

### Generate composer

`Generate page` / `Generate video` open `GenerateComposer.tsx` on that kind's templates
(`composerTemplates.ts`): Overview, How it works, FAQ, Getting started, What’s new and Custom
topic for pages; Project demo, Feature spotlight, Blog post, Whiteboard explainer, TikTok,
Marketing and Custom for videos. Picking a template resets every setting to its defaults; Focus is free text with
`+ <chip>` suggestions. `pagePromptLines` / `videoPromptLines` turn the form into the builder's
prompt lines, which the pane sends, joined with `\n`, as the macro's `extraInstructions`:

```text
Page: Overview | How it works | FAQ | Custom topic: <topic>
Audience: Newcomers | Users | Contributors           (the composer's "Written for")
Length: Brief | Standard | In-depth
Read from: <README & docs, Source tree, Git log — the selected ones, in this order> | nothing selected
<Focus text, when set>
```

```text
Video kind: Project demo | Blog post | Feature | TikTok | Marketing
Video target: <post path or URL | feature name | series brief path | landing page URL>   (not for Project demo; when set)
Video style: Auto | Professional | Fun | Animated whiteboard | Kinetic typography
Video length: 15 | 30 | 60                               (15 for TikTok only)
Character: on | off
<Focus text, when set>
```

A TikTok's target (a series brief path) and a Marketing's target (a landing page URL) are
optional; Blog post and Feature need one. **Review first** (`VideoCfg.review`, on by default only
for the TikTok template) is never a prompt line: it travels as the press's `reviewStage`, and
`builtin-demo-video` (`job.reviewable`) then runs the review stage described in
[Review step](#review-step-videosidreview) before the final save. When the project has a saved
persona, the Character toggle reads `Persona: <name>` and starts on.

Both library macro prompts read these lines. `fitInstructions` (`PagesPane.tsx`) keeps the
joined text within the 4000-character `extraInstructions` cap (`src/main/ipcSchemas.cjs`),
cutting Focus first. A Custom topic page cannot be generated until it has a topic
(`canGenerate`).

An empty library (nothing written, nothing building) shows `LibraryEmptyState.tsx`: one
starter card per template. A card's Generate sends that template's default lines at once
(`pageDefaults` / `videoDefaults`); Customize opens the composer on it; the page Custom topic
card reads `Name a topic` and opens the composer.

### Regenerate

`Regenerate…` in the selected entry's title bar opens the composer settings-only, pre-filled
from that entry (`pageCfgFromEntry`: the mapped template's defaults, plus `meta.topic` for a
custom topic; `videoCfgFromEntry`: kind, style, length and Character from `meta.json`, target
empty). The pane then appends one last line, which `fitInstructions` never cuts:

```text
Replace entry: <id>
```

`entryIdFor` in `macroJobDispatch.cjs` takes a valid `Replace entry: <id>` as the job's entry
id, so the build rewrites that entry in place. Without one, a video gets a fresh `vid-…` id and
a page is named by its `Page:` line (`overview`, `how-it-works`, `faq`, or the kebab-cased
custom topic). The dispatcher adds an `Entry id: <id>` line to the job's goal, which tells the
builder to save under that id.

### Tools

`ToolsPane.tsx` lists `builtin-review-md-network` (agent `architect`) first, then every other
macro saved with Surface: Project Home (the macro editor's `Shown on: Project Home`, i.e.
`surface: 'project-home'`) that `macrosForProject` returns for this project — except the two
library macros above, which Pages and Videos launch. `Add a tool` opens `MacroEditor` with that
surface preset. Review MD network shows a Scope select, a Mode control (`Full review` |
`Drift check`) and `Run review`, over one `project-pages:md-network` scan
(`src/main/lib/mdNetworkScan.cjs`, drawn by `MdLinkMap.tsx`) fetched when its view first shows
and again on `Refresh`, never polled. The link map's `Expand` opens `MdNetworkExplorer.tsx`, a
full-screen map + doc preview + Docs table whose curation tray launches the review on the picked
docs; curation lives in ui-prefs `mdCuration` (`src/renderer/lib/useMdCuration.ts`) —
machine-local, gitignored in this repo. Any other tool shows its inputs form, or a plain `Run`.
No Tools macro has a `job` (`lib/persona-macro/macroLibrary.cjs` attaches `job` only to the
built-ins that declare one), so each press mints a new Epic and opens it — the same act as New
Session.

Every Tools entry is shown in every project — a Project Home tool is part of Session Manager,
and only what it generates is per project ([domain-model.md](../architecture/domain-model.md)).
The pane's footnote (`project-home-tools-footnote`) says so:

> Every Project Home tool shows up here in every project. What it generates stays with each project.

The macro editor locks `Show in every project` on for a Project Home tool and shows the
`macro-everywhere-note` beneath it. Built-in tools:

- `builtin-review-md-network` — agent `architect`, described above.
- `builtin-cpu-audit` (`CPU audit & fixes`) — agent `architect`, inputs `Scope` and `Run
  scenario`; opens an architect Epic that measures the project's CPU use, ranks the findings
  and builds the fixes through `/develop`.

Per-file notes: [`code-map.md`](../architecture/code-map.md).

## Library: Knowledge Pages + Videos

**The split: HTML pages explain, videos show.** A Knowledge Page is a static, script-free
document that explains a topic. A video is a self-contained HTML/JS animation that shows
the project. A project holds many of each; the folder listing IS the library (no manifest).

### Folder contract

```
project-pages/
  knowledge/<id>/index.html + meta.json     one folder per Knowledge Page
  videos/<id>/index.html   + meta.json      one folder per video
  videos/<id>/video.mp4    + poster.png     the MP4 + PNG poster export (required for tiktok / marketing)
  videos/<id>/review/                       the human review step (a Project Video tool, or Demo Video's Review first)
  videos/_character/                        the project persona (character.json + character.js); never an
                                            entry, skipped by the lister, the watcher, rename and delete
```

`<id>` matches `ENTRY_ID_RE` (`/^[a-z0-9][a-z0-9-]{0,63}$/`, `src/main/ipcSchemas.cjs`);
`_character` can never match. `index.html` is written first, then `meta.json`, both
atomically as writer `project-home`. Storage code: `src/main/lib/project-pages/pagesLibrary.cjs`
(`listLibrary` is newest-first, capped at 500 entries).

### meta.json schemas (`ipcSchemas.cjs`, both `.strict()`)

- **Knowledge** (`projectPageMeta`): `id`, `title` (1-120), `topic` (<=120), `createdAt`
  (ISO datetime), `model` (<=60).
- **Video** (`projectVideoMeta`): `id`, `title` (1-120), `kind` (`PROJECT_VIDEO_KINDS`: `project-demo` | `blog-post`
  | `feature` | `episode` | `tiktok` | `marketing`), `target` (<=300, optional), `aspect` (`16:9` | `9:16`, optional),
  `post` (`{caption, audience}`, tiktok only, optional), `style` (<=40), `lengthS` (int 5-60), `createdAt`, `character` (<=80 or
  null), `sources[]` (`{claim, source, ref}`, <=40), `report` (`lufs`, `truePeakDb`,
  `speechS`, `readingGrade`, all number|null; `checks[]` of `{id, ok, detail}`; `bytes`),
  `macroVersion`, `seedVersion`, `model`, `effort`. The server stamps `id`, `createdAt` and
  `report.bytes`.
- **`kind: 'episode'`** is a project's own series video, made by a Project Video tool (e.g. Burrow's
  episode tools); the library built-in never picks it.
- **`aspect`** is read from the document's `<meta name="sm-demo-aspect" content="16:9|9:16">`
  (`projectHomeAdminRoutes.cjs`); any other value is refused, no tag means `16:9`, and a caller's
  `meta.aspect` is ignored — the document is the one source. An entry with no `aspect` (older
  entries) is treated as `16:9`.
- **`kind: 'tiktok'` / `'marketing'`** are Demo Video's vertical short and landing-page video.
  How to make each is the kit's playbook (`src/main/lib/demo-video-kit/kind-tiktok.md`,
  `kind-marketing.md`); what a save must carry is `validateExportKind`
  (`projectHomeAdminRoutes.cjs`): both exports, aspect `9:16` for tiktok and `16:9` for
  marketing, and for tiktok `meta.post` plus every `TIKTOK_CHECK_IDS` check
  (`demo-video-kit/checks.cjs`) passing. The MP4 is rendered by `demo-video-kit/export.cjs`.

### Exports: video.mp4 + poster.png

`project_video_write`'s `mp4Path` + `posterPath` (given together or not at all) are read by the
MCP server and sent as `exports.mp4Base64` / `exports.posterBase64` — top level, never inside
`meta`. The route checks the MP4's `ftyp` and the PNG signature and the size caps
(`MAX_EXPORT_MP4_BYTES_PER_30S`, `MAX_EXPORT_POSTER_BYTES`), then writes them under the fixed
names `video.mp4` and `poster.png` in the entry folder. `listLibrary` reports each video's
`exports: {mp4, poster}` (absolute path or null).

### Persona: videos/_character/

The project persona is `character.json` + `character.js`, written only by
`project_character_write` (`POST /admin/project-home/character/write`; 409 unless `replace`).
`character.json` holds `name`, `palette`, `voice`, an optional `personality`
(`who`, `speech`, `readingLevel`, `neverSay[]`) and an optional `cast` of supporting characters
(each `name`, `voice?`, `note?`); the look is drawn by `character.js`. The field rules are
`validateCharacterJson` in `demo-video-kit/character.cjs` — read them there. The saved
`character.json` must fit in 16 KB, and an existing character — even an unusable one — is
refused with 409 unless `replace` is set.
`listLibrary` returns `persona: {name} | null`. A saved persona hosts every Demo Video unless the
press turns Character off. `speakLines` takes lines of `{text, out, speaker?}`: each line is spoken
in its `speaker`'s voice (the host's when absent), a cast member without a voice never speaks,
and there is no fallback voice, so a failing command fails the run.
A command voice uses either `{text}` + `{out}` (run once per line) or `{lines}` alone: a
`{lines}` voice runs once per speaker, at that speaker's first line, given the path of a JSON
manifest `[{text, out}]` of all its lines (absolute outs, each ending in `.wav`). Its outs are
cleared first, and it succeeds only when every out is a RIFF WAV. Its time limit
(`batchTimeoutMs`) is 15 minutes per line, at most 180 minutes, and never past the job deadline
(`SM_SCHEDULER_JOB_DEADLINE_MS`) minus 45 minutes; under 1 minute left fails the run.
`node character.cjs speak spec.json [--wait seconds]` (spec `{projectRoot, lines}`) runs
`speakLines` in a detached runner (`resumableRun.cjs`) with its state in `<spec>.run/`. Each call
waits one slice: it exits 0 or 1 with the result, or exits 75 with a pending line while the voice
still speaks — run the same command again to attach to the same run. A run with no call for
20 minutes is abandoned and stopped.

### Review step: videos/<id>/review/

A Project Video tool (`surface: 'project-video'`, one project's tool, shown only in its Project
Home ▸ Video) whose `job` has `review: true` stops after a first run for a human review; so does
a Demo Video press with Review first on (`stageFor` in `macroJobDispatch.cjs`). Its
records live in the entry's `review/` folder, written as writer `project-home` through
`lib/project-pages/videoReview.cjs` (the one writer; tmp+rename via `util/atomicFs.cjs`):

| File | Written by | When |
| --- | --- | --- |
| `dispatch.json` | the app (`macroJobIpc.cjs` → `recordDispatch`) | each time the tool's job is queued: `{entryId, macroId, epicId, slug, stage, inputValues, extraInstructions, dispatchedAt}` |
| `material.json` + `image-1.<ext>` .. `image-N.<ext>` | `project_video_review_write` → `POST /admin/project-home/videos/review/write` → `writeMaterial` | the review-stage run: text (<=32000 chars) + 1-6 PNG/JPEG/WebP images (<=2 MiB each, checked by magic bytes); refused without a `dispatch.json`; replaces the earlier material and images |
| `decision.json` | **only** the human decision (`project-videos:review-decide` → `writeDecision`) | `approve` (with `at`) or `changes` (with `note`); refused without material or when already decided |

Material limits (`writeMaterial`): `text` is 1-32000 characters (`REVIEW_TEXT_MAX`) and `images`
is 1-6 items (`REVIEW_IMAGES_MAX`); anything else is refused. An approval's `decision.json` keeps
`at` — the exact time text of the approval line (`formatLocalAt`, e.g. `2026-11-22 13:05 PST`, a
1-40 char single line) that the final run's goal carries as `Review: approved by the owner at <at>`.

No agent tool or route writes `decision.json`. `reviewStatus` derives `building` / `waiting` /
`approved` / `changes-requested` from the newest record; a `'final'` dispatch record never changes
the review status (it never outranks a decision), so an approved entry stays `approved` while its
final run builds or fails. `project-videos:review-list` lists them, each with its `job` and
`canRetry`.

**Retry** (`project-videos:review-retry` → `videoReviewIpc.retry`). Offered (`canRetry`, `retryable`)
only on an approved entry whose recorded `'final'` run's job failed, and only to a human click on that
entry in Project Home ▸ Video — renderer IPC only: no admin route, MCP tool or phone path reaches it.
It re-dispatches the final stage once (one in-flight decide/retry per entry) with the recorded inputs
and the original `Review: approved by the owner at <at>` (the `at` in `decision.json`) and
`Replace entry: <id>` lines; it writes no decision, never re-runs the review stage, and archives
the failed job's old slug (best effort).
Why only a human approves: [domain-model.md](../architecture/domain-model.md).

### Write tools and routes

All in `projectHomeAdminRoutes.cjs`, writer `project-home`; each rewrite of an existing id
replaces that entry.

| MCP tool | Route | Target |
| --- | --- | --- |
| `project_page_write` | `POST /admin/project-home/pages/write` | `knowledge/<pageId>/` |
| `project_video_write` | `POST /admin/project-home/videos/write` | `videos/<videoId>/` |
| `project_home_write` (alias) | `POST /admin/project-home/write` | knowledge/overview/ |
| `project_demo_video_write` (alias) | `POST /admin/project-home/demo-video/write` | new `videos/vid-<id>/`, kind `project-demo`, length read from `sm-demo-duration` |
| `project_matrix_write` | `POST /admin/project-home/matrix/write` | `matrix/matrix.json` (+ schema, history, `knowledge/competitive-matrix/`) — see Competitor matrix |

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
knowledge/overview/ and `demo-video/index.html` becomes `videos/legacy-<sha10>/`
(kind `project-demo`, style `legacy`). The originals are kept as `home.html.migrated` and
demo-video/index.html.migrated; do not delete or restore them.

### Rename and delete

`project-pages:rename` rewrites only `meta.json`'s `title` (validated before and after).
`project-pages:delete` removes exactly one entry folder. Both refuse a bad id,
`_character`, a missing entry, and any entry whose realpath is not a direct child of its
kind folder (symlink escape).

The sections before "Who triggers generation" describe the legacy single-file layout;
where they differ, this section wins.

## Competitor matrix

```
project-pages/
  matrix/matrix.json             the saved matrix: self + 1..4 competitors, feature groups, features, sources, runs[]
  matrix/matrix.schema.json      its JSON Schema, rewritten with every save
  matrix/history/<stamp>.json    previous valid matrix.json per save, newest 50 kept
  knowledge/competitive-matrix/  read-only HTML snapshot (matrixHtml.cjs); reserved page id in the Pages library
```

Read: `project_matrix_read` -> `POST /admin/project-home/matrix/read` (matrix or null, plus the
schema). Write: `project_matrix_write` -> `POST /admin/project-home/matrix/write` ->
`writeMatrix` (`lib/project-pages/matrixStore.cjs`): validate, archive, write, refresh the
snapshot. Every write goes through writer `project-home`. Model + validation:
`lib/project-pages/competitiveMatrix.cjs`; the renderer reads it over `project-pages:matrix`.

Macro flow: Project Home ▸ Tools ▸ Competitor matrix (`builtin-competitor-matrix`) queues a
background job run as `competitive-analyst` (Opus), which fans out `competitive-researcher`
subagents (Haiku) and saves with one `project_matrix_write`. The `Competitors:` line names up to
4 `;`-separated slots (a name or `auto`). Every run warm-starts from the saved matrix
(`project_matrix_read`), keeping its ids. A missing feature offers Start session; Start all and
Add all as proposed act on every missing feature.
