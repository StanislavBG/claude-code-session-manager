# Tasks — the admin contract for outside callers

This is the reference for scripts that run Tasks through Session Manager. Burrow is the first such caller.
A Task is one headless `claude -p` run for a project. The domain rules are in
[domain-model.md → Tasks](domain-model.md#tasks), and the store layout is in [`../tasks/README.md`](../tasks/README.md).
Everything below was read from the landed code, not written from memory:

- `src/main/lib/tasks/taskAdminRoutes.cjs`: routes, schemas and error codes.
- `src/main/lib/tasks/taskRun.cjs`: `buildTaskArgs`, `buildTaskEnv`, `runTask` and `textStdoutFor`.
- `src/main/lib/tasks/taskLedger.cjs`: storage, folded status and list paging.
- `scripts/scheduler-mcp-server.cjs`: the `task_list` and `task_get` MCP tools.

If this page and the code disagree, the code wins. Fix this page.

## Reaching the API

Discovery and auth work the same way as every other admin route. Read `port` and `token` from
`~/.claude/session-manager/admin-api.json` and send `Authorization: Bearer <token>`. The details are in
[external-contract.md](external-contract.md). The server binds to loopback only. The token changes at every
app boot, so read the file again after a connection error or a `401`.

## The human switch

To run or import a Task, a human must turn on **'Scripts may run Tasks'** for the project. The switch is the
Scheduler → Tasks pill, and `lib/tasks/taskSwitch.cjs` reads it. It has exactly two writers: the human's click
(`tasks:set-switch` IPC), and an agent in a human's chat session carrying the human's verified words through
[`POST /admin/tasks/switch`](#post-admintasksswitch--set-the-switch-on-the-humans-words) (MCP `task_switch_set`).
A script, a scheduled job or a Task cannot change it. Why: [domain-model.md#tasks](domain-model.md#tasks).

While the switch is off, `POST /admin/tasks` and `POST /admin/tasks/import` answer `403 tasks_disabled` with
this `hint` (`SWITCH_HINT` in `lib/tasks/taskAdminRoutes.cjs`), word for word:

> Turn on 'Scripts may run Tasks' for this project: a human flips it on the Scheduler → Tasks page, or an agent in a Session Manager chat calls task_switch_set with the human's own words asking for it.

The two read routes work whether the switch is on or off. Before the switch check, both write routes re-sync
the held interactive slot from the switch file (`taskSwitch.syncInteractiveReserve`; a failure is ignored), so
a switch file changed outside the IPC still moves the held slot at the next Task call.

### Who changed it: `by`

Each project entry in the machine-level `task-switches.json` (`schedulerPaths.taskSwitchesPath()`) is
`{ enabled, changedAt, by }`. `by` records the last writer:

| `by` | Writer |
| --- | --- |
| `{ via: 'ui' }` | A human click on the Scheduler → Tasks pill |
| `{ via: 'agent', claudeSessionId, quote, promptAt }` | `POST /admin/tasks/switch`; `promptAt` is when the human typed the quoted prompt |
| `{ via: 'unknown' }` | Read for an entry with no well-formed `by` (written before attribution, by a direct module call or by hand). Reads never rewrite the file; the Tasks page shows "Changed outside Session Manager". |

### The one outside write so far (2026-11-23)

Burrow's entry, `changedAt` `2026-11-23T19:04:59.848Z`, was written by a direct `setTaskSwitch` call from
Burrow's architect on the owner's instruction, before the agent path existed. The owner authorized it, so it
is **kept**. It reads as `by: { via: 'unknown' }` until the switch is set again. Because it bypassed both
writers, it left no `task_switch_changed` audit event, and the running app's held interactive slot stayed
unsynced until the app restarted (the Task routes now re-sync it on every call, see above).

## `POST /admin/tasks/switch` — set the switch on the human's words

The route behind the MCP tool `task_switch_set({ enabled, humanRequestQuote, cwd? })`
(`lib/tasks/taskSwitchRoute.cjs`). The tool fills `originClaudeSessionId` from `SM_CHAT_SESSION_ID` and
`originProjectRoot` from `SM_PROJECT_ROOT`, never from the caller's arguments, and refuses outright in a
scheduled job or a Task.

Body (strict, at most **64 KiB**):

```json
{
  "enabled": true,
  "humanRequestQuote": "turn on Scripts may run Tasks for this project",
  "originClaudeSessionId": "<the chat session's claudeSessionId>",
  "cwd": "/abs/project/root",
  "originProjectRoot": "/abs/project/root"
}
```

| Field | Rule |
| --- | --- |
| `enabled` | boolean, required |
| `humanRequestQuote` | 1–2000 chars, required; verbatim from a prompt the human typed in that session |
| `originClaudeSessionId` | 1–128 chars, required |
| `cwd` | optional; must be a project root. Absent = the calling session's own project |
| `originProjectRoot` | optional hint for resolving the calling session's project |

Checks run in order; every refusal writes and audits nothing. On success the route writes the switch with
`by: { via: 'agent', claudeSessionId, quote, promptAt }`, appends one `task_switch_changed` audit event,
re-syncs the held interactive slot, and answers `200`:

```json
{
  "ok": true,
  "cwd": "/abs/project/root",
  "enabled": true,
  "changedAt": "2026-11-23T20:00:00.000Z",
  "by": { "via": "agent", "claudeSessionId": "…", "quote": "…", "promptAt": "…" },
  "previous": { "enabled": false, "by": { "via": "ui" } }
}
```

`previous.by` is `null` when the project had no entry. Setting the value the switch already has still
re-stamps `changedAt` and `by`.

Errors (`{ ok: false, error, reason }`; `400` carries `details` instead of `reason`):

| HTTP | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Body unreadable or over 64 KiB, invalid JSON, schema failure, `cwd` not a project root, or no target (no `cwd` and the calling session's project cannot be resolved) |
| 403 | `human_request_unverified` | The quote is not in a prompt the human typed in `originClaudeSessionId` (`humanPromptLedger` is the only proof) |
| 403 | `quote_does_not_name_switch` | The quote does not say 'Scripts may run Tasks' (case, quote-mark and hyphen variants allowed) |
| 403 | `quote_does_not_name_project` | The target is not the calling session's project and the quote does not name it |
| 409 | `request_older_than_switch` | The quoted prompt is not newer than the switch's last change: one instruction authorizes one write and never undoes a later click. Ask the human again. |
| 500 | `switch_write_failed` | Writing the switch file threw (`details`) |

## `POST /admin/tasks` — run one Task

This call runs one `claude -p` under the machine-wide slot cap and records it in the project's Task ledger.
**The call stays open until the run ends.** The route turns off the socket timeout. If the caller closes the
connection before the reply, the slot wait or the running child is aborted, and the Task ends `caller_gone`.

The body is JSON, at most **4 MiB**. The schema is strict: an unknown key at any level gives
`400 invalid_request`.

| Field | Type | Default | Limits / meaning |
| --- | --- | --- | --- |
| `cwd` | string | — (required) | Any path inside the project. It is resolved to the project root (`resolveProjectRoot`). |
| `agent` | string | — (required) | 1–200 chars. The persona name. Its `model` and `effort` are used; its **body is never read** into the prompt or argv. |
| `missionId` | string | — (required) | 1–200 chars. The caller's label, stored in the ledger. |
| `prompt` | string | — (required) | Non-empty. Sent on **stdin**, never in argv, and passed unchanged. |
| `timeoutSec` | int | `600` | 1–3600. Run wall clock. When it passes, the process tree is SIGKILLed and the status is `timeout`. |
| `slotWaitSec` | int | `120` | 0–3600. How long to wait for a slot. When it passes, the status is `slot_timeout`. |
| `priority` | `'interactive'` \| `'batch'` | `'batch'` | Slot lane `task-interactive` / `task-batch`. Interactive waiters are served first. |
| `caller` | object | `{}` | Strict. `pipeline`, `runId`, `step` (strings ≤ 200) and `attempt` (int ≥ 0). Stored, and filterable in `GET /admin/tasks`. |
| `runtime` | object | `{ outputFormat: 'json' }` | Strict. See the next table. |

`runtime` fields (all optional):

| Field | Type | Meaning |
| --- | --- | --- |
| `outputFormat` | `'json'` \| `'text'` \| `'stream-json'` | Default `'json'`. The `text` format still runs the CLI with `--output-format json` (see [text output](#text-output)). |
| `settingSources` | string | `--setting-sources <value>`. |
| `mcpConfig` | string[] (each non-empty) | Each path is resolved against the **project cwd** (relative paths included). A missing file gives `400 mcp_config_missing` with `details` = the missing absolute paths. |
| `strictMcpConfig` | boolean | `true` → `--strict-mcp-config`. |
| `allowedTools` | string[] | `--allowedTools a,b`. An **empty array** is valid and denies all tools (see [argv](#the-argv-a-task-runs-with)). |
| `tools` | string[] | `--tools a,b`. The empty-array rule is the same. |
| `maxTurns` | int | 1–200 → `--max-turns`. |
| `systemPrompt` | string | ≤ 100 KiB (UTF-8) → `--system-prompt`, which **replaces** the system prompt. It never uses `--append-system-prompt`. |
| `skipPermissions` | boolean | `true` → `--dangerously-skip-permissions` plus whatever headless permission args the CLI-caps probe adds. |
| `disableAutoMemory` | boolean | `true` → the child gets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (see [environment](#environment)). |
| `sessionId` | uuid | `--session-id <uuid>`. You cannot send it together with `resume`. |
| `resume` | uuid | `--resume <uuid>`. It always persists the session, so `persistSession: false` with it is a `400`. |
| `persistSession` | boolean | `true` keeps the transcript. Without `sessionId` or `resume`, the route uses the new `taskId` as the session id. |
| `cwd` | string | The child's working directory. It must be an absolute directory that exists. The default is the project root. The ledger, the `mcpConfig` paths and persona resolution still use the project root. |

### The order of checks

1. Parse the body and check it against the schema: `400 invalid_request`. Then the cwd → project root check,
   `sessionId`+`resume`, and `resume`+`persistSession:false`, which also give `400 invalid_request`. Then the
   `mcpConfig` files: `400 mcp_config_missing`.
2. The switch: `403 tasks_disabled`.
3. Resolve the persona with the spawn-time resolvers (`agentModelResolve.cjs` / `agentEffortResolve.cjs`).
   - If the persona is not found: `404 unknown_agent`.
   - The model is the persona's model, or the Settings model if the persona has none or says `inherit`. If
     neither gives a concrete model: `422 model_unresolved`. There is no fallback model.
   - If no effort resolves: `422 effort_unresolved`.
4. Another running Task already holds this session id: `409 session_busy` (`heldBy` = that taskId).
5. The `start` line is written to the ledger. Then the route waits for a slot.
6. The run, then the `end` line, which carries `costUsd` priced by `modelPricing.costOfUsage`.

A `400 invalid_request` or `403` gets no ledger line. Once step 5 begins, every outcome gets an end line.

### Success response — `200`

`200` means the run happened. **Check `status`.** A run that failed or was rate-limited still answers `200`
with `ok: true`.

```http
POST /admin/tasks
Authorization: Bearer <token>
Content-Type: application/json

{
  "cwd": "/home/me/Projects/Burrow",
  "agent": "claude",
  "missionId": "daily-digest",
  "prompt": "Summarize yesterday's notes in 5 bullets.",
  "priority": "batch",
  "caller": { "pipeline": "digest", "runId": "2026-11-22", "step": "summarize", "attempt": 0 },
  "runtime": { "outputFormat": "text", "allowedTools": [], "disableAutoMemory": true }
}
```

```json
{
  "ok": true,
  "taskId": "6d1c2f8e-3b0a-4f7e-9d52-1a2b3c4d5e6f",
  "status": "ok",
  "stdout": "- note one\n- note two\n- note three\n- note four\n- note five\n",
  "envelope": { "type": "result", "is_error": false, "result": "- note one\n…", "session_id": "…", "num_turns": 1, "total_cost_usd": 0.0123, "usage": { "input_tokens": 1200, "output_tokens": 80 } },
  "usage": { "input_tokens": 1200, "output_tokens": 80, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 },
  "costUsd": 0.0118,
  "cliCostUsd": 0.0123,
  "durationMs": 9312,
  "slotWaitMs": 4,
  "exitCode": 0,
  "model": "claude-opus-4-1",
  "effort": "medium",
  "sessionId": null,
  "quota": { "rateLimited": false, "resetsAt": null }
}
```

| Field | Meaning |
| --- | --- |
| `taskId` | A new UUID. Use it as the key for `GET /admin/task`. |
| `status` | `ok`, `error`, `timeout`, `rate_limited`, `caller_gone` or `spawn_failed` (see [statuses](#task-statuses)). |
| `stdout` | The CLI's stdout, capped at 8 MiB. For `outputFormat: 'text'` it is `envelope.result + "\n"` instead. |
| `envelope` | The parsed JSON result object. For stream-json it is the last `type: "result"` line. It is `null` if nothing parsed. |
| `usage` | `envelope.usage`, or `null`. |
| `costUsd` | Session Manager's price: `costOfUsage` on the first model in `envelope.modelUsage`, else on the model it passed. It is `null` without usage. |
| `cliCostUsd` | The CLI's own `total_cost_usd`, or `null`. |
| `durationMs` / `slotWaitMs` | Run time and slot-wait time. |
| `exitCode` | The child's exit code, or `null`. |
| `model` / `effort` | What was passed as `--model` / `--effort`. |
| `sessionId` | The session id given (`sessionId`, `resume`, or the taskId under `persistSession`), else the envelope's `session_id`, else `null`. |
| `quota` | `{ rateLimited, resetsAt }`. `resetsAt` (ISO) comes from the last rejected `rate_limit_event` line in the output. |

### Non-200 responses

Every error body is `{ ok: false, error, ... }`.

| HTTP | `error` | When | Extra fields |
| --- | --- | --- | --- |
| 400 | `invalid_request` | Body unreadable or over 4 MiB, invalid JSON, schema failure, cwd not in a project, `sessionId`+`resume`, `resume`+`persistSession:false` | `details` (zod issues or a message) |
| 400 | `mcp_config_missing` | A `runtime.mcpConfig` file does not exist | `details`: string[] of absolute paths |
| 400 | `argv_too_large` | One argv element is over 100 KiB (`buildTaskArgs`) | `details` |
| 403 | `tasks_disabled` | The switch is off for this project | `hint` |
| 404 | `unknown_agent` | No persona with that name | `agent` |
| 409 | `session_busy` | Another running Task holds the session id | `sessionId`, `heldBy` |
| 422 | `model_unresolved` | No concrete model from the persona or Settings | `agent` |
| 422 | `effort_unresolved` | No effort resolves for the persona | `agent` |
| 429 | `too_many_waiting` | More than 50 Tasks are already waiting for a slot | `taskId` |
| 503 | `slot_timeout` | No slot came within `slotWaitSec` | `taskId`, `slotWaitMs` |
| 503 | `caller_gone` | The caller disconnected during the slot wait (the reply is rarely seen) | `taskId`, `slotWaitMs` |
| 500 | another slot error code (e.g. `slot_error`) | `waitForSlot` threw something else | `taskId` |

Back off on `429` and `503 slot_timeout` and retry. Do **not** fall back to a direct call; see
[the fallback rule](#fallback-rule-direct-claude--p-then-import).

## Task statuses

Statuses are stored on the `end` (or `imported`) line. `GET` routes return them folded per taskId.

| Status | Meaning |
| --- | --- |
| `ok` | Exit 0, no `is_error` in the envelope, no rate limit, no signal. |
| `error` | Non-zero exit, `envelope.is_error === true`, or the child died from a signal. |
| `timeout` | `timeoutSec` passed; the process tree was SIGKILLed. |
| `slot_timeout` | No slot came within `slotWaitSec`; the run never started. |
| `rate_limited` | The output or envelope shows a rate limit (`rateLimitDetect.cjs`). See `quota.resetsAt`. |
| `caller_gone` | The HTTP caller disconnected during the wait or the run; the child was killed. |
| `spawn_failed` | The `claude` binary could not be spawned (ENOENT, EACCES, …); the reason is in `stderrTail`. |
| `interrupted` | Read-time only. A start line with no end line, whose `startedAt + timeoutSec + 120 s` has passed (for example, the app quit mid-run). |
| `running` | Read-time only. A start line with no end line that is still inside that window. |

`too_many_waiting` can also be stored as an end status (the 429 case). An import may carry it too.

## The argv a Task runs with

`buildTaskArgs({ model, effort, runtime, projectCwd })` builds the flags in this order. The prompt is never in
argv.

```
-p --model <model> --effort <effort>
[--session-id <uuid>]                       # runtime.sessionId (or the taskId when persistSession:true with neither)
[--resume <uuid>]                           # runtime.resume
[--no-session-persistence]                  # unless persistSession === true or resume is set
[--setting-sources <s>]
[--strict-mcp-config]
[--max-turns <n>]
[--system-prompt <text>]                    # replaces the system prompt
[--dangerously-skip-permissions <headless permission args>]
[--mcp-config <abs path>...]                # each path.resolve(projectCwd, p)
[--allowedTools <a,b>]                      # present whenever the array is given
[--tools <a,b>]
--output-format json | --output-format stream-json --verbose
```

- **Sessions.** `sessionId` gives `--session-id` and `resume` gives `--resume`. `--no-session-persistence` is
  added unless `persistSession: true` or `resume` is set, so by default nothing is kept on disk. A persisted
  Task is written to the ledger with `persisted: true`. History (`historyAggregator.cjs`, through
  `taskLedger.listPersistedSessionIds`) skips that session's transcript, so its cost is counted once, from the
  ledger. The start line is written before the spawn, so the id is known before the transcript exists.
- **Tool lists.** If `allowedTools` / `tools` is **absent**, the flag is not sent and the CLI default applies. If
  it is an **empty array**, the flag is sent with an empty value (`--allowedTools ""`), which denies all tools.
  These variadic flags come after `--mcp-config` and before `--output-format`, so the next flag always ends
  their list.
- **MCP config.** Relative `mcpConfig` paths are resolved against the **project cwd**, even when `runtime.cwd`
  points somewhere else.
- **System prompt.** `systemPrompt` becomes `--system-prompt`, which **replaces** the system prompt. No persona
  body is ever added.
- **Output.** `stream-json` adds `--verbose`, which the CLI needs for that format. `json` and `text` both run
  `--output-format json`.
- **Size.** Any argv element over 100 KiB throws `argv_too_large`, and the route answers `400`.

## Environment

- The child gets **Session Manager's own environment** (`process.env`) plus Task markers only: `SM_KG_INTERNAL=1`
  and the process-role marker (`withProcRole`, role `aux`). **No caller environment variable is ever passed
  through.** The request has no `env` field, and the strict schema rejects one.
- The one caller-controlled exception: `runtime.disableAutoMemory: true` sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- The child runs inside a memory scope (systemd-run) where the system supports one. That scope does not change
  argv or env.

## Text output

For `outputFormat: 'text'`, the CLI still runs with `--output-format json`, so usage and cost are always
captured. The reply's `stdout` is `envelope.result` plus a trailing newline (`textStdoutFor`). With no
envelope, it is just `"\n"`. The ledger still stores the raw JSON stdout as the Task's `output`.

## `GET /admin/tasks` — list Tasks

Query string. All values are strings and the schema is strict (an unknown parameter gives `400`). This route
works whether the switch is on or off.

| Param | Meaning |
| --- | --- |
| `cwd` | Required. Must **be** a project root, not a path inside one (otherwise `400 invalid_request`). |
| `since` / `until` | ISO timestamps; `startedAt` within them, inclusive. |
| `pipeline` / `runId` / `step` | An exact match on `caller.*` (≤ 200 chars). |
| `agent` / `status` | An exact match. `status` may be `running` or `interrupted`. |
| `source` | `sm` (run through the route) or `direct` (imported). |
| `limit` | 1–200, default 50. |
| `offset` | ≥ 0, default 0. |

The list is newest first by `startedAt`.

```http
GET /admin/tasks?cwd=%2Fhome%2Fme%2FProjects%2FBurrow&pipeline=digest&limit=1
```

```json
{
  "ok": true,
  "tasks": [{
    "taskId": "6d1c2f8e-…", "source": "sm", "importId": null, "importedAt": null,
    "agent": "claude", "missionId": "daily-digest", "model": "claude-opus-4-1", "effort": "medium",
    "priority": "batch", "caller": { "pipeline": "digest", "runId": "2026-11-22", "step": "summarize", "attempt": 0 },
    "outputFormat": "text", "timeoutSec": 600, "slotWaitSec": 120, "sessionId": null, "persisted": false,
    "startedAt": "2026-11-22T17:02:11.000Z", "endedAt": "2026-11-22T17:02:20.316Z", "status": "ok",
    "exitCode": 0, "signal": null, "durationMs": 9312, "slotWaitMs": 4,
    "usage": { "input_tokens": 1200, "output_tokens": 80 }, "costUsd": 0.0118, "cliCostUsd": 0.0123,
    "numTurns": 1, "quota": { "rateLimited": false, "resetsAt": null },
    "promptBytes": 41, "promptSha256": "…", "outputBytes": 512, "outputSha256": "…"
  }],
  "total": 14,
  "hasMore": true
}
```

Each task has exactly the `TASK_FIELDS` keys shown. A missing value is `null`, `caller` defaults to `{}`, and
`source` defaults to `sm`. No prompt or output text is included, only byte counts and SHA-256 hashes.

Errors: `400 invalid_request` (`details`) and `500 ledger_read_failed`.

## `GET /admin/task` — one Task with its text

Query: `cwd` (must be a project root) and `id` (the taskId, ≤ 200 chars).

```http
GET /admin/task?cwd=%2Fhome%2Fme%2FProjects%2FBurrow&id=6d1c2f8e-3b0a-4f7e-9d52-1a2b3c4d5e6f
```

```json
{
  "ok": true,
  "task": {
    "taskId": "6d1c2f8e-…", "status": "ok", "…": "every TASK_FIELDS key, as in the list",
    "prompt": "Summarize yesterday's notes in 5 bullets.",
    "promptTruncated": false,
    "output": "{\"type\":\"result\",…}",
    "outputTruncated": false,
    "stderrTail": "",
    "envelope": { "type": "result", "result": "- note one\n…" }
  }
}
```

The text comes from `tasks/bodies/<taskId>.json`. `prompt` and `output` are each capped at **1 MiB**, and the
`*Truncated` flags say when the cap cut them. The byte counts and hashes in the summary are of the full text.
`stderrTail` is the last 16 KiB of stderr. If the body file has been pruned, the text fields are `null`.

Errors: `400 invalid_request`, `404 unknown_task` (`id`) and `500 ledger_read_failed`.

## `POST /admin/tasks/import` — record direct runs

This route records `claude -p` calls that a caller made **without** Session Manager (see the fallback rule).
The body is at most **8 MiB**: `{ cwd, records }`. `cwd` must be a project root, and `records` holds 1–100
entries. It answers `403 tasks_disabled` while the switch is off. Imports for one project run one at a time.

Each record is checked on its own (a strict schema), and one bad record does not stop the others:

| Field | Required | Limits / meaning |
| --- | --- | --- |
| `importId` | yes | 1–200 chars. Your idempotency key. A `(cwd, importId)` that was already imported is skipped and counted in `alreadyImported`. |
| `model` | yes | 1–200 chars. |
| `missionId` | yes | 1–200 chars. |
| `startedAt` | yes | ISO date. |
| `durationMs` | yes | int ≥ 0. `endedAt` = `startedAt + durationMs`. |
| `status` | yes | One of `ok`, `error`, `rate_limited`, `timeout`, `spawn_failed`, `caller_gone`, `slot_timeout`, `too_many_waiting`, `interrupted`. |
| `agent`, `effort` | no | ≤ 200 / ≤ 50 chars. |
| `caller` | no | Same shape as the run route. |
| `exitCode` | no | int or `null`. |
| `usage` | no | `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` (ints ≥ 0). Other keys pass through. |
| `costUsd` | no | ≥ 0 or `null`. With `usage`, Session Manager prices it again with `costOfUsage` and keeps your figure as `cliCostUsd`. |
| `sessionId` | no | uuid. **Required** when `persisted: true`. |
| `persisted` | no | `true` = the run kept its transcript (History then skips it, as for run Tasks). |
| `prompt`, `output`, `envelope` | no | Stored in the body file (1 MiB caps). |

Imported Tasks get a new `taskId` and `source: 'direct'`.

```http
POST /admin/tasks/import
Content-Type: application/json

{
  "cwd": "/home/me/Projects/Burrow",
  "records": [{
    "importId": "burrow-digest-2026-11-22-summarize-0",
    "model": "claude-opus-4-1", "effort": "medium", "agent": "claude", "missionId": "daily-digest",
    "caller": { "pipeline": "digest", "runId": "2026-11-22", "step": "summarize", "attempt": 0 },
    "startedAt": "2026-11-22T17:02:11.000Z", "durationMs": 9312, "status": "ok", "exitCode": 0,
    "usage": { "input_tokens": 1200, "output_tokens": 80 }, "costUsd": 0.0123,
    "prompt": "Summarize yesterday's notes in 5 bullets.", "output": "{\"type\":\"result\",…}"
  }]
}
```

```json
{ "ok": true, "imported": 1, "alreadyImported": 0, "rejected": [] }
```

`rejected` is `[{ index, error }]`, where `error` is the first schema issue as `"<path>: <message>"` or a write
error. Route errors: `400 invalid_request`, `403 tasks_disabled` and `500 import_failed`.

## Fallback rule: direct `claude -p`, then import

**Run `claude -p` directly only when the admin API is unreachable.** That means `admin-api.json` is missing, or
there is still a connection error after you read the file again. Never fall back because of a `4xx`/`5xx`
answer. A `403`, `404`, `422`, `429` or `503` is Session Manager's decision, and going around it skips the
slot cap and the human switch.

When you do run directly:

1. Pin `--model` (and `--effort`) yourself, with the same flags as [the argv](#the-argv-a-task-runs-with).
2. Keep a record of each call: a stable `importId`, timings, status, usage and the text.
3. When the API answers again, `POST /admin/tasks/import` the records. They are deduplicated on `importId`, so
   retrying is safe.

## MCP tools: `task_list`, `task_get`

These tools are in `scripts/scheduler-mcp-server.cjs`. Each one is a thin wrapper over the GET routes, with
the same parameters and the same responses:

- `task_list({ cwd, since?, until?, pipeline?, runId?, step?, agent?, status?, source?, limit?, offset? })` →
  `GET /admin/tasks`. If `hasMore` is true, it adds a `note`: `partial list: returned N of TOTAL Tasks — pass a
  higher offset to see more`.
- `task_get({ cwd, id })` → `GET /admin/task`. If `id` is missing, the tool errors before it calls the route.

There is no MCP tool to run or import a Task. Those are HTTP-only, for scripts.
