# Product telemetry (bilko.run) — data model, lifecycle, dedup

> Covers the anonymous "phone home" telemetry this app sends to bilko.run — NOT the OTEL
> transcript exporter (`src/main/otelSettings.cjs` + `otel.cjs`), which is a separate, unrelated
> opt-in data path that happens to share a UI sub-view (`SettingsTelemetry.tsx`) with this
> feature. Read `code-map.md` for the module inventory; this doc is the data model + lifecycle
> reference for the three on-disk stores this feature owns.

## Why this doc exists

Every record answers one question — "has this already been submitted?" — and that answer now has
exactly **one bookkeeper**: `telemetryClient.cjs`'s queue + sent-set. If it drifts, the failure is
invisible from the UI: either history is silently re-sent (over-traffic, a bill) or a user's only
crash report is silently never sent. Read this before touching the modules below.

**Retired: the error-log backlog drainer.** A second bookkeeper (it replayed
`errors-<date>.jsonl` lines tracked by byte-offset watermarks in `telemetry-watermarks.json`) was
deleted in commit `cd006e16`. The live `opsErrorLog.cjs` tap already ships every warn/error at write
time, so the replay was pure duplication — and worse: it re-sent those lines under new recordIds,
replayed `info` lines as errors, never confirmed delivery, and re-sent after sent-set eviction.
`telemetryBoot.removeLegacyWatermarks()` deletes a leftover `telemetry-watermarks.json` once on
boot (best-effort, never throws).

## The three local stores (ERD)

All three live under `~/.claude/session-manager/` — machine-global, not per-project (there is one
install, one queue, one identity, regardless of how many project tabs are open).

### 1. `telemetry.json` — config + install identity

| | |
| --- | --- |
| Path | `~/.claude/session-manager/telemetry.json` |
| Owning module | `src/main/lib/telemetry/telemetrySettings.cjs` |
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
| `lastMachineReportAt` | string \| null | Last time the machine-profile install upsert was sent. |
| `lastMachineReportVersion` | string | App version that last sent a machine-profile report (drives the version-change trigger). |
| `lastDailyFlushAt` | string \| null | Last time a `daily`-reason flush completed with zero failures. |
| `lastSeedsReported` | string \| null | JSON of the 3 seed enum values the last *accepted* install upsert carried (drives the post-seeding re-report). |
| `schemaVersion` | `1` | `isValid()` rejects any object with an unknown key or wrong shape — a future accidental PII field can never silently round-trip through load/save. |

There is deliberately **no field beyond `installId`** that could identify a person — no email,
no username, no hostname.

### 2. `telemetry-queue.jsonl` — pending records

| | |
| --- | --- |
| Path | `~/.claude/session-manager/telemetry-queue.jsonl` |
| Owning module | `src/main/lib/telemetry/telemetryClient.cjs` |
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
| Path | `~/.claude/session-manager/telemetry-sent.json` |
| Owning module | `src/main/lib/telemetry/telemetryClient.cjs` |
| Write mode | Atomic (`config.cjs`'s `writeJson`) |
| Primary key | `ids: string[]` — an ordered set of `recordId`s |
| Cap / eviction | Oldest-first, bounded by `SENT_CAP` (5000) |
| Ever transmitted? | **No** — purely local bookkeeping of what already left the machine |

## Record lifecycle (state machine)

```
                 track() / logLine() / reportError()
                 (reportError/logLine also via the live
                  opsErrorLog.cjs tap on warn/error)
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
                    │     IN-FLIGHT      │  channel order error → install →
                    │  (send attempted)  │  log → event; batched (<=50/req)
                    └─┬───────┬───────┬──┘
               2xx    │       │       │  4xx other than 401/403
                      ▼       │       ▼
          ┌────────────────┐  │  ┌────────────────────────────┐
          │   DELIVERED     │  │  │  REJECTED (quarantined)     │
          │ removed from    │  │  │ that batch dropped from the │
          │ queue.jsonl,    │  │  │ queue, rejectedCount++,     │
          │ recordId →      │  │  │ logWarn; flush continues    │
          │ telemetry-      │  │  └────────────────────────────┘
          │ sent.json       │  │ 429 / 0 / 5xx / 401 / 403
          └────────────────┘  ▼
                    ┌───────────────────────────┐
                    │          FAILED            │ stays in queue.jsonl;
                    │ 429/0/5xx → exponential    │ backoff, flush stops,
                    │ backoff; 401/403 →         │ retried next eligible
                    │ disabledForProcess         │ flush (or next process)
                    └───────────────────────────┘

  A QUEUED-BUT-NOT-YET-SENT record can also be EVICTED: cap exceeded
  (5000 records / 5MB), oldest-first, evictedCount incremented, never re-derived.
```

Opt-out (`enabled: false`) is an out-of-band transition that **applies immediately, in-process**:
`telemetryConsent.applyConsentUpdate()` pushes the saved settings into the live client
(`telemetryClient.applySettings()` — the client otherwise keeps the copy it cached at init), then
`clearQueue()` truncates `queue.jsonl` and the in-memory queue. `flush()` re-checks `isEnabled()`
per channel and per batch, so an opt-out landing mid-flush stops further sends; a re-enable resumes
without a restart. `telemetry-sent.json` is untouched — it describes history that already left the
machine, and clearing it would let a re-enable resend that history.

## How duplicate submission is prevented

1. **`recordId` + in-memory `queueIds`** — `appendRecord()` refuses an id already pending.
2. **`telemetry-sent.json`** (durable already-submitted set surviving restarts). Every id a
   `flush()` confirms as delivered is added here before the queue file is rewritten, and
   `appendRecord()` checks `sentIds` too. **Prevents**: re-sending a delivered record after a
   restart or a crash mid-flush.
3. **One producer per fact** — each error/warn reaches the client once, from the live
   `opsErrorLog.cjs` tap. There is no replay of on-disk logs (see the retired drainer above), so
   nothing can mint a second id for the same line.

## The `env` discriminator (prod / dev / test)

Every outgoing wire record on all four channels (`event`, `log`, `error`, `install`) carries an
`env: 'prod' | 'dev' | 'test'` field, resolved **client-side, at wire-build time**, from real
process signals — never inferred later from an `appVersion` string. `machineProfile.cjs`'s
`resolveEnv({ isTestRunner, installChannel })` is the single implementation (`telemetryClient.cjs`
calls it once per wire build, via its own `currentEnv()` helper for `track`/`logLine`/`reportError`,
and inline in `buildInstallWire()` for `reportInstall()` since that call is given a freshly-built
profile rather than the module-singleton one):

- **`test`** — `isTestRunner` is true (`VITEST` or `NODE_ENV=test` set, no `SM_TELEMETRY_SPOOL`
  override — the exact same signal `isTestEnvironment()` already uses to block real-spool writes).
  Takes priority over everything else.
- **`dev`** — not a test runner, and `installChannel === 'dev'` (`SM_DEV` set, or running unpackaged
  — see `resolveInstallChannel()`).
- **`prod`** — everything else (a packaged/npx install with no `SM_DEV`).

**Why this exists**: the one-shot purge in commit `351d171` only dropped records carrying
`machineDigest: 'deadbeefcafe'` or a foreign `visitor_id` — it could not distinguish a genuine
production record from a pre-release `vitest` run that happened to write into the REAL machine's
spool (the `ensureEpic()`-under-vitest bug that commit's own message describes). Every test-origin
record that used the real machine profile survived that purge and was later delivered — 1,526
`epic.create` records stamped `appVersion: "0.83.0"` (a version whose tree predates
`telemetryCounters.cjs` ever existing) are exactly that leak. **The 351d171 purge criteria are
INSUFFICIENT and must not be reused as-is for a future purge**: any future purge needs `env` (once
enough records carry it) or another signal that survives a shared machine profile, not just
`machineDigest`/`visitor_id`. No purge is run as part of adding this field — existing rows are
untouched; this only makes *future* non-production records self-identifying on the wire.

**Backwards-safety**: confirmed live against `https://bilko.run/api/telemetry/<channel>` — a probe
POST per channel carrying `env` alongside the existing shape returned `200` on `event`, `log`,
`error`, and `install`. The routes ignore/clamp unknown keys today, so an `env`-aware server column
can be added on bilko.run's side without a client/server release ordering constraint.

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
total_mem_mb, node_version, electron_version, install_channel, locale, timezone, env, seeds`
(`timezone` is `String(timezoneOffsetMinutes)` — machineProfile's anonymity contract already
forbids an IANA zone name; `env` comes from `machineProfile.resolveEnv()`, see
[The `env` discriminator](#the-env-discriminator); `seeds` comes from
`telemetryBoot.buildSeeds()`, merged onto the profile before `reportInstall()`). Unlike `track`/`logLine`/`reportError`, this body isn't arbitrary user content, so it
skips `redactDeep()` and never merges an attribution/`recordId` block onto the wire — the server's
upsert has no use for one.

`seeds` carries the first-boot setup outcomes. `telemetryBoot.cjs` `buildSeeds()` keeps only each
seeder's `status` from `seedStatus.cjs` `getSeedStatus()`; `telemetryClient.cjs` `sanitizeSeeds()`
sends either `null` or an object with exactly the keys `devPlugin` (the session-manager-dev plugin
install), `schedulerMcp` (the session-manager-scheduler MCP registration) and `agentPersonas` (the
seeded agent personas), each `done`, `pending`, `failed`, `exhausted` or `null`. `done` = the seeder
finished; `pending` = never attempted, or its marker file is missing or unreadable; `failed` =
attempted but still under the retry cap; `exhausted` = reached the seeder's `MAX_ATTEMPTS`. A status
the client does not recognize goes out as `null`, and the whole field is `null` when
`getSeedStatus()` throws. Bilko's `/install` route persists `seeds` to `app_installs.seeds`
(bilko-run commit 523ba538); see that repo's `Bilko:docs/observability.md`, section 'First-run setup
outcomes (`seeds`)'.

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
session/launch counters, and the first-run setup outcomes: three fixed step names (`devPlugin`,
`schedulerMcp`, `agentPersonas`) with enum values only (`done`/`pending`/`failed`/`exhausted`).
`getSeedStatus()` also returns a `fix` string per seeder (the scheduler-mcp one embeds an absolute
path); `buildSeeds()` drops it, so the Plugins-banner fix text and any path never leave the machine.

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

- **Event `ts`**: every `track()` wire carries `ts: Date.now()` captured at **track time**, so the
  server dates an event by when it happened, not when a (possibly days-late) flush delivered it.
- **Channel order**: each flush sends `error`, `install`, `log`, `event` in that order, so a backoff
  on bulk events can never starve crash reports.
- **Boot**: every launch calls `flush('boot')` — delivers whatever accumulated while the app was
  closed.
- **Version-change**: if the persisted `lastMachineReportVersion` differs from the running
  `app.getVersion()`, an extra `flush('version-change')` runs and a fresh install upsert is sent
  (also re-sent as a 30-day liveness heartbeat even without a version bump).
- **Seeds settle**: `bootSequence()` snapshots seed status before the boot seeders finish, so a
  fresh install's first upsert reports every step `pending`. Once `bootSeedingPromise` settles
  (fulfil or reject), `index.cjs` calls `telemetryBoot.reportSeedsIfChanged()`, which re-upserts
  when the settled seeds differ from `lastSeedsReported`, persisting it only on `accepted` (a
  failed upsert retries on the next settle).
- **Daily**: `telemetryClient`'s own internal hourly timer checks `telemetrySettings.isDailyFlushDue()`
  and fires `flush('daily')` at most once per rolling 24h window — the *only* timer-driven send.
- **Manual**: the Settings "Send now" button calls `flush('manual')` directly.
- **Quit**: a best-effort `flush('quit')` on app shutdown.

## Crash reports

`crashTelemetry.cjs` names each report `crash.<reason>`. The unclean-shutdown postmortem
(`crashDiagnostics.cjs` `checkPreviousRun`) uses reason `unclean-shutdown:<likelyCause>`, so causes
are distinguishable in aggregate without parsing context. `classifyUncleanShutdown()` ranks
`compositor-disconnect`, `signal:<NAME>`, `main-hang`, `memory-pressure`, `os-restart`, `unknown`;
`os-restart` fires when machine uptime (`os.uptime()`, as `bootUptimeSec`) is shorter than the last
sample's age — the machine rebooted under the app, not an app crash. Context keeps `likelyCause`
and adds `bootUptimeSec`.

## The five usage counters (`telemetryCounters.cjs`)

`telemetryCounters.cjs` is the only emitter; props are closed enums only (user-authored values map
to `other`/`custom`, never sent raw):

- **`app.launch`** `{installChannel, appVersion}` — `telemetryBoot.cjs` `bootSequence()`'s
  unconditional last step.
- **`epic.create`** `{tag, agentType}` — `epicMint.cjs`.
- **`prd.create`** `{agentType}` — `prdCreate.cjs`, on both the single and batch create paths.
- **`scheduler.job.finish`** `{status}` — `scheduleJobTransitions.cjs`.
- **`session.open`** `{surface}` — `surface` is `'terminal'` or `'chat'` (anything else → `null`).
  `pty.cjs` fires `terminal` only on a **fresh** PTY spawn, never a reattach (an already-registered
  `tabId` — HMR reload or revisiting a running Terminal pane is the same session, Tab =
  claudeSessionId). `chatRunner.cjs` fires `chat` once per run when a turn starts a brand-new CLI
  session via `--session-id` (not a `--resume` turn, not an agent-plan run). Either way it counts
  sessions actually started, not views. Covered by `pty-session-open-telemetry.test.cjs` and
  `chatRunner-session-open-telemetry.test.cjs`.

## Why log files are never mutated

`errors-<date>.jsonl` files are owned by `opsErrorLog.cjs` under the `logs` namespace (SINGLE-WRITER
LAW, `lib/opsOwnership.cjs`). Telemetry never reads, truncates, or annotates them: the
`opsErrorLog.cjs` tap mirrors each warn/error line to `telemetryClient` at the moment it is
appended, and all delivery bookkeeping lives in the client's own queue and sent-set.
