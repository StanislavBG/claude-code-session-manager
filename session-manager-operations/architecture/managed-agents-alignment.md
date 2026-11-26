# Managed Agents alignment — the structural laws and why

Topic doc (LAW-RATIONALE) for the one-line laws in the root [AGENTS.md](../../AGENTS.md) that adopt
Anthropic's Managed Agents patterns (versioned agents, environments, vaults, session event streams,
outcomes) as code-enforced structure, owner-approved as plan items C1–C13.

**Local-only constraint (stated once, applies to every section):** each pattern is adopted *locally*.
Nothing here calls a hosted agent service, a network vault, or a remote store. State lives on this machine
(operations root, `~/.claude/`, the OS keyring); outside integrations reach it only over loopback. A change
that needs a network dependency to satisfy one of these laws is a domain-model change, not an extension.

## Personas

**Law:** a persona's frontmatter must pass the strict schema (a concrete `model`, no silent fallback), and
every run pins the exact agent definition it used as an immutable AgentSnapshot.

- Schema: `src/main/lib/persona-macro/personaFrontmatterSchema.cjs` (`validatePersonaFrontmatter`).
  `agentLibrary.cjs`'s `savePersona` refuses a failing file; dispatch refuses an unresolvable or invalid
  persona (`agentModelResolve.cjs`) instead of running "no persona + default model".
- Snapshot: `src/main/lib/claude/agentSnapshot.cjs` — content-addressed (sha256 of canonical JSON), written
  once under `agents/snapshots/` (writer `agents`). Pinned at Epic mint (`epicMint.cjs`) and per job dispatch;
  a resume re-runs the pinned snapshot. Re-pinning is the audited "Update agent" action only.
- Why: a persona edit mid-plan silently changed what a resumed or retried run was — the run's identity must be
  the definition it started with, not whatever the file says now.

## Capabilities

**Law:** a persona declares its `mcpServers` and `packs`; jobs and Tasks run strict MCP with exactly those, and
an unknown declared capability parks the job (`capability_unknown`) instead of spawning it.

- Code: `agentLibrary.cjs` (declaration), `src/main/lib/claude/personaToolScope.cjs` (enforced args), the
  scheduler's dispatch check, `src/main/lib/tasks/` Task spawn.
- Why: inherited user-scope MCP servers made every job's tool surface (and memory cost) depend on the
  machine, not on the persona. Declared = reviewable; undeclared = absent.
- Scope (decided 2026-11-26, reversing 2026-11-23): gear binds Epic chat turns too, for Epics minted after the
  release (their pinned snapshot is stamped `gearBindsChat: true`; older snapshots keep the user's own MCP
  config). Why: the owner wants Q&A and troubleshooting with the same character the Epic's jobs run as, not a
  different, ungeared one. Code: `gearChatArgs` in `src/main/chatRunner.cjs` (tools, strict MCP, packs; an
  unknown server/pack is dropped with a `capability_unknown` warning, never a failed turn;
  `HEADLESS_DISALLOWED_TOOLS` is not applied to chat); stamp in `src/main/lib/claude/agentSnapshot.cjs`.
- Skills: carried only inside packs. `skillDenyArgs` / `resolveSkillDeny` in `personaToolScope.cjs` add
  `--disallowedTools=Skill(<name>)` for every installed skill not in an equipped pack, at job, Task and chat
  spawns. CLI-bundled skills and `code-review` / `security-review` are never denied.
- Loadout states (`src/main/lib/persona-macro/personaLoadout.cjs`, from the `tools:` key): `undecided` (key
  absent: runs unscoped, reported Undecided), `bare` (`tools: []`: floor only, no pack skills), `equipped`
  (`tools: A, B`: exactly those), `unbound` (`tools: *`: everything, an explicit decision). Unbound and
  undecided deny no skills. Every persona has one; `npm run report:loadouts` lists them.

## Environments

**Law:** every headless run executes under a declared environment profile (sandbox requirement, permission
mode, write roots, network mode, secret deny paths, web tools), enforced by default.

- Code: `src/main/lib/claude/environmentProfiles.cjs` — resolution `<project>/.claude/environments/<name>.json`
  then `~/.claude/session-manager/environments/<name>.json` (first hit wins, whole-file). The job sandbox is
  derived from the profile in `jobSandboxPolicy.cjs`; detail in
  [scheduler-operations.md](scheduler-operations.md#11-job-sandbox).
- Why: sandbox policy hard-coded per persona could not be audited or varied per project; a named profile is
  one file a human can read and diff, and the snapshot records which one a run used.
- Loopback (decided 2026-11-24): a sandboxed job's Bash cannot reach host loopback at any profile, so a live
  check is an http criterion the scheduler runs outside the sandbox just before the validator starts; the validator
  judges the stored result. Allow-listing localhost was rejected: it works only when a client is forced through the
  proxy against NO_PROXY, and it would open every local service to the job. Evidence:
  [scheduler-operations.md](scheduler-operations.md#loopback-reach).

## Credentials

**Law:** no credential ever enters a job's environment. Spawn sites call `assertNoCredentials`; the only
exceptions are named in `CREDENTIAL_EXCEPTIONS`.

- Code: `src/main/lib/process/cleanEnv.cjs` (`assertNoCredentials`, `CREDENTIAL_EXCEPTIONS`,
  `CREDENTIAL_CHECKED_SITES`; an unknown site is refused). Secrets an MCP server needs come from local vault
  refs (`src/main/lib/claude/vaultRefs.cjs`: `keyring:` / `file:` only, any network scheme refused) resolved
  only into the spawn env of a server running *outside* the job.
- Why: a job with Bash can read its own env; the only safe credential is one the job never had.

## Event log

**Law:** each Epic has one durable, append-only event log, and `epicEventLog.cjs` is its only writer.

- Code: `src/main/lib/epic/epicEventLog.cjs` — `events/<epicId>/events.jsonl`, per-Epic monotonic `seq`,
  closed `{domain}.{action}` kind set, summaries only (string fields capped). Writer `event-log` in
  `opsOwnership.cjs`; `npm run lint:event-log` fails any other writer. Outside readers replay via
  `GET /admin/events?epicId=` ([external-contract.md](external-contract.md)).
- Message kinds: `human.message` (`via: 'desktop'` composer, `via: 'web-remote'` phone) and
  `external.message` (`via: 'admin-api'`, `POST /admin/chat/send-prompt`, which agents also call). The
  relay is noted at the source and consumed once by `chatRunner.run()`; untagged external, scheduler,
  inbound-proposal and boot-recovery prompts log nothing. Auto-approval's human-prompt ledger is separate.
- Why: state-snapshot watchers raced and lost transitions; an ordered log with a replay cursor cannot.

## Legality

**Law:** every status change goes through its domain's legality table; an illegal edge is refused and
audited, and outside readers see one `phase` projection.

- Tables: `src/main/lib/epic/epicTransitions.cjs` (Epic, post-mint), `lib/scheduler/scheduleJobTransitions.cjs`
  (jobs), `lib/tasks/taskLedger.cjs` (Tasks). `npm run lint:status-writes` fails a direct `.status` write
  outside them. The Epic status law itself stays in
  [prompt-sessions/README.md](../prompt-sessions/README.md#lifecycle).
- Phase: `src/main/lib/phaseProjection.cjs` — `idle` / `running` / `rescheduling` / `waiting_on_human` /
  `terminated`, matching `src/renderer/lib/needsHuman.ts`.
- Why: scattered status writes produced states no table allowed; three vocabularies forced every outside
  reader to re-derive "is this mine to act on?".

## Confirm

**Law:** a human decision pauses a run without killing it — a tool-risk `confirm` call, an interrupt, or a
question resumes the *same* session once the human answers.

- Code: `src/main/lib/scheduler/toolClearance.cjs` (pending confirmation → Needs you → approve grants one
  single-use clearance bound to job + tool + args digest and resumes the session; deny parks
  `confirmation_denied`); typed `human.interrupt`, `job.needs_input` / `human.answer` events. Marks:
  [tool-risk.md](tool-risk.md).
- Why: deny-and-fail threw away the run's context and made the human re-queue work by hand.

## Webhooks

**Law:** webhook subscribers are loopback-only, and delivery is HMAC-signed and at-least-once.

- Code: `src/main/lib/telemetry/webhookRegistry.cjs` (plain http to `127.0.0.1` / `[::1]` / `localhost`
  only, checked on the literal text and the parsed host; store `webhooks/` mode 0600, never committed) and
  `webhookDelivery.cjs` (per-subscriber cursor moves only on 2xx; receivers dedupe on `(epicId, seq)`).
- Why: the event log carries project data; a non-loopback URL would be an exfiltration channel.

## Outcomes

**Law:** acceptance criteria can carry mechanical checks, and every finished PRD run writes one structured
outcome record the validator is cross-checked against.

- Code: `src/main/lib/prd/prdCriteria.cjs` (`command` / `file` / `http` (loopback) / `manual`),
  `lib/scheduler/criteriaChecks.cjs` (runs them, never throws), `lib/scheduler/prdOutcomeRecord.cjs`
  (`scheduler/epics/<epicId>/outcomes/<slug>.json` + `outcome.recorded` event),
  `lib/scheduler/validatorVerdictSchema.cjs` (per-criterion verdicts vs stored check results).
- Why: a job's own prose was the only evidence of "done"; observed results can't be talked around.

## Memory

**Law:** memory maintenance only proposes; it never deletes or edits. The human decides.

- Code: `src/main/lib/tasks/memoryConsolidation.cjs` — a weekly read-only Task (behind the 'Scripts may run
  Tasks' switch) posts one keep/move/drop Needs you item.
- Why: automated pruning once dropped live memories; a proposal costs one review, a wrong delete is lost.

## Mitigations

**Law:** every rule that exists only to work around a model's behavior is a row in
[model-mitigations.md](model-mitigations.md), and a default-model change triggers a review of the rows.

- Code: `npm run lint:docs` checks each row's location still holds its needle;
  `src/main/lib/tasks/mitigationReview.cjs` starts one review Task when the default executor model changes.
- Why: workarounds outlive the behavior they patched and bloat every prompt unless something re-tests them.

## Purge

**Law:** keep-forever is the default retention; the only way an Epic's data leaves the machine is a
human-only Purge of a completed Epic.

- Code: `src/main/lib/epic/epicPurge.cjs` (`purgeEpic` accepts only `PURGE_AUTHORITY_IPC`, the `epic:purge` IPC
  handler) removes transcripts, run logs, history rows, PRDs, outcomes, plan records, the event log and
  unreferenced snapshots, then writes a content-free `epic_purged` audit record. Retention:
  [session-manager-operations/AGENTS.md](../AGENTS.md).
- Why: an agent-reachable delete is irreversible data loss; deletion stays a human act.
