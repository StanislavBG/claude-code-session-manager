# Error logs — session-manager

Structured, per-project error log. Every error that happens anywhere in the app for THIS
project's tabs — a broken terminal spawn, a failed headless chat run, a search/file-write
failure — gets appended here as one JSON line, tagged so it can be traced and filtered later.
This is separate from the machine-global `~/.claude/session-manager/logs/session-manager-*.log`
mirror (every level, every project mixed together, plain text) — this folder is errors only,
scoped to one project, and structured for analysis.

## Storage

```
session-manager-operations/logs/errors-<yyyy-mm-dd>.jsonl   e.g. errors-2026-07-31.jsonl
```

One file per calendar day (local time), newline-delimited JSON, append-only. Nothing rewrites
or rotates these files today — pruning old days (if ever needed) is a future concern, not
handled by the writer.

## Line shape

Each line is one JSON object:

```json
{
  "ts": "2026-07-31T18:42:03.112Z",
  "level": "error",
  "scope": "pty",
  "tabId": "b3f1c2a0-...-e91a",
  "epicId": null,
  "tags": ["level:error", "scope:pty", "tab:b3f1c2a0-...-e91a", "spawn-failed"],
  "message": "pty.spawn threw: spawn xterm-256color ENOENT",
  "meta": { "cwd": "/home/user/Projects/some-project" }
}
```

- `ts` — ISO-8601 UTC timestamp.
- `level` — `error` or `warn` (warn is accepted but this folder is intended primarily for errors).
- `scope` — subsystem name the error came from (`pty`, `chatRunner`, `global-search`,
  `quick-open`, etc.) — matches the `scope` argument every call site already passes to the
  renderer `log.*` / main `opsErrorLog.appendError` helpers.
- `tabId` — the claudeSessionId of the tab this error belongs to, or `null` if the error has no
  single owning tab (e.g. a boot-time failure).
- `epicId` — set when the error happened inside an Epic-backed run, else `null`.
- `tags` — always includes `level:<level>` and `scope:<scope>`, plus `tab:<tabId>` when a tab is
  known; callers can add free-form extra tags (e.g. `spawn-failed`, `immediate-exit`,
  `silent-probe`) to narrow tracing/analysis queries without needing a fixed enum.
- `message` — human-readable, one line.
- `meta` — optional extra structured context. Redacted before write: any key matching
  `transcript|interim|final|text|content|partial|userText|message|token|secret|password|
  authorization|cookie|api_key|access_token|refresh_token` (case-insensitive) is replaced with
  `"[redacted]"` — see `sanitizeMeta` in `src/main/lib/opsErrorLog.cjs`.

## Ownership

Sole writer: `logs` (single-writer law, `src/main/lib/opsOwnership.cjs`). The only code path
that writes this folder is `src/main/lib/opsErrorLog.cjs`'s `appendError()` — called directly
from main-process modules that already know a tab's `cwd` (`pty.cjs`, `chatRunner.cjs`), and
indirectly from the renderer via the `log:write` IPC channel (`src/main/logs.cjs`) when a
renderer `log.error(scope, msg, meta, { cwd, tabId, ... })` call supplies a `cwd`. A renderer
error with no `cwd` in its call site only reaches the machine-global mirror, not this folder —
enriching more call sites with `{ cwd, tabId }` is an incremental, ongoing effort (see call
sites already wired: `pty.cjs` spawn failure + immediate-exit, `chatRunner.cjs`'s single
`emitTerminal` chokepoint, `GlobalSearchModal.tsx` + `QuickOpenModal.tsx`'s search/pty-write
failures).

## Reading these logs

Plain JSONL — `tail -f`, `jq`, or any log tool that reads newline-delimited JSON works. Filter
by tag, e.g. `jq 'select(.tags | index("tab:<id>"))' errors-2026-07-31.jsonl` to trace every
error for one tab, or `jq 'select(.scope == "chatRunner")'` to isolate one subsystem.
