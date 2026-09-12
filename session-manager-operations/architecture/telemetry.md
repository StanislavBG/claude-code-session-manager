# Product telemetry (bilko.run) — data model, lifecycle, dedup

> Covers the anonymous "phone home" telemetry this app sends to bilko.run — NOT the OTEL
> transcript exporter (`src/main/otelSettings.cjs` + `otel.cjs`), which is a separate, unrelated
> opt-in data path that happens to share a UI sub-view (`SettingsTelemetry.tsx`) with this
> feature. Read `code-map.md` for the module inventory; this doc is the data model + lifecycle
> reference for the four on-disk stores this feature owns.

## Why this doc exists

This feature ends up with **four separate on-disk stores** and **two independent bookkeepers**
(the client's queue/sent-set, and the drainer's byte-offset watermarks) that both answer the same
question — "has this record already been submitted?" If they drift, the failure is invisible from
the UI: either the entire historical error backlog gets silently re-sent on every launch
(over-traffic, a bill), or a user's only crash report is silently never sent. Read this before
touching any of the four modules below.

## The four local stores (ERD)

All four live under `~/.config/session-manager/` — machine-global, not per-project (there is one
install, one queue, one identity, regardless of how many project tabs are open).

### 1. `telemetry.json` — config + install identity

| | |
| --- | --- |
| Path | `~/.config/session-manager/telemetry.json` |
| Owning module | `src/main/lib/telemetrySettings.cjs` |
| Write mode | Atomic (tmp + rename via `config.cjs`'s `writeTextAtomic`), serialized through an in-process write queue |
| Primary key | Singleton file — one row |
| Cap / eviction | None (fixed-shape config object) |
| Ever transmitted? | **No** — `installId` is embedded as `visitor_id` in outgoing wire records (see below), but this file itself is never uploaded |

| Field | Type | Meaning |
| --- | --- | --- |
| `enabled` | boolean | On/off. Defaults `true`. `SM_TELEMETRY=0` always overrides to off, regardless of this value. |
| `installId` | string | `crypto.randomUUID()`, minted once on first `load()`. The **only** identity this feature ever sends. |
| `endpoint` | string | bilko.run ingest base URL. `SM_TELEMETRY_ENDPOINT` env overrides at resolve time. |
| `noticeAckedAt` | string \| null | ISO timestamp the first-run notice was dismissed (OK or Turn off). `null` = notice still pending. |
| `lastMachineReportAt` | string \| null | Last time the `install.machine` profile event was sent. |
| `lastMachineReportVersion` | string | App version that last sent a machine-profile report (drives the version-change trigger). |
| `lastDailyFlushAt` | string \| null | Last time a `daily`-reason flush completed with zero failures. |
| `schemaVersion` | `1` | `isValid()` rejects any object with an unknown key or wrong shape — a future accidental PII field can never silently round-trip through load/save. |

There is deliberately **no field beyond `installId`** that could identify a person — no email,
no username, no hostname.

### 2. `telemetry-queue.jsonl` — pending records

| | |
| --- | --- |
| Path | `~/.config/session-manager/telemetry-queue.jsonl` |
| Owning module | `src/main/lib/telemetryClient.cjs` |
| Write mode | **Append** on ingest (`persistAppendLine`); **full atomic rewrite** after a successful send or a cap eviction (`persistQueueFull`) |
| Primary key | `recordId` (one JSON object per line: `{ recordId, channel, wire }`) |
| Cap / eviction | Oldest-first, bounded by `QUEUE_CAP_COUNT` (5000) and `QUEUE_CAP_BYTES` (5 MB) |
| Ever transmitted? | The `wire` payload of each record is what gets POSTed — this file's *content* is the outbound data, its *existence on disk* is never itself uploaded |

Each line: `{ recordId: string, channel: 'event'|'log'|'error', wire: object }`. `wire` is the
exact JSON body sent to `/api/telemetry/<channel>` — already redacted and attribution-stamped at
the moment it was queued (see Privacy model below).

### 3. `telemetry-sent.json` — delivered recordIds

| | |
| --- | --- |
| Path | `~/.config/session-manager/telemetry-sent.json` |
| Owning module | `src/main/lib/telemetryClient.cjs` |
| Write mode | Atomic (`config.cjs`'s `writeJson`) |
| Primary key | `ids: string[]` — an ordered set of `recordId`s |
| Cap / eviction | Oldest-first, bounded by `SENT_CAP` (5000) |
| Ever transmitted? | **No** — purely local bookkeeping of what already left the machine |

### 4. `telemetry-watermarks.json` — per-log-file byte offsets

| | |
| --- | --- |
| Path | `~/.config/session-manager/telemetry-watermarks.json` |
| Owning module | `src/main/lib/telemetryBacklog.cjs` |
| Write mode | Atomic (`config.cjs`'s `writeJson`), rewritten after each file's drain step |
| Primary key | `"<projectHash>/<filename>"` (e.g. `a1b2c3d4e5f6/errors-2026-08-01.jsonl`) |
| Cap / eviction | None — one entry per project-log-file pair ever seen; a `completedAt` stamp on entries older than the 30-day retention floor keeps them cheap to skip (stat only, never re-read) |
| Ever transmitted? | **No** — `projectHash = sha256(normalizedProjectRoot).slice(0,12)` so this file never itself stores a user's directory layout, but the offsets and hashes stay local |

| Field (per entry) | Meaning |
| --- | --- |
| `bytesEnqueued` | How far this file has been read + handed to `telemetryClient`. Advances the instant a line is processed — accepted, rejected as duplicate, or dropped — so a malformed/duplicate line can never wedge forward progress. |
| `bytesConfirmed` | Only advances for the **contiguous prefix** of lines whose `recordId` a `flush()` call reported as `sent`. A failed flush leaves this untouched. |
| `linesConfirmed` | Count of confirmed lines, for reporting. |
| `completedAt` | Set once `bytesConfirmed >= file size`; lets a fully-delivered, unchanged file be skipped with a cheap `stat()`, never re-opened. |

`recordId` for a backlog line is **deterministic**: `sha256(projectHash|filename|byteOffset).slice(0,16)`
— a pure function of *where* the line sits in the file, never random and never content-derived. A
watermark rewind re-derives the exact same id `telemetryClient` already holds or held, so a rewind
is harmless (absorbed by the client's own dedup) instead of duplicating a record.

## Record lifecycle (state machine)

```
                 track() / logLine() / reportError()
                 (or telemetryBacklog replaying an
                  existing errors-<date>.jsonl line)
                              │
                              ▼
                    ┌───────────────────┐
                    │    ACCUMULATED     │  appended to telemetry-queue.jsonl,
                    │  (in queue.jsonl)  │  recordId added to in-memory queueIds
                    └─────────┬──────────┘
                              │ flush(reason) — boot / daily /
                              │ version-change / quit / manual
                              ▼
                    ┌───────────────────┐
                    │     IN-FLIGHT      │  batched (<=50/req) POST to
                    │  (send attempted)  │  /api/telemetry/<channel>
                    └───┬───────────┬────┘
                        │ 2xx       │ non-2xx / network error
                        ▼           ▼
              ┌────────────────┐  ┌───────────────────────────┐
              │   DELIVERED     │  │          FAILED            │
              │ removed from    │  │ stays in queue.jsonl;       │
              │ queue.jsonl,    │  │ 429/0/5xx → exponential     │
              │ recordId →      │  │ backoff (retried next       │
              │ telemetry-      │  │ eligible flush); 4xx (incl. │
              │ sent.json       │  │ 401) → disabledForProcess,  │
              └────────────────┘  │ not retried this process    │
                                   └───────────────────────────┘

  Separately, a QUEUED-BUT-NOT-YET-SENT record can be:

                    ┌───────────────────┐
                    │      EVICTED       │  cap exceeded (5000 records / 5MB) —
                    │ (oldest-first)     │  oldest-first eviction from queue.jsonl,
                    └───────────────────┘  evictedCount incremented, never re-derived
                                            here (only a *backlog* line can be
                                            reconstructed and re-enqueued — see below)
```

Opt-out (`enabled: false`) is a fifth, out-of-band transition: every ACCUMULATED record for that
install is dropped (`telemetryClient.clearQueue()` truncates `queue.jsonl` and clears the
in-memory queue) so a later re-enable never resends a payload that only ever queued while opted
out. `telemetry-sent.json` and `telemetry-watermarks.json` are untouched by opt-out — they
describe history that already left the machine (or never needs to again), and clearing them would
make a re-enable **resend** that history instead of respecting it.

## How duplicate submission is prevented

Three independent mechanisms, each covering a different failure mode:

1. **Deterministic `recordId`** (same log line ⇒ same id). Backlog `recordId`s are
   `sha256(projectHash|filename|byteOffset)` — a pure function of position, not content or
   randomness. **Prevents**: re-scanning the same bytes on a later boot (or after a watermark
   rewind) from ever minting a *second* id for the same line — `telemetryClient`'s own
   `queueIds`/`sentIds` dedup then absorbs the "resend" as a no-op.

2. **`telemetry-sent.json`** (durable already-submitted set surviving restarts). Every id a
   `flush()` confirms as delivered is added here before the queue file is rewritten. **Prevents**:
   a record that was already delivered from being re-queued and re-sent after an app restart, a
   crash mid-flush, or a boot-time backlog re-scan — `appendRecord()` checks `sentIds` (and
   `queueIds`) before accepting a new record at all.

3. **Two-phase watermark + `reconcileWatermarks()`** (progress vs. confirmed truth). `bytesEnqueued`
   is the optimistic "how far have we read" cursor; `bytesConfirmed` is the conservative "how far
   has telemetryClient *proven* delivery" cursor. A single cursor can't safely serve both needs at
   once: an optimistic-only cursor would skip re-sending a record that got queued then evicted
   before delivery (silent loss); a conservative-only cursor would re-read and re-hand every line
   to `telemetryClient` on every boot (wasted work, though harmless thanks to mechanism 2).
   `reconcileWatermarks()` runs at the start of every `drainBacklog()` call: for any file where
   `bytesConfirmed < bytesEnqueued`, it re-derives the recordIds in that gap and asks
   `telemetryClient` whether each is still pending or already durably sent. Only when a record is
   in **neither** (lost to queue-cap eviction, or a corrupt queue/sent file) does it rewind
   `bytesEnqueued` back down to `bytesConfirmed` — this is the `watermarksRewound` counter the
   Settings inspector surfaces. **Prevents**: a record silently vanishing forever because it was
   evicted from the queue before ever being confirmed sent.

## The reused bilko.run beacon contract

`telemetryClient.cjs` POSTs to `<endpoint>/api/telemetry/<event|log|error|install>` — the exact
same beacon endpoints and wire shape (`app`, `visitor_id`, `session_id`, plus channel-specific
fields) that bilko.run's own product page already exposes for its own analytics. No new protocol
was designed for this feature: the app is just another beacon client, authenticated the same
anti-noise way (`X-SM-Beacon-Key`, a public non-secret tag shipped in the npm package, not a
credential). The server-side schema (`app_errors`/`app_logs`/`app_installs`) is bilko.run's own
ERD and is intentionally **not duplicated here** — see that repo's docs.

**The `install` channel is not batch-shaped.** `event`/`log`/`error` are appends, POSTed as
`{batch:[...]}` (up to `MAX_BATCH` per request). `install` is a durable **upsert** keyed on
`install_id` (a desktop install is a slowly-changing dimension, not an event stream) and the
server route takes one flat snake_case object per request — never a batch envelope. It still
flows through the same queue/dedup/backoff machinery as the other three (accumulates in
`telemetry-queue.jsonl`, drains on the same `flush(reason)` cadence, same
`applyFailureBackoff()`), but `flushImpl()` sends its records one at a time via `sendSingle()`
rather than `sendBatch()`.

`telemetryClient.reportInstall(profile)` builds the wire body directly from
`buildMachineProfile()`'s camelCase fields (`machineProfile.cjs`) plus `settings.installId` as
`install_id` and the literal `'session-manager'` as `app` — mapped to the exact snake_case keys
`app_installs` expects: `install_id, app, app_version, platform, os_release, arch, cpu_count,
total_mem_mb, node_version, electron_version, install_channel, locale, timezone` (`timezone` is
`String(timezoneOffsetMinutes)` — machineProfile's anonymity contract already forbids an IANA
zone name). Unlike `track`/`logLine`/`reportError`, this body isn't arbitrary user content, so it
skips `redactDeep()` and never merges an attribution/`recordId` block onto the wire — the server's
upsert has no use for one.

`telemetryBoot.cjs`'s machine-profile heartbeat (version-change OR 30-day liveness) now calls
`telemetryClient.reportInstall(profile)` instead of the former `track('install.machine', profile)`.
That `track()` call is **retired**, not kept alongside it — sending both would duplicate the same
facts into `funnel_events` (which nothing reads them from) and `app_installs` (the actual source
of every install-shaped number on bilko.run) for no benefit.

## Privacy model

**Sent**: an anonymous `installId` (UUID, no other identity attached), a coarse machine profile
(OS/arch/app version/an install-channel guess — never a hostname, username, MAC address, hardware
serial, absolute filesystem path, or IANA timezone name; `machineDigest` is a coarse hash of
stable spec fields, a hardware-*class* fingerprint, not a device id), structural error/warning
records with `redactDeep()`-scrubbed metadata (any `cwd` key becomes a one-way `projectHash`, any
key matching `REDACT_KEY` — transcript/message/token/secret/password/authorization/cookie/\*key/\*token
— becomes `'[redacted]'`, and every string leaf gets homedir/absolute-path redaction), and coarse
session/launch counters.

**Never sent**: prompts, transcript content, file paths (beyond the one-way project hash), project
names, email addresses, usernames, or any other identifying field — there is no field in
`telemetry.json` capable of carrying one (`isValid()` enforces this at the config layer).

**Why the machine profile can't identify a person**: it's a *class* fingerprint (OS + arch + a
coarse hash of stable hardware-class fields), shared by every install with the same rough spec —
it answers "how many Linux-x64 installs on roughly this class of machine are active", never "which
specific machine or person".

**The deliberate asymmetry**: the *endpoints* (`bilko.run/api/telemetry/*`) are invisible plumbing
— a user never needs to know about or authenticate against them, same as any other backend call
this app makes. The *fact that data leaves the machine* is a different question entirely — that is
disclosed up front (first-run notice) and switchable off in one click (Settings toggle, or
`SM_TELEMETRY=0`). Implementation detail vs. consent are not in tension; conflating them would
either over-expose plumbing nobody needs to see, or under-disclose the one fact that matters.

## On by default, and how to opt out

Confirmed by the product owner: `enabled: true` is the shipped default, and the payload carries no
PII of any kind — both are final product decisions, not something this doc or a future PRD should
silently revisit. Opt-out paths:

- **UI**: Settings > Telemetry > "Product telemetry (bilko.run)" > toggle off, or the first-run
  notice's "Turn off" button. Either persists `enabled: false` and clears the pending queue (see
  lifecycle above).
- **Env**: `SM_TELEMETRY=0` — a hard kill switch checked at every `isEnabled()` call site,
  overriding the persisted value unconditionally (useful for CI/headless/scheduler-job runs where
  no Settings UI exists).

Per the open-core law (`CLAUDE.md`), telemetry state **never gates a feature** — there is no
license check, entitlement, or "pro" tier anywhere near this code, and the first-run notice is a
dismissible in-app banner, never a startup-blocking modal.

## Cadence

- **Boot**: every launch calls `flush('boot')` — delivers whatever accumulated while the app was
  closed.
- **Version-change**: if the persisted `lastMachineReportVersion` differs from the running
  `app.getVersion()`, an extra `flush('version-change')` runs, and a fresh `install.machine`
  profile event is queued (also re-sent as a 30-day liveness heartbeat even without a version
  bump, turning "ever installed" into "actively installed").
  `telemetryBacklog.bootDrain()` mirrors this split for the *pre-existing* error-log backlog: a
  `reason: 'boot'` drain always runs, and — the first time a given `appVersion` is seen by the
  drainer — a second `reason: 'version-change'` drain runs (cheap no-op if the first pass already
  advanced everything).
- **Daily**: `telemetryClient`'s own internal hourly timer checks `telemetrySettings.isDailyFlushDue()`
  and fires `flush('daily')` at most once per rolling 24h window — this is the *only* place a
  timer-driven send happens; nothing else polls on a short interval.
- **Manual**: the Settings "Send now" button calls `flush('manual')` directly, so a user reporting
  a problem can push their queue immediately instead of waiting for the daily window.
- **Quit**: a best-effort `flush('quit')` on app shutdown.

## Why log files are never mutated

`errors-<date>.jsonl` files are owned by `opsErrorLog.cjs` under the `logs` namespace, which is
under session-manager's **SINGLE-WRITER LAW over the operations root** (`CLAUDE.md`,
`lib/opsOwnership.cjs`) — `logs` is owned by the app's error-logging path, and `telemetryBacklog.cjs`
is a **read-only** consumer of it. It never truncates, rewrites, or annotates those files; all of
its own bookkeeping (offsets, confirmation state) lives in the separate `telemetry-watermarks.json`
file instead. This is also what makes a corrupted or reset watermarks file safe — worst case is a
full, idempotent (see dedup mechanisms above) re-drain, never data loss in the source logs.
