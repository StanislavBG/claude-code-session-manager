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
| `verified` | Work PRDs completed and every one has a VERIFIED verdict newer than its finish. |
| `in_review` | Some completed work PRDs still wait for a validator verdict. |
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

## 5. Not part of the contract

Do not build on these. They change without a version bump.

- Any file under a project's `session-manager-operations/` folder, or under `~/.claude/session-manager/`
  other than `admin-api.json` (the audit log file, the state snapshot, the ref index, queue files).
- The headings and wording inside validation records and PRD bodies. Read `verified` / `refuted` from
  the Epic record instead.
- Renderer state: anything the app window shows or keeps in memory.
- Audit row kinds other than `epic_state_changed` and `job_transition`, and the `caller` field (the
  events route strips it).
- Admin routes and MCP tools not named on this page.
