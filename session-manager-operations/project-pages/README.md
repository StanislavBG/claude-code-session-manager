# Project Pages — the Project Home library

Project Home hosts a library of independently generated, self-contained documents, one
folder per entry (full layout: [Library: Knowledge Pages + Videos](#library-knowledge-pages--videos)):

```
session-manager-operations/project-pages/
  knowledge/<id>/     — Knowledge Pages: static, script-free documents that explain a topic
  videos/<id>/        — videos: self-contained HTML/JS animations that show the project
  videos/_character/  — the project persona every video can reuse
  matrix/             — the Competitor matrix (see Competitor matrix)
```

Projects that predate the library had `home.html` + `demo-video/index.html`; `migrateLegacy`
moves them into the library once (see [Migration](#migration)).

## Who writes them

Every writer is a route in `src/main/lib/feedback-remote/projectHomeAdminRoutes.cjs`, reached
through its own MCP tool, all writing as writer `project-home`:

- `project_page_write` -> `POST /admin/project-home/pages/write` -> `knowledge/<id>/`
- `project_video_write` -> `POST /admin/project-home/videos/write` -> `videos/<id>/`
- `project_character_write` -> `POST /admin/project-home/character/write` -> `videos/_character/`
- `project_home_write` (alias) -> `POST /admin/project-home/write` -> `knowledge/overview/`
- `project_demo_video_write` (alias) -> `POST /admin/project-home/demo-video/write` -> a new
  `project-demo` entry under `videos/<id>/`

`project-pages` is an `OWNERS` namespace (`src/main/lib/opsOwnership.cjs`), so these routes
(plus the review, outcome and matrix routes listed in [Write tools and routes](#write-tools-and-routes))
are the only sanctioned writers. Storage code: `src/main/lib/project-pages/pagesLibrary.cjs`.

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

`src/main/projectPages.cjs` is read-only: `project-pages:get` runs `migrateLegacy`, then
returns the library (`knowledge`, `videos`, persona, outcomes from `listLibrary`) plus, for
the phone remote, the `overview` page's HTML and the newest video's `{ path, mtimeMs }`; a
per-cwd watcher pushes `project-pages:changed` when the library changes. Project Home shows a knowledge page in `HtmlFrame` (a `srcDoc`
iframe sandboxed to `allow-same-origin`, so no script runs) and plays a video in
`VideoPlayer` (an `allow-scripts`-only sandboxed iframe over `smfile://`).

**The demo video only plays for projects under `$HOME`.** The player loads the file
over the `smfile://` scheme, which `assertInsideHome` (`src/main/index.cjs`) enforces —
containment to the user's home directory plus symlink-escape rejection — so a project
outside `$HOME` never renders a video even if its `index.html` exists on disk.

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

## Git class: tracked

`project-pages` is GIT_CLASS `tracked` (`src/main/lib/opsOwnership.cjs`). Project Home output
(`knowledge/`, `videos/` including `_character/`, `matrix/`) is the project's own content,
committed like docs. Session Manager never writes `project-pages/.gitignore`; a project that
wants it out of git adds its own ignore rule, which Session Manager leaves alone.

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
  videos/_character/sounds/<name>.wav       the persona's own file-backed sound effects and music beds
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

`character.json` may also carry an optional `sounds` block, `{sfx: [{name, note?}], beds: [{name,
note?, command?}]}` (the persona's own sound effects and music beds), and a cast member an optional
`sfx` (its signature sounds: built-in effects or `sounds.sfx` names). The field rules are
`validateSounds` and `validateMemberSfx` in `demo-video-kit/projectSounds.cjs`. Every `sfx` entry
and every bed without a `command` is file-backed: its WAV is sent in the same
`project_character_write` call via `soundPaths` (`{name: absolute .wav path}`, sent as `sounds`
base64), saved as `videos/_character/sounds/<name>.wav`. The WAVs are checked before any write —
exactly one per declared name, a readable PCM or float WAV, an effect at most 1 MiB, a bed at most
12 MiB, 32 MiB in all — and WAVs no longer declared are removed after the write; a failed removal
is reported as `pruneError` on the 200 answer while the new persona stays saved. Every refusal of
the json or its sounds is `character.json invalid: <reason>`.

Mixing (`mix` in `demo-video-kit/sound.cjs`, given `projectRoot`): a cue name is looked up in the
built-in effects first, then the persona's `sounds.sfx`. `bed` names a built-in style or a persona
bed (absent = the style's built-in bed). A file bed is looped to length with the built-in 1 s fades;
a command bed runs its argv (placeholders `{name}`, `{lengthS}`, `{seed}`, `{out}`; no shell, cwd
the project root, 300 s limit), must write at least `lengthS` - 0.05 s of WAV (a shorter tail inside
that tolerance is padded with silence), and is used as rendered (cut to length, no fades added).
Project sounds keep their own level and get the built-in gains — effects -10 dB, beds -16 dB ducked
4 dB under speech; the built-in effects and beds peak at 0.7 and 0.8 before those gains. Unknown
names, missing or bad WAVs and failing commands fail the run; there is no fallback sound.
`listLibrary` returns `persona: {name} | null`. A saved persona hosts every Demo Video unless the
press turns Character off. `speakLines` takes lines of `{text, out, speaker?}`: each line is spoken
in its `speaker`'s voice (the host's when absent), a cast member without a voice never speaks,
and there is no fallback voice, so a failing command fails the run.
A command voice uses either `{text}` + `{out}` (run once per line) or `{lines}` alone: a
`{lines}` voice runs once per speaker, at that speaker's first line, given the path of a JSON
manifest `[{text, out}]` of all its lines (absolute outs, each ending in `.wav`). Its outs are
cleared first, and it succeeds only when every out is a RIFF WAV. Its time limit
(`batchTimeoutMs`) is 15 minutes per line, at most 180 minutes, and never past the job deadline
(`SM_SCHEDULER_JOB_DEADLINE_MS`) minus a reserve for mixing and saving (`speakReserveMs`): a
quarter of the time left, at most 45 minutes. Under 1 minute left to speak fails the run, naming
the minutes left before the job deadline and the reserve kept.
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

### Scripted Demo Video press

A project's own script (a cron job, a blog build) may press the built-in Demo Video
(`builtin-demo-video`) for that project — only while the project's **'Scripts may run Demo
Video'** switch is on. Why a human switch: [domain-model.md](../architecture/domain-model.md)
(macro section).

**The switch** (`lib/project-pages/videoScriptPress.cjs`, machine-level
`video-script-switches.json` beside `task-switches.json`, keyed by absolute cwd, off by default)
has exactly two writers, each recorded in `by`:

- a human click in Project Home ▸ Video's collapsed **Scripts** disclosure
  (`ScriptPressSwitch.tsx` → `videos:script-switch-set`) — `by.via: 'ui'`;
- an agent quoting the human: `video_script_switch_set` →
  `POST /admin/project-home/videos/script-switch` (`videoScriptSwitchRoute.cjs`), only on a
  verbatim quote from a prompt the human typed in the calling session (`humanPromptLedger`)
  that names the switch and, for another project, that project; a prompt older than the
  switch's last change is 409 `request_older_than_switch` — `by.via: 'agent'`.

Scripts, scheduled jobs and Tasks cannot set it: their prompts are never in the ledger.

**The run** — `POST /admin/project-home/videos/run` (`videoScriptRunRoute.cjs`, bearer token
and port from `~/.claude/session-manager/admin-api.json`, body ≤ 64 KiB):

| Field | Meaning |
| --- | --- |
| `cwd` | the project (required) |
| `kind` | Project demo, Blog post, Feature, TikTok or Marketing (or its slug; required) |
| `target` | post path/URL, feature name, brief path or landing URL; required for Blog post and Feature |
| `length`, `style`, `character`, `focus` | the composer's choices (defaults 30, Auto, on, none) |
| `voiceId` | a voice in the project's voice library |
| `reviewFirst` | `true` runs the review stage first (default `false`) |
| `externalRef` | the caller's own id for this press (letters, digits, `. _ : / @ -`, ≤ 200) |

Answers, checked in this order (a refusal launches nothing):

| Status | Body | When |
| --- | --- | --- |
| 400 | `{ ok:false, error }` | bad body or cwd |
| 403 | `scripts_not_allowed` + `reason` | the switch is off for that project |
| 400 | `{ ok:false, error }` | a bad press choice, an unknown `voiceId`, a bad `externalRef` |
| 200 | `{ ok, existing:true, entryId, epicId, slug, alreadyRunning }` | a run with the same cwd + `externalRef` exists |
| 409 | `already_building` (+ `activeSlug`) | a Demo Video job for the cwd is pending, held or running |
| 503 | `{ ok:false, error }` | no app window answered, the queue could not be read, or no entry id came back |
| 200 | `{ ok, entryId, epicId, slug, stage }` | the press started |

The press goes through the same renderer press path as a human press (`chat:external-new-session`
→ `launchSession`), so it mints one Epic through the existing mint authority with the human
press's persona, checks and review stage. Each run is recorded in the machine-level ledger
`video-script-runs.json` (its only writer is this route, ≤ 200 runs per project) and audited as
`admin_video_script_run`.

**Idempotency.** With `externalRef`, a repeat call with the same cwd + ref answers the first run
(`existing: true`) instead of pressing again; concurrent identical calls share one launch
(`withExternalRefLock`). Without it, only the 409 stops a second press.

**Status** — `GET /admin/project-home/videos/status?cwd=&id=<entryId>` (read-only; `id` must match
`^[a-z0-9][a-z0-9-]{0,63}$`). `state`, first match wins:

| State | From |
| --- | --- |
| `season-complete` | `videos/<id>/outcome.json` (`reason` = its text) |
| `saved` | `index.html` + `meta.json` (`files.index`/`meta`/`mp4?`/`poster?`, absolute, only those that exist) |
| `awaiting_review` | `review/material.json` |
| `queued` / `running` / `failed` | the job row for the ledger's slug (`reason` = its one line; a completed job with nothing saved is `failed`) |

An id with neither a ledger run nor an entry folder is 404.

**Review first stops at the human.** With `reviewFirst: true` the run ends at `awaiting_review`;
only a human click in Project Home ▸ Video approves it or asks for changes
([Review step](#review-step-videosidreview)) — no route, script or agent approves, so a scripted
press never reaches `saved` without the human when Review first is on.

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

## Voice library

Voices are a Session Manager resource, like agents: one library, previewed and approved in
Project Home ▸ Video ▸ Voices, bound to personas and tools by id. The one resolver is
`demo-video-kit/voiceLibrary.cjs` (`listVoices`, `resolveVoiceId`).

### Where voices live

Three scopes, resolved project-first; a higher scope shadows a lower one with the same id:

| Scope | Location |
| --- | --- |
| `project` | `<project>/.claude/voices/<id>.json` |
| `machine` | `~/.claude/session-manager/voices/library/<id>.json` (voices home = `SM_VOICES_HOME`) |
| `builtin` | every voice in the installed Kokoro model (`voices-v1.0.bin` under `KOKORO_MODEL_DIR`, default `~/.cache/kokoro-onnx`), else the `KOKORO_V1_VOICES` list marked not installed |

`<id>` matches `/^[a-z0-9][a-z0-9_-]{0,63}$/` and is the file name; a file is at most 16 KB.
An invalid file is reported in `errors` and never falls through to a lower scope.

### Voice file format

A command voice a project like Burrow can copy (`.claude/voices/narrator-1.json`):

```json
{
  "id": "narrator-1",
  "label": "Narrator (warm)",
  "voice": { "engine": "command", "command": ["python3", "tools/tts.py", "--voice", "warm", "--text", "{text}", "--out", "{out}"] },
  "sampleText": "Hello! This is how I sound when I tell your project story.",
  "licence": "CC-BY-4.0",
  "heavy": true,
  "pinFiles": ["tools/tts.py", "tools/voices/warm.pt"]
}
```

- `voice` is an inline voice checked by `validateCharacterJson`: `{engine: 'kokoro', id}` or
  `{engine: 'command', command: string[]}`. A command uses `{text}` + `{out}` (run once per line)
  or `{lines}` alone (run once per speaker with a JSON manifest path, e.g.
  `["python3", "tools/tts.py", "--batch", "{lines}"]`); mixing them is refused. The argv is never
  run through a shell. A library voice may not itself be a `{voiceId}` (no chains).
- `id` must equal the file name; `label` 1-80 chars (default the id); `sampleText` <= 300 chars
  (the preview line); `licence` <= 120 chars (default `unknown`); `heavy` boolean (see the lane);
  `pinFiles` <= 8 project-relative paths, no `..`, whose bytes the approval pin covers.

### Binding: {voiceId}

A persona (`character.json` `voice`, or a cast member's `voice`) names a library voice with
exactly one key:

```json
{ "voice": { "voiceId": "narrator-1" } }
```

`speakLines` resolves it through `resolveVoiceId` at speak time. A Project Home or Project Video
tool (non-built-in macro) may carry a default `voiceId` (`macroLibrary.cjs`).

### Precedence

Which voice speaks a video's narration, first match wins:

1. the press's Voice pick (`press-voice-select`, `VoiceSelect.tsx`; `Default` sends none);
2. the tool's `voiceId`;
3. the persona's `voice`;
4. the kit default.

A project Video tool job gets the voice set from the press pick, else the tool's `voiceId`
(`macroJobDispatch.cjs`), twice: as `SM_VOICE_ID` in its process env (PRD frontmatter `voiceId`,
exported by the scheduler) and as a `Voice: <id>` line in its PRD notes. A tool without a job, and
Demo Video, get only the `Voice: <id>` line in their prompt. The `demo-video-builder` persona reads
a `Voice: <id>` line, else `SM_VOICE_ID`, else the persona's `voice`, else `af_heart` / `am_michael`.

### The voice lane

Every synthesis — video runs and previews alike — waits in the one machine-wide voice lane
(`demo-video-kit/voiceLane.cjs`): a cross-process FIFO of tickets under
`<voices home>/lane/<heavy|light>/` (or `SM_VOICE_LANE_DIR`). Two lanes, `heavy` and `light`,
each run **one synthesis at a time**. `heavy` in the voice file wins; otherwise a Kokoro voice is
light and every other engine heavy. Dead-pid or 6 h old tickets are swept; a waiting call prints
its position; each finished call appends a line to `<voices home>/usage.jsonl`. A lane wait is
bounded by the time left before the job deadline minus the same reserve (a quarter of the time
left, at most 45 minutes), or 6 h with no job deadline. A lane wait that
times out fails the run with its position (`timed out after <ms> ms at position N of M`), and its
ticket leaves the lane with no usage line: nothing was synthesized.

### Preview cache

`previewVoice` (`lib/project-pages/voicePreview.cjs`) is the one preview path. A clip is cached at
`<voices home>/cache/<previewKey>.wav`, where `previewKey` is the sha256 of voice id + trimmed
text + canonical resolved voice JSON + approval pin — editing a voice or a pin file changes the
key, so a stale clip is never served. At most 200 clips are kept (oldest removed).

### Approval lock

Approve, unapprove and delete are **human clicks in Project Home ▸ Video ▸ Voices only**
(renderer IPC `voices:approve` / `voices:unapprove` / `voices:delete`, `voicesIpc.cjs` — the one
writer of `<voices home>/approvals.json`). An approval stores `pinOf`: the sha256 of the voice's
`{id, voice, pinFiles}` plus each pin file's bytes. An approved voice whose pin no longer matches,
or whose file was removed outside the Voices screen, is refused — never used, never replaced by
a lower scope; re-approve it. Built-ins cannot be approved or deleted, and an approved voice must
be unapproved before it can be deleted.

### Read-only MCP tools

| MCP tool | Route | Answer |
| --- | --- | --- |
| `voice_list` | `GET /admin/voices?cwd=<abs>` | `{ok, voices, errors}` |
| `voice_preview` | `POST /admin/voices/preview {cwd, voiceId, text}` | `ready` (`wavPath`, `cached`, `wallMs`, `audioSeconds`) within 60 s, else `queued` (`lane`, `position`); repeat the call to join the run or read the cache |

Both are read-only (`voiceAdminRoutes.cjs`): no route or MCP tool can add, approve, unapprove or
delete a voice.

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
