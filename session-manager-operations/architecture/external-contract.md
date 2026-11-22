# External contract — what outside apps may rely on

> Other apps on this machine (a planning tool, an idea tool, a publishing pipeline) hand work to Session
> Manager and read it back. This page lists everything they may rely on. Anything not on this page is
> internal and can change without notice. The version number lives in `src/main/lib/externalContract.cjs`.

## 1. Discovery

Session Manager runs a small HTTP server while the app is open. It listens on `127.0.0.1` only, on a
port the OS picks at each boot. It writes how to reach it to a file.

### The `admin-api.json` file

Path: `~/.claude/session-manager/admin-api.json` (mode `0600`). A dev launch (`SM_DEV=1`) writes
`admin-api.dev.json` and an e2e launch (`SM_E2E=1`) writes `admin-api.e2e.json` instead, so a
production consumer reads `admin-api.json` only. Written by `src/main/lib/feedback-remote/localAdminHttp.cjs`.

| Field | Type | Meaning |
| --- | --- | --- |
| `port` | number | The port to call. It is `null` for a moment at boot, before the server listens. |
| `token` | string | The bearer token. A new one is made at **every** app boot. |
| `appVersion` | string or null | The app's `package.json` version. |
| `contractVersion` | number | The version of this contract. Today it is `1`. |

Read the file again whenever a call fails with a connection error or `401`. The app may have restarted.

### Auth

Every request, the health route included, needs this header:

```
Authorization: Bearer <token>
```

A missing or wrong token answers `401 { "ok": false, "error": "unauthorized" }`.

### Health

`GET /__admin/health` → `200 { "ok": true, "contractVersion": 1, "appVersion": "0.138.0" }`.

An unknown route answers `404` with `error: "not found"`, `unknownRoute` (for example `"GET /admin/nope"`),
`contractVersion` and `appVersion`. A route's own "not found" (for example an unknown Epic) has no
`unknownRoute` key.

### The version rule

- A change that **breaks** an outside caller increments `contractVersion`. That covers an admin route, an
  MCP tool, an audit event kind listed here, or the `admin-api.json` shape.
- An **additive** change (a new route, a new optional field) does not.

Advice for a consumer: store the `contractVersion` you were written against. At start, read it from the
health route or the file. If it is different, **stop loudly** (log an error, exit non-zero). Do not guess.
Ignore fields you do not know; new ones may appear without a version change.

## 2. Handoff — giving work to Session Manager with your own id

You can pass `externalRef`: your own id for the work. Session Manager stores it on the Epic, so you can
find the Epic again by your id and a retry never makes a second Epic.

### `externalRef` rules (`src/main/lib/epic/externalRef.cjs`)

| Rule | Value |
| --- | --- |
| Type | string; leave it out (or `null`) for no ref |
| Allowed characters | letters, digits, and `.` `_` `:` `/` `@` `-` |
| Length | 1 to 200 characters, after trimming spaces at both ends |
| Bad value | `400` with an error message; nothing is created |
| Where stored | on the Epic as `source.externalRef`, and in a per-project ref index |
| Scope | unique per **receiving project** (`cwd`) |

### A. `feedback_open_session` (MCP) / `POST /admin/feedback/open-session`

Opens a `proposed` Epic in **another** project (`toCwd`). A human there must approve it before it runs.
Code: `src/main/lib/feedback-remote/crossProjectFeedback.cjs` (`openFeedbackSession`).

Required fields: `toCwd`, `fromCwd` (must differ), `title`, `body`, `motivation`, `acceptanceCriteria`
(at least one item), and `plan` when `tag` is `feature`. `tag` is `bug`, `feature` or `discussion`.

- First call: creates the Epic and answers with `status: "proposed"` (or `"auto-approved"`) and the
  `externalRef`.
- Repeat with the same `toCwd`, `fromCwd` and `externalRef`: creates nothing, writes no receipt and no
  audit row. It answers `200` with `status: "existing"`, `existing: true` and the existing `epicId`. This
  holds even if that Epic is already completed (the `note` says so).
- **409**: the same `externalRef` in that `toCwd` already belongs to a different sender (another
  `fromCwd`, or a macro run). Pick a different ref.

Request:

```json
POST /admin/feedback/open-session
{
  "toCwd": "/home/me/Projects/site",
  "fromCwd": "/home/me/Projects/planner",
  "title": "Publish the November post",
  "body": "The draft is ready in drafts/nov.md.",
  "tag": "feature",
  "motivation": "The planner scheduled this post for this week.",
  "plan": ["Render drafts/nov.md", "Publish it"],
  "acceptanceCriteria": ["The post is live"],
  "externalRef": "planner:task/4821"
}
```

Answer to a repeat of the same call:

```json
{
  "ok": true,
  "epicId": "ps-abc123",
  "status": "existing",
  "existing": true,
  "externalRef": "planner:task/4821",
  "toCwd": "/home/me/Projects/site",
  "fromCwd": "/home/me/Projects/planner",
  "note": "This externalRef was already handed off: Epic ps-abc123 in the receiving project is still open. No new session was opened."
}
```

### B. `POST /admin/macros/run`

Starts a saved macro (hot key) from a script. Code: `src/main/lib/feedback-remote/macroAdminRoutes.cjs`
(`runHandler`). Body: `{ cwd, id, inputs?, effort?, externalRef? }`. The route exists only while the app
window is up. A human must have ticked **Can be started by a script** on that macro, or the answer is `400`.

- First call with a ref: starts the macro and answers `{ ok: true, epicId, alreadyRunning: false, externalRef }`.
- Repeat with the same `cwd` and `externalRef` for the same macro: starts nothing and answers `200` with
  `existing: true`, the same `epicId`, and `alreadyRunning` (true while that Epic's chat is busy).
- **409**: the ref in that `cwd` already names an Epic made by something else (another macro, or a
  feedback handoff). The answer carries that `epicId` and the `externalRef`.
- A new ref is a new run, even while an earlier run of the same macro is still busy. Without a ref, a
  call while the macro's Epic is still running returns that Epic with `alreadyRunning: true`.
- A launch failure is `503`.

Request:

```json
POST /admin/macros/run
{ "cwd": "/home/me/Projects/site", "id": "daily-digest-1a2b3c", "externalRef": "digest:2026-11-21" }
```

Answer to a repeat:

```json
{ "ok": true, "epicId": "ps-def456", "existing": true, "alreadyRunning": false, "externalRef": "digest:2026-11-21" }
```

### Replies

A handoff made with `feedback_open_session` can ask for its reply as an event. Code:
`src/main/lib/feedback-remote/crossProjectFeedback.cjs` (`replyMode`) and
`src/main/lib/feedback-remote/crossProjectReply.cjs` (`sendFeedbackReply`, `replyAsEvent`).

`replyMode` is an optional field on `feedback_open_session` / `POST /admin/feedback/open-session`:

| Value | What a reply does |
| --- | --- |
| `prompt` (default) | Wakes the asking Epic's chat with the reply. If that Epic cannot take it, a new proposed session opens in the asking project. |
| `event` | Records the reply as data in the audit log. For an app that keeps its own records and has no chat. |

Any other value is `400`. Leaving it out, or `null`, means `prompt`.

In `event` mode no chat is prompted and no fallback session is opened. This holds also when the asking
Epic is gone or not active, and when the sender had no Epic at all. Only the asking `fromCwd` is needed.
When the asking Epic is still active, the reply is also added to its event list, but its chat is not woken.

Result fields of the first call:

| Field | Meaning |
| --- | --- |
| `replyThread` | `true` when the new Epic has a way to reply back. Always `true` in `event` mode. In `prompt` mode it is `false` when the sending Epic could not be found. |
| `replyMode` | Always in the result: `"prompt"` or `"event"`, the mode the handoff got. |

A repeat call with the same `externalRef` (`status: "existing"`) carries neither field.

The receiving session answers with `feedback_reply` (`message`, `outcome`: `done`, `blocked` or
`question`). At most 3 replies per handoff. In `event` mode the reply answers `delivery: "event-only"`,
`reason: "asker-requested-event"`, and writes one `epic_cross_project_reply` row to the audit log.

Read those rows with `GET /admin/events?kinds=epic_cross_project_reply` (cursor rules as in section 4).
A `prompt`-mode reply writes a row of the same kind with fewer fields and no `mode`; skip rows where
`mode` is not `"event"`.

The event-mode `epic_cross_project_reply` row:

| Field | Meaning |
| --- | --- |
| `at` | ISO time the row was written. |
| `kind` | `"epic_cross_project_reply"`. |
| `cwd` | The asking project (your `fromCwd`). |
| `epicId` | The asking Epic, or `null` when the sender had none. |
| `fromCwd` | The replying project (the handoff's `toCwd`). |
| `fromEpicId` | The replying Epic (the one the handoff opened). |
| `outcome` | `done`, `blocked` or `question`. |
| `delivery` | `"event-only"`. |
| `mode` | `"event"`. |
| `externalRef` | Your handoff's `externalRef`. Present only when the handoff had one. |
| `message` | The reply text, cut to its first **2000 characters**. |
| `referencePaths` | Paths the reply points at, at most 10. |

Match a reply to your own record by `externalRef`. Send one on every handoff you want to follow; without
it, a reply can only be told apart by `fromEpicId`.

Request:

```text
GET /admin/events?after=2026-11-21T17:00:00.000Z~1&kinds=epic_cross_project_reply
```

Answer:

```json
{
  "ok": true,
  "events": [
    {
      "at": "2026-11-21T17:42:10.512Z",
      "kind": "epic_cross_project_reply",
      "cwd": "/home/me/Projects/planner",
      "epicId": null,
      "fromCwd": "/home/me/Projects/site",
      "fromEpicId": "ps-abc123",
      "outcome": "done",
      "delivery": "event-only",
      "mode": "event",
      "externalRef": "planner:task/4821",
      "message": "The November post is live at /blog/nov.",
      "referencePaths": ["drafts/nov.md"]
    }
  ],
  "next": "2026-11-21T17:42:10.512Z~1",
  "more": false,
  "gap": false
}
```

## 3. Reads — an Epic's state and cost

Code: `src/main/lib/epic/epicAdminRoutes.cjs` (routes), `src/main/lib/epic/epicOutsideRead.cjs` (the
record), `src/main/lib/epic/epicOutsideState.cjs` (the state). Reads write no file and no audit row.

| Route | MCP tool | Query / args | Answer |
| --- | --- | --- | --- |
| `GET /admin/epics` | `epic_list` | `cwd` (absolute), `state?` (one of the eight states), `limit?` (1–200, default 50), `offset?` (default 0) | `{ ok, epics, total, limit, offset, hasMore }` |
| `GET /admin/epic` | `epic_get` | `cwd`, exactly one of `id` or `externalRef`, `receipt?` (`1` or `true`; the tool takes a boolean) | `{ ok, epic }` or `404 { ok: false, error: "not found" }` |

- `epic_list` / `GET /admin/epics` lists only **open** Epics (`proposed` or `active`), newest first. When
  `hasMore` is true the tool adds a `note`; ask again with a higher `offset`.
- `epic_get` / `GET /admin/epic` also finds a **completed** Epic, from its archive.
- A bad query is `400 { ok: false, error: "invalid query", details }`. A `cwd` that is not absolute or has
  no `session-manager-operations/` folder is `400` with the reason. A project Session Manager has never
  opened reads as empty (list) or `404` (get).

### The Epic record

| Field | Type | Meaning |
| --- | --- | --- |
| `epicId` | string | The Epic's id. |
| `cwd` | string | The project it belongs to. |
| `title` | string or null | First paragraph of the Epic's goal text. |
| `goal` | string or null | The rest of the goal text, after the first blank line. |
| `tag` | string or null | The Epic's Mission tag. |
| `agentType` | string or null | The persona running it. |
| `status` | string or null | Lifecycle: `proposed`, `active` or `completed`. |
| `state` | string | The outside state (table below). Use this, not `status`. |
| `blocked` | object or null | Set only when `state` is `blocked`: `{ kind, prds: [{ slug, reason }] }`. |
| `prds` | object | Counts of the Epic's scheduler jobs: `total`, `pending`, `running`, `completed`, `failed`, `needsReview`, `quarantined`, `skipped`. |
| `verified` | string[] | PRD slugs whose newest validator verdict is VERIFIED. |
| `refuted` | `{ slug, reason }[]` | PRD slugs whose newest verdict is REFUTED. `reason` is at most 300 characters. |
| `unvalidated` | string[] | Completed work PRDs with no verdict newer than their finish. |
| `externalRef` | string or null | Your id, if the Epic was made with one. |
| `source` | object | `{ producer, fromCwd, fromEpicId, macroId }`, each a string or null. |
| `createdAt` | string or null | ISO time. |
| `completedAt` | string or null | ISO time. |
| `receipt` | object | Only when you asked for it. See below. |

### The eight states

Checked in this order; the first that fits wins.

| State | Meaning |
| --- | --- |
| `closed` | A human closed the Epic (`status` is `completed`). |
| `awaiting_approval` | The Epic is `proposed`; it waits for a human to approve it. |
| `needs_input` | The agent asked a question and the chat is idle, waiting for a human. |
| `blocked` | Something stopped the work; see `blocked.kind`. |
| `working` | The chat is busy, or a PRD job is pending or running. |
| `verified` | Work PRDs completed and every one has a VERIFIED verdict newer than its finish. Finished PRDs are known from the Epic's check-in events as well as from the queue, so this holds after the queue rows are gone. |
| `in_review` | Some completed work PRDs still wait for a validator verdict. Finished PRDs are known from the Epic's check-in events as well as from the queue. |
| `open` | Active, with nothing running and nothing to review. |

### Blocked kinds

Checked in this order.

| `blocked.kind` | Meaning |
| --- | --- |
| `refuted` | A validator REFUTED a PRD. |
| `failed` | A PRD job failed (cancelled rows do not count). |
| `needs_review` | A PRD job is parked for review. |
| `quarantined` | A PRD job is quarantined. |

The refuted rule: verdicts are read over the Epic's whole history, keyed by PRD slug, and the **newest**
wins. A refuted PRD keeps the Epic `blocked` until a validator later **verifies that same PRD**. A
verdict on a different PRD (for example a fix PRD) does not clear it.

### The receipt (opt-in)

Ask with `receipt=1` (HTTP) or `receipt: true` (`epic_get`). Without it, no run folder or transcript is
read. `receipt` is `{ jobs, chat }`; each part is `null` when it can't be read.

`receipt.jobs` — all scheduler runs of the Epic's PRDs since the Epic was created, every attempt counted:

| Field | Meaning |
| --- | --- |
| `runs` | Number of runs. |
| `costUsd` | Summed cost in US dollars, over runs that reported one. |
| `costKnownRuns` | How many runs reported a cost. |
| `outputTokens` | Summed output tokens. |
| `numTurns` | Summed turns. |
| `durationMs` | Summed run time. |
| `byPrd` | `[{ slug, runs, costUsd, lastExitCode, lastFinishedAt }]`. |

`receipt.chat` — the Epic's own chat transcript, each model call counted once:

| Field | Meaning |
| --- | --- |
| `calls` | Number of model calls. |
| `inputTokens`, `cacheWriteTokens`, `cacheReadTokens`, `outputTokens` | Token totals. |
| `largestContext` | The largest single-call context. |
| `models` | Calls per model name. |
| `bySource` | `[{ source, approxTokens }]`, a rough split of what filled the context. |

## 4. Events — following state changes

Code: `src/main/lib/epic/epicStateWatcher.cjs` (writes), `src/main/lib/telemetry/auditEvents.cjs` (cursor
reader), `src/main/lib/telemetry/eventsAdminRoutes.cjs` (route).

### The `epic_state_changed` row

The scheduler tick runs the watcher about once a minute, and only **while the app runs**. It compares each
open Epic's `state` (and `blocked.kind`) with its last snapshot and writes one audit row per change. While
the app is closed nothing is written; changes made in that time show up as one row on the next tick. The
very first run only takes a snapshot and writes no rows.

| Field | Meaning |
| --- | --- |
| `at` | ISO time the row was written. |
| `kind` | `"epic_state_changed"`. |
| `cwd` | The project. |
| `epicId` | The Epic. |
| `from` | The old state, or `null` for an Epic seen for the first time. |
| `to` | The new state. Besides the eight states it can be `"gone"`: the Epic left the open list and is not completed. |
| `blockedKind` | Present only when the new state is `blocked`. |
| `externalRef` | Present only when the Epic has one. |

### `GET /admin/events`

Query: `after?` (a cursor or `start`), `kinds?` (comma list; default `epic_state_changed`; also
allowed: `job_transition`), `limit?` (1–500, default 100).

Answer: `{ ok: true, events, next, more, gap }`.

| Field | Meaning |
| --- | --- |
| `events` | Matching rows, oldest first. |
| `next` | The cursor to send as `after` next time. Save it. |
| `more` | `true` when `limit` cut the page short; call again at once with `next`. |
| `gap` | `true` when your cursor is older than the oldest row still kept; some rows were lost. |

Cursor form: `<ISO timestamp>~<count>`, for example `2026-11-01T00:00:00.000Z~1`. `after=start` reads
from the first kept row. No `after` returns no events and a `next` that means "from now". A malformed
cursor or an unknown kind is `400 { ok: false, error: "invalid query", details }`.

A consumer loop:

1. At first start, read the states you care about (`epic_get` / `epic_list`), then call `/admin/events`
   with no `after` and save `next`.
2. Every so often, call with `after=<saved next>`. Handle `events`, save the new `next`. Repeat at once
   while `more` is true.
3. On `gap: true`, do not trust your old view: **re-read the states** with `epic_get` / `epic_list`, then
   carry on from the new `next`.

## 5. Agent library

Lists this machine's agent personas, so an outside launcher can start a job from the same roster with a
pinned model instead of copying persona text into its own prompts. Code:
`src/main/lib/persona-macro/agentAdminRoutes.cjs` (route), `src/main/agentLibrary.cjs` (`listPersonas`),
`src/main/lib/claude/effectiveModelInfo.cjs` (`resolveEffectiveModelInfo`, the `resolved` values). The read
writes no file and no audit row.

| Route | MCP tool | Query / args | Answer |
| --- | --- | --- | --- |
| `GET /admin/agents` | `agent_list` | `cwd?` (absolute project path) | `{ ok: true, agents }`, sorted by `name` |

- No argument is required. Without `cwd`, no agent has a `resolved` key.
- A bad query is `400 { ok: false, error: "invalid query", details }`. A `cwd` that is not absolute or has
  no `session-manager-operations/` folder is `400` with the reason.
- The list is the global persona folder (`~/.claude/agents/`). A project's own override of a persona is
  not shown in the fields below; it shows only in `resolved`.

### The agent

These are the persona file's frontmatter fields, plus `path` and `resolved`. The persona body (its prompt
text) is never in the answer.

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | The persona's name. Use it as `agentType`. Falls back to the file name. |
| `title` | string or null | A short display title. |
| `description` | string or null | One line on what the persona is for. |
| `model` | string or null | The model the frontmatter pins: an alias (`opus`), a full id, or `inherit`. |
| `effort` | string or null | The effort level the frontmatter pins. |
| `tags` | string[] | Mission tags the persona fits. Empty when none are set. |
| `tools` | string[] | Tools the persona may use. Empty when the frontmatter lists none. |
| `executorOnly` | boolean | `true` when the persona only executes one scoped PRD. The app warns when one is picked to lead an Epic. |
| `agentCli` | string or null | Another agent CLI the persona runs on. `null` means Claude Code. |
| `agentCliModel` | string or null | The model for that other CLI. `null` when `agentCli` is `null`. |
| `seedVersion` | number or null | The version stamp of a persona Session Manager seeds. `null` when the file has none. |
| `path` | string or null | Absolute path of the persona file in the global folder. |
| `resolved` | object or null | Present only when you passed `cwd`. See below. |

### `resolved`

What the persona resolves to when it runs in the project `cwd`. That takes in the project's own override
of the persona and the project's Claude settings.

| Field | Meaning |
| --- | --- |
| `modelId` | A real model id, never an alias: the pinned id when the model is already a full id, otherwise the id a recent run of this persona in this project used when it ran on the persona's own model. `null` when that is unknown. |
| `modelAlias` | The effective model alias (or full id) the launch uses: the persona's own model, the project override's, or the Claude settings default when the persona inherits. `null` when none is set anywhere. |
| `modelSource` | Where the model came from: `persona`, `persona-overlay` (the project's override), `settings` (the persona sets none; the Claude settings model is used), `inherit` (no model anywhere) or `fallback` (the persona could not be read). |
| `effort` | The effort level, or `null` when the persona sets none. |
| `effortSource` | `persona`, `persona-overlay`, `inherit` (the persona sets no level) or `null` (the persona could not be read). |

`resolved` is absent when you did not pass `cwd`. It is `null` when resolving that persona threw. Today
the resolver never throws, so expect an object; still handle `null`.

### Launching from an outside app

1. Call `GET /admin/agents?cwd=<project>` and pick an agent by `name`.
2. Read the file at `path` for the prompt text (skip this when `path` is `null`). Strip the frontmatter (the block between the first two
   `---` lines); the rest is the body.
3. Pin the model, in this order. Never start a session without a model.
   1. When `resolved.modelId` is set, pin `--model <resolved.modelId>`.
   2. Otherwise, when `resolved.modelAlias` is set, pin `--model <resolved.modelAlias>`.
   3. When both are `null` (or `resolved` itself is `null`), do not start the session; report that the
      agent has no model to pin.
4. Pass `resolved.effort` as the effort when it is not `null`.

`path` is the global file. A project override of the body is not in it. When `resolved.modelSource` is
`persona-overlay`, the project changed this persona; read `<cwd>/.claude/agents/<name>.md` as well if
you need the project's own text.

## 6. Needs you

An outside app can put one question in front of the owner. It shows in the Dashboard's **Needs you**
list, next to Session Manager's own items. The owner answers there, or in the app behind the link. Code:
`src/main/lib/feedback-remote/needsYouAdminRoutes.cjs` (routes),
`src/main/lib/feedback-remote/needsYouStore.cjs` (the store and its limits),
`src/main/lib/feedback-remote/needsYouIpc.cjs` (the owner's answer).

| Route | Body / query | Answer |
| --- | --- | --- |
| `POST /admin/needs-you` | `{ app, id, title, why?, link?, options?, externalRef? }` | `200 { ok, item, created, changed }`, `400`, or `429` at a limit |
| `POST /admin/needs-you/withdraw` | `{ app, id }` | `200 { ok, item }` or `404 { ok: false, error: "not found" }` |
| `GET /admin/needs-you` | `app?`, `status?` (`open`, `answered` or `withdrawn`) | `200 { ok, items }` |

There is no route to answer. Only the owner answers, in the app window.

### The item

The key is `app` + `id`. The answer to every route carries the stored item with these fields.

| Field | Type | Limit / meaning |
| --- | --- | --- |
| `app` | string | Your app's name. 1 to 40 letters, digits, `.` `_` or `-`. Shown to the owner. |
| `id` | string | Your id for the item. Same rules as `externalRef` (section 2). Required. |
| `title` | string | The question. 1 to 200 characters, one line. |
| `why` | string | Optional context, at most 1000 characters. Stored as `""` when left out. |
| `link` | string or null | Optional, at most 2000 characters. Must start with `http://` or `https://`. |
| `options` | string[] or null | Optional. 2 to 5 distinct answers, each 1 to 80 characters. |
| `externalRef` | string or null | Optional; same rules as in section 2. A re-post to an open item replaces it. |
| `status` | string | `open`, `answered` or `withdrawn`. |
| `answer` | string or null | The option the owner picked. |
| `createdAt`, `updatedAt` | string | ISO times. |
| `answeredAt` | string or null | ISO time of the answer. |

### Rules

- **One decision per item.** Post a second item for a second question.
- **A question the owner answers in Session Manager** has `options`: 2 to 5 of them. The owner sees one
  button per option.
- **A notice the owner settles in your app** has no `options`, only a `link`. The owner sees an **Open**
  button. Session Manager cannot answer it; it stays `open` until you withdraw it.
- **At most 10 open items per app**, and at most 50 open items in total. A new item over either limit is
  `429` with the reason. Answered and withdrawn items do not count.
- Posting the same `app` + `id` again while the item is `open` replaces every caller field: `title`,
  `why`, `link`, `options` and `externalRef` (a left-out field is cleared). It answers `created: false`.
- `changed` is `true` when the post created the item or any stored field differs after it. An identical
  re-post answers `changed: false`, keeps `updatedAt`, and writes no `needs_you_posted` audit row.
- Posting an `app` + `id` that is already answered or withdrawn changes nothing. It answers `200` with the
  old item, `created: false` and `changed: false`. Use a new `id` to ask again.
- Answered and withdrawn items are dropped 14 days after they closed.

### What the owner sees

The row shows `title`, then `why`, and your `app` name when opened. All item text is shown as **plain
text**; no HTML or Markdown is rendered. The **Open** button appears when the item has a `link`. The link
opens in the system browser only when it is `http` or `https`; the app refuses any other scheme.

### How the answer comes back

When the owner picks an option, the item turns `answered` and one `needs_you_answered` audit row is
written:

| Field | Meaning |
| --- | --- |
| `at` | ISO time the row was written. |
| `kind` | `"needs_you_answered"`. |
| `app` | The item's `app`. |
| `id` | The item's `id`. |
| `answer` | The option the owner picked. |
| `externalRef` | Present only when the item has one. |

Read the rows with `GET /admin/events?kinds=needs_you_answered` (cursor rules as in section 4). Or read
the item's `status` and `answer` with `GET /admin/needs-you?app=<app>`. On a `gap`, re-read with
`GET /admin/needs-you`.

When a question no longer matters (it was settled in your app, or the work went away), **withdraw it**
with `POST /admin/needs-you/withdraw`. It leaves the owner's list at once. A withdrawal of an item that is
not `open` is `404`.

Post:

```json
POST /admin/needs-you
{
  "app": "planner",
  "id": "task-4821-date",
  "title": "Publish the November post on Tuesday or Thursday?",
  "why": "Both days are free on the calendar.",
  "link": "http://localhost:4100/tasks/4821",
  "options": ["Tuesday", "Thursday"],
  "externalRef": "planner:task/4821"
}
```

Answer:

```json
{
  "ok": true,
  "created": true,
  "changed": true,
  "item": {
    "app": "planner",
    "id": "task-4821-date",
    "title": "Publish the November post on Tuesday or Thursday?",
    "why": "Both days are free on the calendar.",
    "link": "http://localhost:4100/tasks/4821",
    "options": ["Tuesday", "Thursday"],
    "externalRef": "planner:task/4821",
    "status": "open",
    "answer": null,
    "createdAt": "2026-11-21T17:00:00.000Z",
    "updatedAt": "2026-11-21T17:00:00.000Z",
    "answeredAt": null
  }
}
```

Withdraw:

```json
POST /admin/needs-you/withdraw
{ "app": "planner", "id": "task-4821-date" }
```

Answer: `{ "ok": true, "item": { …, "status": "withdrawn", … } }`.

List:

```text
GET /admin/needs-you?app=planner&status=answered
```

Answer:

```json
{
  "ok": true,
  "items": [
    {
      "app": "planner",
      "id": "task-4821-date",
      "title": "Publish the November post on Tuesday or Thursday?",
      "why": "Both days are free on the calendar.",
      "link": "http://localhost:4100/tasks/4821",
      "options": ["Tuesday", "Thursday"],
      "externalRef": "planner:task/4821",
      "status": "answered",
      "answer": "Thursday",
      "createdAt": "2026-11-21T17:00:00.000Z",
      "updatedAt": "2026-11-21T18:05:12.004Z",
      "answeredAt": "2026-11-21T18:05:12.004Z"
    }
  ]
}
```

The matching event:

```json
{ "at": "2026-11-21T18:05:12.010Z", "kind": "needs_you_answered", "app": "planner", "id": "task-4821-date", "answer": "Thursday", "externalRef": "planner:task/4821" }
```

## 7. Tasks — one Claude call for a project

A script can run ONE headless `claude -p` for a project, under the machine-wide slot cap, recorded in that
project's Task ledger (`session-manager-operations/tasks/`). The owner must first turn on **Scripts may run
Tasks** for the project on the Scheduler → Tasks page. Code: `src/main/lib/tasks/taskAdminRoutes.cjs`
(route), `taskRun.cjs` (spawn), `taskLedger.cjs` (ledger), `taskSwitch.cjs` (switch).

| Route | Body | Answer |
| --- | --- | --- |
| `POST /admin/tasks` | `{ cwd, agent, missionId, prompt, timeoutSec?, slotWaitSec?, priority?, caller?, runtime? }` | `200 { ok: true, taskId, status, stdout, envelope, usage, costUsd, cliCostUsd, durationMs, slotWaitMs, exitCode, model, effort, sessionId, quota }` |

- `cwd` is the absolute project root. `agent` names a persona; its `model` and `effort` are used, never its
  body. `timeoutSec` 1-3600 (default 600), `slotWaitSec` 0-3600 (default 120), `priority` `interactive` or
  `batch` (default). `caller` is `{ pipeline?, runId?, step?, attempt? }`.
- `runtime` is `{ outputFormat?: json|text|stream-json, settingSources?, mcpConfig?: string[] (relative to
  cwd), strictMcpConfig?, allowedTools?: string[], tools?: string[] (an empty array denies all), maxTurns?
  1-200, systemPrompt? (≤ 100 KiB, replaces the system prompt), skipPermissions?, disableAutoMemory?,
  sessionId? (uuid), resume? (uuid), persistSession?, cwd? (absolute dir to run in) }`. Unknown keys are
  rejected. No caller environment variable reaches the child.
- Errors: `400 invalid_request` (with `details`; also `sessionId` with `resume`, or `resume` with
  `persistSession: false`), `400 mcp_config_missing`, `403 tasks_disabled` (with `hint`), `404 unknown_agent`,
  `409 session_busy`, `422 model_unresolved` / `effort_unresolved`, `429 too_many_waiting`, `503 slot_timeout`.
- `status` in a `200` is the run's outcome: `ok`, `error`, `rate_limited`, `timeout`, `spawn_failed`. Closing
  the connection before the answer cancels the wait or the run (ledger status `caller_gone`).

## 8. Not part of the contract

Do not build on these. They change without a version bump.

- Any file under a project's `session-manager-operations/` folder, or under `~/.claude/session-manager/`
  other than `admin-api.json` (the audit log file, the state snapshot, the ref index, queue files).
- The headings and wording inside validation records and PRD bodies. Read `verified` / `refuted` from
  the Epic record instead.
- Renderer state: anything the app window shows or keeps in memory.
- Audit row kinds other than `epic_state_changed`, `job_transition`, `epic_cross_project_reply` and
  `needs_you_answered` (so not `needs_you_posted` or `needs_you_withdrawn`), and the `caller` field (the
  events route strips it).
- Admin routes and MCP tools not named on this page.
