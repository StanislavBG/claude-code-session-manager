# RCA: scheduler resurrected 189 completed PRDs as `pending` and churned them into ENOENT failures

**Filed:** 2026-07-31 07:10 PDT · **Severity:** critical (queue corrupted, scheduler manually paused)

## Symptom

Scheduler queue shows 238 `pending` / 2 `completed` out of 246 jobs. Hundreds of PRDs that
completed successfully (e.g. `778-workbench-foundation-dockview`, completed 2026-07-30T23:22Z,
exit 0) appear as never-run. Firing them produces instant failures:

```
ENOENT: no such file or directory, open
'/home/bilko/Projects/<proj>/session-manager-operations/scheduler/prds/<slug>.md'
```

Queue was manually paused (`paused.reason = "manual"`) at 2026-07-31T14:07:56Z.

## Root cause — three defects compounding

### 1. Installed build is behind the repo: PRD migration cannot resolve `~`

The running app is the npx build at
`~/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager` **v0.39.1**. Its
`src/main/lib/prdMigration.cjs` uses the frontmatter `cwd` **verbatim**:

```js
const cwd = fm.cwd && fm.cwd.trim();
if (!fs.existsSync(cwd)) { unresolved.push({ file: name, reason: `cwd does not exist on disk: ${cwd}` }); continue; }
```

Every PRD's frontmatter writes `cwd: ~/Projects/...`, so `fs.existsSync('~/Projects/...')` is
always false. The repo working copy already has the fix (`expandHome(rawCwd)`), but it is not in
the installed build — the same installed-build split-brain as
`2026-07-31-burrow-prd-source-split-brain-in-installed-build.md`.

Result, every boot (log 2026-07-31T14:04:29Z):
`[WARN] [scheduler] PRD migration: 223 file(s) left in legacy dir` — **all 223** stranded in
`~/.claude/session-manager/scheduled-plans/prds/`, while `prdPathForJob()` resolves each job to
`<cwd>/session-manager-operations/scheduler/prds/<slug>.md`. Hence the ENOENT on every spawn.

### 2. Terminal-job archive is non-atomic — history.jsonl was never written

`queueHistory.partitionJobs` splits terminal jobs into `keep` / `toArchive`; `appendHistory`
writes them to `~/.claude/session-manager/scheduled-plans/history.jsonl`.

**That file does not exist**, yet 189 completed jobs are gone from `queue.json`'s `jobs[]`
(verified by diffing `queue.json.bak-779-unwedge-1785457282`, 2026-07-30 17:21, which still had
them as `completed` with `runId`/`sessionId` intact). So jobs were dropped from the queue while
their history record was never durably written — permanent loss of the completion record.

### 3. `reconcile()` resurrects any on-disk slug with no history record

```js
const historyBySlug = unmatchedSlugs.length > 0 ? await queueHistory.historyTerminalBySlug() : new Map();
...
const hist = historyBySlug.get(slug);
if (hist) { ...skip... }
// no history → create a fresh { status: 'pending' } entry
```

With history.jsonl absent the guard map is empty, and the PRD `.md` files are still sitting in
the legacy dir (defect 1 prevented both migration *and* `archiveCompletedPrd`), so
`candidatePrdsDirs()` still finds all 223. Every dropped completed job is re-minted as a fresh
`pending` row with null run metadata — exactly the "scheduler would genuinely re-execute an
already-completed PRD" case that code comment says it exists to prevent.

Loop: resurrect → fire → ENOENT (exit -1) → `classifyFailureOutcome` → `resetJobFields` →
`pending` → fire again. Confirmed burst of ~15 runs between 14:04:49Z and 14:07:14Z.

## Wanted

1. **Ship the `expandHome` fix to the installed build** (publish + reinstall), or make the
   scheduler refuse to run when its PRD migration reports a non-zero stranded count on a
   `~`-prefixed `cwd` — a silent 223-file stranding should be a RED health check, not a WARN.
2. **Make archive atomic**: append to `history.jsonl` and fsync it *before* removing jobs from
   `queue.json`. Never drop a terminal job whose history append failed.
3. **Harden `reconcile()`'s resurrection path**: do not re-mint a `pending` job when
   history.jsonl is missing/unreadable entirely (empty guard map ≠ "never ran"). Treat an absent
   history file as "unknown — do not resurrect", and log loudly.
4. **Spawn-time guard**: if `prdPathForJob()` does not exist but `findPrdDir(slug)` finds the
   `.md` in the legacy dir, use it (or migrate it inline) instead of failing ENOENT.
5. **No auto-retry on ENOENT**: a missing PRD source is not a transient failure;
   `classifyFailureOutcome` must not send exit -1/ENOENT back to `pending`.
6. **Recovery**: restore the 189 completed statuses from
   `~/.claude/session-manager/scheduled-plans/queue.json.bak-779-unwedge-1785457282`, then
   migrate the 223 legacy PRD files into their project dirs and archive the shipped ones.

## Evidence

- `~/.config/claude-code-session-manager/logs/session-manager-2026-07-31.log:1714`
- `~/.claude/session-manager/scheduled-plans/queue.json` vs `queue.json.bak-779-unwedge-1785457282`
- `~/.claude/session-manager/scheduled-plans/history.jsonl` — absent
- installed `src/main/lib/prdMigration.cjs` vs repo `src/main/lib/prdMigration.cjs`

## RESOLUTION

Root-caused and cross-checked against current code — **5 of the RCA's 6 "Wanted" items are
already shipped**, confirmed live during this triage pass:

1. `expandHome` fix for tilde-prefixed `cwd` in PRD migration — landed as `e87a618`, confirmed
   present in `src/main/lib/prdMigration.cjs`. **Gap remaining**: the RED-vs-WARN health-signal
   half of this ask was never done — `runPrdMigration()` still only `console.warn`s on stranded
   files (`src/main/scheduler.cjs:580-584`), not surfaced to `npm run health`. Queued as
   `821-health-check-stranded-prd-migration`.
2. Atomic history-before-drop ordering — confirmed live: `reconcile()` calls
   `queueHistory.appendHistory(toArchive)` before removing jobs from the hot `jobs[]` array
   (`src/main/scheduler.cjs:987-990`).
3. Harden `reconcile()`'s resurrection path against an absent `history.jsonl` — confirmed live:
   the fallback to `latestTerminalOutcomeForSlug()` (reads run-sidecar files directly,
   independent of `history.jsonl`'s existence) is already wired at `src/main/scheduler.cjs:946`,
   plus `c05587b fix(scheduler): stop resurrecting/re-investigating already-terminal PRD slugs`.
4. Spawn-time `findPrdDir` fallback when `prdPathForJob()` doesn't resolve — confirmed live at
   `src/main/scheduler.cjs:1631-1642`.
5. No auto-retry on ENOENT — confirmed live: `classifyFailureOutcome()`
   (`src/main/scheduler.cjs:1532`) only treats `exitCode` 143/137 or a network error as
   transient/retryable; a bare ENOENT (exit -1) routes to `action: 'investigate'`, not a retry
   loop.
6. Recovery of the 189 completed statuses — not needed as new code. The live `queue.json` was
   independently re-checked during this pass and is healthy: 114 completed / 12 pending / 3
   failed / 2 running, `paused: null`. The incident had already self-resolved (or was manually
   recovered) by triage time.

Same root pattern as the sibling burrow item filed same day: the incident happened because the
*running* installed build was behind git HEAD at the time, not because these guards were
missing from the repo. The one genuine, still-open gap (item 1's health signal) is queued as
`821-health-check-stranded-prd-migration` (cwd `~/Projects/session-manager`,
`estimateMinutes: 15`) — surfaces `runPrdMigration()`'s existing stranded-file detection as a
RED `npm run health` check instead of a log-only warning, so this exact incident class is
visible before it causes a resurrection storm again, regardless of *why* the running build went
stale.
