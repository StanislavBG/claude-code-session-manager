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

`GET /__admin/health` answers `200` with `healthInfo()` (`src/main/lib/externalContract.cjs`):

```json
{
  "ok": true,
  "contractVersion": 1,
  "appVersion": "0.141.0",
  "taskBodyKeys": ["cwd", "agent", "missionId", "prompt", "timeoutSec", "slotWaitSec", "priority", "caller", "runtime", "stream"],
  "taskRuntimeKeys": ["outputFormat", "settingSources", "mcpConfig", "strictMcpConfig", "allowedTools", "tools", "maxTurns", "systemPrompt", "appendSystemPrompt", "disallowedTools", "skipPermissions", "disableAutoMemory", "sessionId", "resume", "persistSession", "cwd"],
  "taskGetKeys": ["cwd", "id", "after"]
}
```

The three lists are the keys `POST /admin/tasks` accepts at the top level (`taskBodyKeys`) and under
`runtime` (`taskRuntimeKeys`), and the query keys of `GET /admin/task` (`taskGetKeys`). The Task schemas are
strict, so an older app answers `400 invalid_request` to a key it does not know. **Before you rely on an
additive Task key, check it is in the matching list.** New keys are additive: `contractVersion` stays `1`.

An unknown route answers `404` with `error: "not found"`, `unknownRoute` (for example `"GET /admin/nope"`),
`contractVersion` and `appVersion`. A route's own "not found" (for example an unknown Epic) has no
`unknownRoute` key.

### The version rule

- A change that **breaks** an outside caller increments `contractVersion`. That covers an admin route, an
  MCP tool, an audit event kind listed here, or the `admin-api.json` shape.
- An **additive** change (a new route, a new optional field) does not. It is recorded as a new
  fingerprint appended under the same version in `CONTRACT_FINGERPRINTS`.

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
| `GET /admin/epic` | `epic_get` | `cwd` (optional when `id` is given), exactly one of `id` or `externalRef`, `receipt?` (`1` or `true`; the tool takes a boolean) | `{ ok, epic }`, `404 { ok: false, error: "not found" }`, or `409 { ok: false, error: "ambiguous epic id", cwds }` (`id` without `cwd` only) |

- `epic_list` / `GET /admin/epics` lists only **open** Epics (`proposed` or `active`), newest first. When
  `hasMore` is true the tool adds a `note`; ask again with a higher `offset`.
- `epic_get` / `GET /admin/epic` also finds a **completed** Epic, from its archive.
- `GET /admin/epic?id=<epicId>` without `cwd` looks the Epic up across the registered projects: none is
  `404`; more than one is `409`. `externalRef` always needs `cwd`.
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
| `prds` | object | Counts of the Epic's scheduler jobs: `total`, `pending`, `running`, `completed`, `failed`, `needsReview`, `quarantined`, `skipped`, `cancelled`. `cancelled` counts PRDs a human cancelled (their row reads `failed` or `needs_review`); a cancelled PRD never counts as `failed` or `needsReview` and never blocks the Epic. See [Cancelled rows](#cancelled-rows). |
| `verified` | string[] | PRD slugs whose newest validator verdict is VERIFIED. |
| `refuted` | `{ slug, reason }[]` | PRD slugs whose newest verdict is REFUTED. `reason` is at most 300 characters. |
| `unvalidated` | string[] | Completed work PRDs with no verdict newer than their finish. |
| `externalRef` | string or null | Your id, if the Epic was made with one. |
| `source` | object | `{ producer, fromCwd, fromEpicId, macroId }`, each a string or null. |
| `createdAt` | string or null | ISO time. |
| `completedAt` | string or null | ISO time. |
| `verdicts` | object[] | Checked validator verdicts, newest per PRD slug, sorted by `prd`. Item shape below. `[]` when none. |
| `receipt` | object | Only when you asked for it. See below. |

### Cancelled rows

- `GET /admin/scheduler/prds` (compact and full) and `GET /admin/scheduler/jobs` (`scheduler_list_prds`,
  `scheduler_list_jobs`) mark a human-cancelled row with `cancelled: true`. A real failure has no `cancelled`
  field. Only this field of those two routes is part of the contract.
- Every cancelled row leaves the queue (its PRD file moves to `prds-cancelled/`) once its Epic is completed
  and no pending PRD depends on it. This includes the `needs_review` row a cancel writes when the killed
  run's commit had landed; that commit stays in git history.

### `verdicts` items

Read from the scheduler's `plan-records/<epicId>/*.verdicts.json` files (`src/main/lib/epic/epicOutsideRead.cjs`,
`readVerdictFiles`). A file that fails the verdict check is skipped. So `verdicts` holds only validations
saved as checked JSON (Session Manager 0.140.0 and later) whose plan-record files still exist. Plan records
are pruned `planRecordsDays` (default 14) days after the Epic completes, or, for a folder with no Epic
record, once its newest file is that old, so `verdicts` can be `[]` for an Epic that has verdicts. For the
complete sets read `verified` and `refuted`: those come from the Epic's event history and also cover older
text verdicts.

| Field | Type | Meaning |
| --- | --- | --- |
| `prd` | string | The judged PRD's slug (no number prefix). |
| `verdict` | string | `VERIFIED` or `REFUTED`. |
| `reason` | string | One line; never empty when `REFUTED`. |
| `criteria` | object[] | `{ id, met, evidence, missKind? }`. `id` is the criterion's 1-based index as a string. |
| `findings` | object[] | `{ severity, text, file?, missKind? }`. `severity` is `Critical`, `Important` or `Minor`. |
| `validator` | string or null | Slug of the validate PRD that gave the verdict. |
| `at` | string or null | ISO time the verdict was saved. |

`missKind` is one of `not-landed`, `gate-red`, `behavior-wrong`, `not-checked-live`, `missing-test`,
`regression`, `spec-gap`, `security`, `docs-drift`, `other` (`src/main/lib/scheduler/validatorVerdictSchema.cjs`,
`MISS_KIND_MEANINGS`).

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

### `GET /admin/validation-quality`

How often the validator's verdicts held up, for one project. Code: `src/main/validationQualityHandlers.cjs`
(route), `src/main/lib/scheduler/validationQuality.cjs` (`computeValidationQuality`). Read-only. No MCP tool.

Query: `cwd` (absolute project path, required).

Answer: `200 { ok: true, project }`. `project`:

| Field | Meaning |
| --- | --- |
| `cwd`, `project` | The project path and its folder name. |
| `firstPass` | `{ pct, prds }`: judged work PRDs whose first verdict was `VERIFIED`. `pct` is `null` when none was judged. |
| `refuted` | `{ pct, prds }`: judged work PRDs with any `REFUTED` verdict. |
| `fixWaves` | `{ perPlan, plans: [{ plan, fixWaves }] }`: fix-wave plans per original plan. A fix wave is a plan holding a PRD with `fixes`. |
| `escapes` | `[{ fixPrd, escapedPrd, verifiedBy, missKind, reason, at }]`: a fix PRD named a PRD whose newest verdict before it was `VERIFIED`. `at` is epoch ms. |
| `week` | `{ fromMs, toMs, missKinds, topMiss }` for the last 7 days. `missKinds` counts each kind over `REFUTED` verdicts and escapes. `topMiss` is `{ missKind, count, prds, reasons, proposal }` or `null`. |

Errors: a missing or relative `cwd`, or one with no `session-manager-operations/` folder, is
`400 { ok: false, error }`. A project Session Manager has not registered is
`404 { ok: false, error: "not a registered project" }`. A failed read is `500 { ok: false, error }`.

## 4. Events — following state changes

Code: `src/main/lib/epic/epicStateEmitter.cjs` (recomputes an Epic's outside state when its event log or
chain changes and writes `epic.state_changed` to the Epic's event log at the change),
`src/main/lib/telemetry/auditEvents.cjs` (cursor reader; turns each `epic.state_changed` into an
`epic_state_changed` row), `src/main/lib/telemetry/eventsAdminRoutes.cjs` (route).

### The `epic_state_changed` row

One row per change of an Epic's outside state (the `state` of `GET /admin/epic`) or of its `blockedKind`,
recorded at the change as an `epic.state_changed` event in the Epic's event log, read from the per-Epic
event logs of every registered project and merged into the audit-log cursor by `at`. Rows are written when
the change happens, so nothing depends on the app ticking. The set of `to` values is pinned as
`CONTRACT.epicStateChangedTo` in `src/main/lib/externalContract.cjs`. Rows written by 0.141.0's snapshot
watcher stay readable.

| Field | Meaning |
| --- | --- |
| `at` | ISO time of the change. |
| `kind` | `"epic_state_changed"`. |
| `cwd` | The project. |
| `epicId` | The Epic. |
| `from` | The previous recorded state (same words as `to`), or `null` for an Epic's first recorded state. |
| `to` | The new state: one of the eight states (`closed`, `awaiting_approval`, `needs_input`, `blocked`, `working`, `in_review`, `verified`, `open`), or `"gone"` when the Epic no longer exists. |
| `blockedKind` | Present only when `to` is `"blocked"`: the `blocked.kind` of `GET /admin/epic`. |
| `externalRef` | Present only when the Epic has one. |

Version note: 0.142.0 served `epic_state_changed` rows derived at read time from lifecycle transitions
only (`to` one of `awaiting_approval`, `open`, `closed`; no `blockedKind`). Those rows were never stored,
so they do not appear after upgrading. Versions after 0.142.0 serve the fine-grained rows again, and rows
written by 0.141.0's watcher stay readable. A reader that followed Epics on 0.142.0 should, after
upgrading, **re-read the states** it cares about with `GET /admin/epic`, as for `gap: true`.
The contract version stays 1: every `to` word 0.142.0 served is a v1 word, so no v1 reader breaks, and the restore brings back 0.141.0's shape.
The first release after 0.142.0 states the same in its release notes ([`release-notes/after-v0.142.0.md`](../../release-notes/after-v0.142.0.md)).

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
| `POST /admin/tasks` | `{ cwd, agent, missionId, prompt, timeoutSec?, slotWaitSec?, priority?, caller?, runtime?, stream? }` | `200 { ok: true, taskId, status, stdout, envelope, usage, costUsd, cliCostUsd, durationMs, slotWaitMs, exitCode, model, effort, sessionId, quota }` |

- `cwd` is the absolute project root. `agent` names a persona; its `model` and `effort` are used, never its
  body. `timeoutSec` 1-3600 (default 600), `slotWaitSec` 0-3600 (default 120), `priority` `interactive` or
  `batch` (default). `caller` is `{ pipeline?, runId?, step?, attempt? }`.
- `runtime` is `{ outputFormat?: json|text|stream-json, settingSources?, mcpConfig?: string[] (relative to
  cwd), strictMcpConfig?, allowedTools?: string[], tools?: string[] (an empty array denies all), maxTurns?
  1-200, systemPrompt? (≤ 100 KiB, replaces the system prompt), appendSystemPrompt?, disallowedTools?,
  skipPermissions?, disableAutoMemory?, sessionId? (uuid), resume? (uuid), persistSession?, cwd? (absolute
  dir to run in) }`. Unknown keys are rejected. No caller environment variable reaches the child.
- `runtime.appendSystemPrompt` is at most 100 KiB (UTF-8). It becomes `--append-system-prompt <text>`: it is
  appended after Claude Code's default system prompt, or after `systemPrompt` when both are given.
- `runtime.disallowedTools` is a list of at most 50 permission deny rules, for example
  `"WebFetch(domain:localhost)"`. Each rule must start with an ASCII letter, be non-empty after trimming, at
  most 500 chars, with no control characters; a rule with `(` needs a tool name before it, a trailing `)` and
  balanced parentheses. A rule that fails gives `400 invalid_request` (`invalid tool rule`). Each rule reaches
  the CLI as its **own** `--disallowedTools=<rule>` argv element, in order, so one rule can never swallow the
  next. The `=` form and the leading-letter check mean a rule can never become a CLI flag: after a bare
  `--disallowedTools` the CLI reads a later `-`-leading value as a new flag. An empty array sends nothing.
- Errors: `400 invalid_request` (with `details`; also `sessionId` with `resume`, or `resume` with
  `persistSession: false`), `400 mcp_config_missing`, `403 tasks_disabled` (with `hint`), `404 unknown_agent`,
  `409 session_busy`, `422 model_unresolved` / `effort_unresolved`, `429 usage_held`, `503 usage_hold_error`,
  `429 too_many_waiting`, `503 slot_timeout`.
- `429 usage_held`: the usage hold ("pause above", `scheduler.currentUsageHold`) is on. The body is
  `{ ok: false, error: 'usage_held', hold: { reason, window, percent, threshold, resetsAt, baseThreshold? }, detail, hint }`.
  The route checks it after `409 session_busy`, before the ledger start line, and again once the slot is
  granted; the second refusal also carries `taskId` and `slotWaitMs` and stores the end status `usage_held`.
  No body key, `priority` or `caller` bypasses it, and `firePolicy: 'manual'` does not apply to Tasks. A failed
  read answers `503 usage_hold_error` (`details`), never `429`: before the start line with no `taskId`; once
  the slot is granted it releases the slot, stores the end status `usage_held` and also carries `taskId` and
  `slotWaitMs`. Retry after `hold.resetsAt`; never run `claude -p` directly instead.
- `status` in a `200` is the run's outcome: `ok`, `error`, `rate_limited`, `timeout`, `spawn_failed`. Closing
  the connection before the answer cancels the wait or the run (ledger status `caller_gone`).

#### Stream mode: `stream: true`

With `stream: true`, every refusal before the ledger start line keeps its normal status and JSON body (the
`400`, `403`, `404`, `409` and `422` answers above). After the start line the route answers
`200 application/x-ndjson`, one JSON object per line, in this order:

| Line | When |
| --- | --- |
| `{ type: 'sm_task_started', taskId, model, effort, sessionId, startedAt }` | Right after the start line, before the slot wait |
| `{ type: 'sm_task_running', slotWaitMs }` | Once the slot is granted |
| each child stdout line, as-is | The line parses as a JSON object (for example a `stream-json` event) |
| `{ type: 'sm_task_stdout', text }` | Any other child stdout line |
| `{ type: 'sm_task_result', ... }` | Last. The non-stream `200` answer plus `droppedLines`, or the error object the JSON answer would carry (for example `ok: false, error: 'slot_timeout', taskId, slotWaitMs`) |

- Closing the connection before the `sm_task_result` line cancels the wait or the run (`caller_gone`).
- While more than 8 MiB of the answer is unsent (the caller stopped reading), output lines are skipped and
  counted in `droppedLines`. The result line is still written.
- The stream never carries stderr, env or argv.

#### The usage hold: `GET /admin/usage-hold`

| Route | MCP tool | Query / body | Answer |
| --- | --- | --- | --- |
| `GET /admin/usage-hold` | `usage_hold_get` | none (a query string is ignored) | `200 { ok: true, hold, threshold }` |

Code: `src/main/lib/scheduler/usageHoldRoute.cjs`. It answers the same `currentUsageHold()` that
`POST /admin/tasks` refuses on. A runner that starts `claude -p` directly reads it first and starts nothing
automatic while `hold` is not `null`. It is read-only and works whatever the Task switch state.

```http
GET /admin/usage-hold
Authorization: Bearer <token>
```

Nothing held:

```json
{ "ok": true, "hold": null, "threshold": 90 }
```

Held:

```json
{
  "ok": true,
  "hold": {
    "reason": "utilization-held",
    "window": "weekly_all",
    "percent": 93,
    "threshold": 90,
    "resetsAt": "2026-11-27T18:00:00.000Z",
    "detail": "weekly_all window at 93% ≥ 90%, resets 2026-11-27T18:00:00.000Z",
    "baseThreshold": 90
  },
  "threshold": 90
}
```

| Field | Meaning |
| --- | --- |
| `hold` | `null` when nothing is held. |
| `hold.reason` | Always `utilization-held` (never `manual-fire-policy`: firePolicy is the PRD queue's own setting). |
| `hold.window` | The holding usage window that resets last. Names come from the usage payload's `limits[]` kinds (for example `session`, `weekly_all`); `five_hour` / `seven_day` appear only when the payload has no usable `limits[]` entry. |
| `hold.percent` | That window's usage percent. |
| `hold.threshold` | The "pause above" percent the hold was judged at. |
| `hold.resetsAt` | ISO time that window resets, when the hold ends at the latest. |
| `hold.detail` | One readable line about the hold. |
| `hold.baseThreshold` | The saved "pause above" percent the hold started from; present only when it is a number. |
| `threshold` | The saved "pause above" percent (`usageHoldThreshold()`), held or not. |

A failed read answers `503 { ok: false, error: 'usage_hold_error', details }`.

The `usage_hold_get` MCP tool (`scripts/scheduler-mcp-server.cjs`) takes no arguments and returns the route's
answer unchanged; a `503 usage_hold_error` comes back as a tool error. It only reads: it cannot change the
threshold or lift the hold.

### Reading Tasks and importing direct calls

| Route | MCP tool | Query / body | Answer |
| --- | --- | --- | --- |
| `GET /admin/tasks` | `task_list` | `?cwd=&since=&until=&pipeline=&runId=&step=&agent=&status=&source=&limit=&offset=` | `200 { ok: true, tasks, total, hasMore }` |
| `GET /admin/task` | `task_get` | `?cwd=&id=&after=` | `200 { ok: true, task }` |
| `POST /admin/tasks/import` | — | `{ cwd, records: [...] }` (1-100 records, body ≤ 8 MiB) | `200 { ok: true, imported, alreadyImported, rejected: [{ index, error }] }` |

- `task_list` (required `cwd`) and `task_get` (required `cwd`, `id`; optional `after`) are read-only MCP wrappers of the two
  read routes: same arguments, same JSON answer. No MCP tool runs or imports a Task.

- `cwd` must be the absolute project root (`400 invalid_request` otherwise). The two read routes work whatever
  the switch state; the import route answers `403 tasks_disabled` when it is off.
- `GET /admin/tasks`: newest first. `since`/`until` are inclusive ISO timestamps; `pipeline`/`runId`/`step`
  match `caller`; `source` is `sm` (run by Session Manager) or `direct` (imported, shown as "ran without SM");
  `limit` 1-200 (default 50), `offset` ≥ 0. Each task has exactly the `taskFields` keys of
  `externalContract.cjs` (absent values are `null`) and never prompt or output text.
- `GET /admin/task` adds `prompt`, `promptTruncated`, `output`, `outputTruncated`, `stderrTail`, `envelope`
  (each text capped at 1 MiB) and `live`. An unknown id answers `404 unknown_task`.
- `GET /admin/task` follows a running Task. While this app is still running the Task, `status` is `running`,
  `output` is the captured stdout lines from byte offset `after` (default 0), at most 1 MiB cut at a line
  boundary, `outputTruncated` is `true` when more lines remain, `stderrTail` and `envelope` are `null`, and
  `live` is `{ slotAcquired, outputEnd, outputCapped }`. Pass `outputEnd` as the next `after` to get only newer
  lines. `outputCapped` is `true` once the 8 MiB capture cap is reached. For any other Task `live` is `null`,
  and `after` slices the stored output by bytes, rounded forward to the next line boundary. `GET /admin/tasks`
  also reports a Task this app is still running as `running`, never `interrupted`. That status is applied
  before the list filters by `status` and pages, so `total` and `hasMore` count it as `running` too.
- Import hands over the `claude -p` calls a caller made itself while Session Manager was down. A record is
  `{ importId, agent?, model, effort?, missionId, caller?, startedAt (ISO), durationMs, status, exitCode?,
  usage?, costUsd?, sessionId? (uuid), persisted?, prompt?, output?, envelope? }`; `status` is one of `ok`,
  `error`, `rate_limited`, `timeout`, `spawn_failed`, `caller_gone`, `slot_timeout`, `too_many_waiting`,
  `interrupted`. Unknown keys are rejected. Each record is checked on its own: a bad one lands in `rejected`
  and the rest are recorded. A `(cwd, importId)` already recorded (or repeated in the batch) counts as
  `alreadyImported` — a retry is safe. With `usage`, `costUsd` is recomputed from Session Manager's prices
  (your figure is kept as `cliCostUsd`). `persisted: true` needs a `sessionId`; that session is then skipped
  by History like a persisted Task.

## Paired services (over the relay)

A service that does not run on this machine (first one: Kiln) can still hand work to Session Manager. It
pairs once, like the phone, and then calls seven MCP tools through the bilko.run Web Remote relay. Every
message is end-to-end encrypted; the relay sees only boxes. The desktop answers each call by running the
same loopback admin route the tool mirrors, so the answers have the shapes in sections 2-4.

### Pairing (the owner does this once)

1. In Session Manager open **App Settings → Web remote → Pair a service…**. Name the service, pick its
   home project and tick the tools it may call.
2. The dialog shows a one-time code and a **copy command** button. The command is the `service pair` line
   below with the code filled in.
3. Run that command where the service lives. It redeems the code, connects, and prints a 6-digit SAS.
4. Check that the SAS matches the one the desktop shows, and press **Confirm**. The desktop pins the
   service's public key. Until then the service can call nothing.

A pending pairing lives 10 minutes on the desktop; the relay code itself lasts 5. Pairings are stored in
`~/.claude/session-manager/remote-services.json` ([`servicePairings.cjs`](../../src/main/lib/feedback-remote/servicePairings.cjs)) —
that file is not part of the contract.

### Scope and its limits

Enforced on the desktop by [`serviceMcpSession.cjs`](../../src/main/lib/feedback-remote/serviceMcpSession.cjs), on every call:

| Rule | What it means |
| --- | --- |
| Tool allowlist | `tools/list` shows only the tools the owner ticked. Calling any other tool is refused (JSON-RPC error `-32001`) and the route is never run. |
| `homeCwd` binds `fromCwd` | `feedback_open_session` fills a missing `fromCwd` with the service's home project. A different `fromCwd` is refused with 403. |
| Own Epics only | Each Epic the service opens (`feedback_open_session`, `macro_run`) goes into its ledger. `epic_get` answers the route's own 404 for any other Epic, and `events_read` drops rows of other Epics. |
| `replyMode` default `event` | A service has no chat to wake, so a missing `replyMode` becomes `event`. Replies arrive as `epic_cross_project_reply` rows through `events_read`. |
| `cmd:mcp` only | A service may send only boxed `cmd:mcp` envelopes. Anything else is refused with an opaque `rejected` and written to the audit log. |
| No env identity | `originClaudeSessionId` / `originProjectRoot` sent by a service are dropped; only a local process may vouch for a session. |
| Projects folder binds `parentDir` | `project_create` always runs in the projects folder the owner approved at pairing. A pairing without one is refused with 403 (audit `refused:projectRoot`; re-pair to grant the tool). A `parentDir` that does not resolve to that folder is refused with 403 (audit `refused:parentDir`; the answer names the approved `projectRoot`). `fromCwd` is always the service's home project; one sent by the service is overwritten. |

### The seven tools

Defined once in [`serviceMcpTools.cjs`](../../src/main/lib/feedback-remote/serviceMcpTools.cjs). The first four share their
`inputSchema` objects with the local stdio MCP server, so a service and a local agent see the same schemas.
`macro_run`, `events_read` and `project_create` are served only to a paired service.

| Tool | Arguments (required in **bold**) | Route it mirrors |
| --- | --- | --- |
| `feedback_list_projects` | none | `GET /admin/feedback/targets` |
| `feedback_open_session` | **`toCwd`**, **`title`**, **`motivation`**, **`acceptanceCriteria`**, **`body`**, `fromCwd`, `plan`, `outOfScope`, `series`, `tag`, `fromEpicId`, `agentType`, `referencePaths`, `autoStart`, `humanRequestQuote`, `externalRef`, `replyMode` | `POST /admin/feedback/open-session` (§2 A) |
| `macro_list` | `cwd` | `GET /admin/macros` |
| `macro_run` | **`cwd`**, **`id`**, `inputs` (string map), `effort`, `externalRef` | `POST /admin/macros/run` (§2 B) |
| `epic_get` | **`cwd`**, exactly one of `id` / `externalRef`, `receipt` | `GET /admin/epic` (§3) |
| `events_read` | `after`, `kinds` (`epic_state_changed`, `epic_cross_project_reply`), `limit` (1-500) | `GET /admin/events` (§4) |
| `project_create` | **`name`**, **`externalRef`**, `github`, `parentDir` | `POST /admin/projects/create` |

The schema says `fromCwd` is required for `feedback_open_session`, but a service may leave it out (see the
scope table). A tool result is MCP `content: [{ type: 'text', text: <route JSON> }]`, with `isError: true`
when the route answered outside 2xx.

### project_create

Creates a new local project for the service, and optionally a private GitHub repo for it, so the service
can open its first session there. The owner grants it by ticking **Create projects** at pairing; it is off
unless ticked, and the dialog then asks for the projects folder. Logic:
[`projectCreate.cjs`](../../src/main/lib/feedback-remote/projectCreate.cjs).

**Arguments**

| Argument | Meaning |
| --- | --- |
| **`name`** | The folder name: 1 to 100 letters, digits or `. _ -`, starting with a letter or digit, not ending in `.git`. It is used as given (no trimming). The project becomes `<projects folder>/<name>`. |
| **`externalRef`** | Your own id for this project, with the [`externalRef` rules](#externalref-rules-srcmainlibepicexternalrefcjs). Required. |
| `github` | Leave out (or `false`) for no repo. `true` or `{ private: true }` creates a private repo. `{ owner }` is allowed only when it names the account `gh` is signed in as (case-insensitive). `{ private: false }` is refused: only private repos are created. |
| `parentDir` | Optional. Only the approved projects folder is accepted (see the scope table); leave it out to use that folder. |

**What a create does.** It makes the folder (never its parents), runs `git init` on `main`, makes one empty
commit (so Epic worktrees can fork), creates the bare `session-manager-operations/` root (so
`feedback_open_session` accepts the folder as `toCwd`) and records the project in a ledger. With `github`,
it then runs `gh repo create <owner>/<name> --private --source=<cwd> --remote=origin --push`. `<owner>` is
always the account `gh` is signed in as. Creates run one at a time.

**The answer** (200):

```json
{
  "ok": true,
  "status": "created",
  "cwd": "/home/me/Projects/<name>",
  "name": "<name>",
  "externalRef": "kiln:idea-42",
  "repo": { "fullName": "<owner>/<name>", "url": "https://github.com/<owner>/<name>", "private": true }
}
```

| Field | Meaning |
| --- | --- |
| `status` | `created` for a new project, `existing` for a repeat. |
| `existing` | `true`, only when `status` is `existing`. |
| `cwd` | The absolute project folder. Use it as `toCwd`. |
| `name` | The folder name (for a repeat, the recorded folder's name). |
| `externalRef` | Your id, normalized. |
| `repo` | `{ fullName, url, private: true }`, or `null` when no GitHub repo is set as `origin`. |
| `github` | Present only when the GitHub step failed: `{ ok: false, error }`. |

**Idempotency.** A project is keyed by the service's home project plus `externalRef`. A repeat call with
the same key creates nothing and answers `status: 'existing'` with the recorded `cwd`, whatever `name` it
sends. Its `repo` is read from the folder's `origin`. A repeat with `github` on a project that has no
`origin` yet runs the GitHub step again, so a failed repo can be retried.

**GitHub failure.** A failed `gh repo create` (or an `origin` that is not a GitHub remote afterwards) keeps
the local project. The answer is still 200 with `ok: true`, `repo: null` and
`github: { ok: false, error }`. Retry with the same `externalRef` to try GitHub again.

**Refusals.** Every refusal is `{ ok: false, status, code, error }` with the HTTP status below, checked in
this order. Nothing is created on a refusal: all input checks (including `gh`) run before any disk write,
and a failure after the folder is made removes it again.

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid-ref` | `externalRef` is missing or breaks its rules, or `fromCwd` is not an absolute path. |
| 400 | `invalid-parent` | `parentDir` is not an absolute path, is outside the allowed roots, does not exist or is not a folder. |
| 400 | `invalid-name` | `name` breaks the rules above. |
| 400 | `invalid-github` | `github` is not `true`, `false` or an object; `private` is `false` or not a boolean `true`; `owner` is empty or not a string. |
| 400 | `gh-unavailable` | `github` was asked for, but `gh` is missing, not signed in, or returned no login. |
| 403 | `gh-owner` | `github.owner` is not the account `gh` is signed in as. |
| 409 | `gone` | A repeat, but the recorded folder no longer exists. |
| 409 | `exists` | A folder with that name is already in the projects folder (and it is not this `externalRef`'s project). |
| 500 | `io` | The folder, `git init`, the empty commit, the operations root or the ledger write failed. The folder is removed. A missing git identity adds a hint to set `user.name` / `user.email`. |

A body that is not JSON is answered 400 `{ ok: false, error: 'invalid JSON body' }`. The two scope
refusals (`refused:projectRoot`, `refused:parentDir`) are 403 `{ ok: false, error }` from the desktop
before the route runs.

**After a create.** A fresh create opens the folder as a dormant tab in the app, and
`feedback_list_projects` lists it at once. The usual flow:

1. `project_create` `{ name, externalRef, github: { private: true } }` → `cwd`.
2. `feedback_open_session` with `toCwd` = that `cwd`, `tag: 'feature'` and an `externalRef` of your own for
   the session (§2 A).
3. Follow it with `epic_get` (`cwd`, `externalRef`) and `events_read` (§3, §4).

### The Node bridge: `service pair` and `service mcp`

[`serviceStdioBridge.cjs`](../../src/main/lib/feedback-remote/serviceStdioBridge.cjs), routed from `bin/cli.cjs` before any
Electron code loads:

```sh
npx claude-code-session-manager service pair --code <code> --name <name> --state-dir <dir> [--device <prefix>] [--timeout <seconds>]
npx claude-code-session-manager service mcp --state-dir <dir>
```

| Flag | Meaning |
| --- | --- |
| `--code` | The one-time code from the pairing dialog. |
| `--name` | The name the desktop shows for this service. |
| `--state-dir` | Where the service keeps `service-client.json` (its token, identity key and desktop id, mode 0600). Use the same dir for `pair` and `mcp`. |
| `--device` | A 6+ character prefix of the desktop's device id. Needed only when the account has several desktops; with one desktop it is picked for you. |
| `--timeout` | Seconds `pair` waits for the owner to confirm the SAS (default 300). |

- `pair` prints `SAS: <digits>` and where to confirm it, then exits 0 once the desktop confirms. A bad or
  expired code, an ambiguous `--device`, revocation or timeout exit 1. Bad flags exit 2.
- `mcp` is a stdio MCP server: newline-delimited JSON-RPC 2.0 on stdin/stdout. Stdout carries protocol
  messages only; logs go to stderr. It reconnects by itself (1-60 s jittered backoff). Closing stdin exits 0.

Driving it from Python:

```python
import json, subprocess

p = subprocess.Popen(
    ["npx", "claude-code-session-manager", "service", "mcp", "--state-dir", "/var/lib/kiln/sm"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
)

def call(id, method, params=None):
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": id, "method": method, "params": params or {}}) + "\n")
    p.stdin.flush()
    reply = json.loads(p.stdout.readline())
    if "error" in reply:
        raise RuntimeError(reply["error"]["message"])  # "revoked: pair again" -> process exits 3
    return reply["result"]

call(1, "initialize", {"protocolVersion": "2025-06-18"})
print(call(2, "tools/list"))
print(call(3, "tools/call", {"name": "epic_get", "arguments": {"cwd": "/home/me/proj", "externalRef": "kiln:42"}}))
p.stdin.close(); p.wait()
```

A service that would rather speak the protocol itself can follow the reference client
[`reference/sm_service_client.py`](reference/sm_service_client.py) (standard library + `cryptography`; no reconnect).
The Node client it mirrors is [`serviceClient.cjs`](../../src/main/lib/feedback-remote/serviceClient.cjs).

### Revoke and the kill switch

- **Revoke** (App Settings → Web remote → Services) deletes the service's pin and its relay client. The
  relay closes its socket with code `4001`; the next call is refused even if the socket is still open. A
  revoked client stops reconnecting: `service mcp` prints `revoked: pair again` and **exits 3**. A 401 from
  `client-ticket` or `client/devices` means the same. Pair again for a new token.
- **Kill switch** (turning Web remote off, or revoke-all) refuses every service call with an opaque
  `rejected` within one second; revoke-all also drops every connection.

### Relay routes

Base `https://bilko.run/api/sm-relay`; socket `wss://bilko.run/projects/session-manager/relay`.

| Route | Who calls it | Auth | Limit |
| --- | --- | --- | --- |
| `POST client-otp` | the desktop, to mint a pairing code | desktop device token or Clerk session | code is 8 chars, single-use, lives 5 minutes; 10 codes an hour per account, shared with device codes |
| `POST client-pair` `{ code, clientName }` → `{ clientToken, clientId }` | the service, once | the code | 10 an hour per IP |
| `POST client-ticket` → `{ ticket }` | the service, before each connect (ticket is one-time, 30 s) | client token | 10 a minute per token |
| `GET client/devices` | the service, at pairing | client token | 10 a minute per token |
| `GET clients` / `DELETE clients/<clientId>` | the desktop, to list and revoke services | desktop device token or Clerk session | — |

A service connection counts toward the 5 browser connections an account may hold at once. A `DELETE`
closes that client's socket with `4001`.

### What does not change

- `relay_unsupported` appears only when the relay is a build without these routes. Update the relay; there
  is nothing to fix in the app.
- Any account the relay allows can pair services. There is no owner-only check.
- The loopback admin API in sections 1-8 is unchanged. Paired services are an extra way in, not a new
  version of it.

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
