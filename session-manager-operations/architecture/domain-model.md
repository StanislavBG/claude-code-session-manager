# Domain model (TAB / EPIC) — full reference

Root `CLAUDE.md` holds the one-line laws; this file holds the rationale behind each. **Read this before
changing anything in the TAB → EPIC → PRD chain.** Any new feature touching sessions, navigation, or
per-project state must map onto the TAB → operations-root → EPIC → session hierarchy, never a parallel
scoping scheme.

## Hierarchy

- **TAB = cwd = Main Project.** A Terminal tab is anchored to one cwd; that cwd is the project identity and
  everything the app manages for a project keys off it. One TAB per project: the sidebar's "Open / Start
  Project" activates an already-open project's tab rather than adding one, because extra sessions within a
  project are Epics.
- **`<TAB cwd>/session-manager-operations/`** is the per-project operations root, created when a tab first
  opens on that cwd. The app owns its contents; the namespace enumeration is in
  [`../CLAUDE.md`](../CLAUDE.md).
- **EPIC = one small unit of work within the Main Project**, implemented as `PromptSession`
  (`state/promptSessions.ts`). It carries an `agentType`, a `tag` and its `goalText`. The tag also sets how
  eagerly `/develop` fires inside the Epic's session (the `session-manager-dev:develop` skill's "Tag-aware
  default"): `feature`/`bug` treat PRD decomposition as the expected next step, `discussion` keeps it
  available but never assumed.
- **"Sessions" is the user-facing name; `Epic`/`PromptSession` is the code name.** Every UI surface says
  *session* because that is what an Epic is: a tagged claude session opened through AIM. `PromptSession`,
  `EpicTag`, `epicId`, every `epic-*` testid and every on-disk path (`scheduler/epics/<epic-id>/`) keep the
  code name — don't carry the label change into identifiers.
- **EPIC : claude-session = 1:1.** Each Epic mints its own `claudeSessionId`, never shared with or derived from
  a SessionTab's. **Chat and Terminal are two views over that one session**: Chat is headless
  `claude -p --resume <id>` via chatRunner, Terminal is interactive PTY `claude --resume <id>` in the Epic's
  cwd. Switching views hands the session off (mutually exclusive attachment) instead of minting a new
  sessionId, because context continuity across the switch is the invariant. The event chain
  (`prompt → prd_created → response → closed`, linked by `causedByEventId`) is the auditable trace of
  everything the Epic spawned.
- **Active Epics run in their own `git worktree`** (branch `sm-epic/<id>`, `gitWorktree.cjs`'s
  `createEpicWorktree`, created at `proposed → active`) so concurrent Epics on one project don't clobber each
  other's uncommitted edits; Terminal PTY and headless Chat both resolve their spawn cwd to it
  (`epicSpawnCwd.cjs`). Isolation folds back at exactly one checkpoint, `markCompleted`'s merge-before-archive
  step (`epicWorktreeMerge.cjs`'s `integrateEpicBranch`: ff-only → merge-commit → abort-and-flag). A real
  conflict sets `worktree.status` to `needs_merge_resolution` (EpicDetail's banner, "Resolve in Terminal")
  rather than blocking anything. Settings' project scope holds the per-project opt-out.
- **Persistence:** active Epics in `prompt-sessions/active-index.json`; completed ones archived one JSON per
  Epic in the same folder. An archived Epic's claudeSessionId is dead — resuming mints a new session with
  `resumedFromId` tracing back.

## Agent + Tag, and the AIM prompt

- **Epic creation is two independent selections.** `agentType` (Actor — an Agent Library persona,
  `~/.claude/agents/*.md`) and `tag` (Mission — what the Epic is for) are separate axes on `PromptSession`.
  The `tag` taxonomy is a closed union; both libraries are full CRUD editors (`AgentLibrary.tsx` via
  `agentLibrary.cjs`'s `savePersona`/`deletePersona`/`removeOverride`; `TagLibrary.tsx`), never read-only
  directories — don't describe them as read-only in docs or copy.
- **Persona↔tag membership is many-to-many with one source of truth:** each persona's `tags:` frontmatter
  (`AgentPersona.tags`), editable from either library page, both writing through `savePersona`.
- **Field names reuse existing vocabulary.** `tag` is the field `lib/tagLibrary.ts`'s `TAG_LIBRARY` and
  `lib/agentTagDefs.ts` already describe — every "what does this tag mean" string reads through
  `agentTagDef(tag).description`, never a second copy. `agentType` matches Claude Code's own `agent_type` hook
  payload, the Task tool's `subagent_type`, and `teams.cjs`'s member field, so it isn't a fourth name for the
  same concept.
- **Epic tag and PRD tag share ONE `WorkType` enum (`lib/prd/workTypeLibrary.cjs`) but are independent values** —
  never derived, defaulted, or validated against each other. An Epic is the plan; a PRD is one unit inside it,
  so a `feature` Epic can legitimately hold a `bug` PRD. The only asymmetry: an Epic's tag may be `discussion`
  (whether-to-build is unsettled), a PRD's never is (`PRD_WORK_TYPES` = `WORK_TYPES` minus `discussion`).
  `prdCreate.cjs` passes `tag` straight to frontmatter with no lookup against the parent Epic.
- **The opening prompt is AIM — Actor, Input, Mission, in that order** — composed only by
  `lib/epicIntake.ts`'s `composeEpicIntake` into `openingPrompt` (never `goalText`). Actor is the persona line
  (`agentName`/`agentDescription`); Input is `lib/groundingBoard.ts`'s `summarizeGroundingBoard` over the real
  System/Project/Local inventory (computed fresh by `computeGroundingBoard` at submit if the board wasn't
  opened — never a second fetch path); Mission is the tag's `initialPromptTemplate` followed by the human's
  goal. Each input is independently optional and omits its line when absent. It is framing only: Input stays
  real-data-derived and display-only, and never becomes a second source of truth for what the `claude` CLI
  loads.
- **The grounding board is an inspector, not a control.** `NewEpicCard.tsx`'s "advanced" flip shows what the
  session will load; it has no toggle-what-loads controls because session-manager cannot tell the CLI to skip a
  file it would otherwise discover.
- **`agentType` beyond the prompt** only sets the launched `--model`/effort defaults: the persona's own
  `model`/`effort` frontmatter wins when set and isn't `inherit`, else the Settings default applies
  (`agentModelResolve.cjs`'s `resolveEpicModel` for Chat; `EpicTerminalPane.tsx` mirrors it renderer-side
  because it can't import a `.cjs` module). Otherwise it never changes which CLI process spawns.
- **A project-local persona overlay MERGES over the global persona.** `<cwd>/.claude/agents/<name>.md` is
  field-merged over `~/.claude/agents/<name>.md` in exactly one place, `personaMerge.cjs`'s
  `resolveMergedPersona`, and every reader goes through it. Overlay keys win, absent keys fall back to the
  global, and an empty-body overlay inherits the global body. Overlay `model: inherit` defers to the Settings
  default (omit the key to keep the global's). A malformed overlay is ignored and reported; provenance is
  per field. Use case: a frontmatter-only `<cwd>/.claude/agents/dev-lead.md` changes one project's executor
  without forking the persona body.
- **A MACRO is a saved (agent, tag, prompt) hot key, not a fourth concept.** Stored machine-locally by
  `macroLibrary.cjs` (`~/.claude/session-manager/macros.json`; `Macro.projects` = absolute cwds or `'*'`) and
  rendered by `SessionActionsBar.tsx`. Pressing one is the same act as New Session — the one IPC handler
  holding `MINT_AUTHORITY_NEW_EPIC_UI`, `composeEpicIntake`, approve out of `proposed`, send — so the
  single-creator law is untouched: a human still presses the button.
- **An Epic's title + objective are fixed for the life of its session, and are its first prompt.** The New Epic
  card composes both through `composeEpicIntake` and sends the objective at creation; nothing rewrites
  `goalText` afterwards, because iteration belongs in follow-up messages and one short-lived Epic per unit of
  work is the intended shape. The queue row's `renameEpic` is a cosmetic carve-out (typo, clarity), never a
  repurposing.

## Settings is substrate, not per-Epic curation

- `Settings.tsx` and its siblings (Permissions/Hooks/MCP Servers/Skills) edit on-disk files at three scopes
  (`lib/scopes.ts`'s `SETTINGS_SCOPES`: `~/.claude/settings.json`, `<cwd>/.claude/settings.json`,
  `<cwd>/.claude/settings.local.json`) that the CLI reads on every invocation regardless of Epic. One TAB hosts
  many Epics, so a Project-scope edit changes the substrate for every current and future Epic in that project
  (User scope: machine-wide). `groundingBoard.ts` only reports that these files exist.
- **Rule: if behavior should differ per Epic or task, it is a Tag (`initialPromptTemplate`), an Agent persona,
  or a future PRD — never a plain Settings edit.** Settings holds what is identical for the scope regardless of
  task: permissions, hooks, MCP servers, env vars, output style, default effort/reasoning mode.
- **`model` and `effort` are the carve-outs**, carried per-Epic by the persona's frontmatter (Agent Library's
  catalog-driven rows; `inherit` writes no line). `settings.json`'s `effortLevel` stays the substrate default
  and cannot hold session-only levels like `max`. Settings' "Model & Reasoning" card is advanced/raw-JSON-only
  because its one per-Epic field, `model`, is edited from the persona editor. Its other fields
  (`effortLevel`, `fastMode`, `alwaysThinkingEnabled`, …) are substrate-only.
- **`SystemPrompt.tsx` is User scope only** (`~/.claude/CLAUDE.md`). It is a HOME-face screen with no project
  context, so a project switcher could only dead-end or silently follow whichever project owned the active top
  tab; `<cwd>/CLAUDE.md` is contextual and discovered by the CLI from the session's cwd. Don't re-add the
  switcher.
- **That screen is a document set** rendered through `components/tabs/editor/DocumentEditorPane.tsx`: the root
  file plus every `@`-import in a selection-only left rail. Imports are editable through the same dirty-tracked
  store and SaveBar as the root (they are part of the prompt the CLI loads); only an unresolved import is
  read-only. The pane deliberately omits the Document Experience popover / Assistant rail, which spawn a
  background claude session via `useDocEdit` — a cost a config screen must not inherit.

## Lifecycle and creation

- **Lifecycle is the single `status` field**, specified once at
  [`../prompt-sessions/README.md#lifecycle`](../prompt-sessions/README.md#lifecycle). Every Epic is born
  `proposed`, and nothing is spent until someone presses **Approve & start** (`EpicApprovalBar`), which sends
  `openingPrompt` (falling back to `goalText`) as the first message.
- **SINGLE-CREATOR LAW: an Epic is created in exactly one place — a human pressing New Epic**, plus one narrow
  second door for inbound cross-project feedback. Enforced fail-closed in `src/main/lib/epic/epicMint.cjs`:
  `ensureEpic()` is join-only except for `promptSessionsCreateEpic.cjs` (`MINT_AUTHORITY_NEW_EPIC_UI`) and
  `crossProjectFeedback.cjs` (`MINT_AUTHORITY_CROSS_PROJECT_FEEDBACK`). `MINT_AUTHORITIES` is the full
  two-entry list; a third is a domain-model change, not a convenience. Anyone else asking for a missing Epic
  gets a throw plus an `epic_mint_refused` audit event.
- **There is no agent-facing proposal channel.** An agent sure that work is needed runs `/develop` inside the
  Epic it is already in — PRDs join an existing Epic, they never conjure one. An agent that is unsure says so
  and lets the human open an Epic.
- **Project-to-project feedback lands as a `proposed` Epic in the RECEIVING project.**
  `crossProjectFeedback.cjs` is the only conduit, because the app's main process is the single process
  legitimately holding several projects' operations roots. Surface: the `feedback_open_session` /
  `feedback_list_projects` MCP tools (`scripts/scheduler-mcp-server.cjs` → `POST /admin/feedback/open-session`,
  `GET /admin/feedback/targets`) and the `session-manager-dev:send-feedback` skill. Only a `proposed` Epic
  lands, so a human in the receiving project still spends anything by pressing Approve & start.
  `toCwd === fromCwd` is rejected (the error names `/develop`); both cwds go through `validatePath`, both must
  be real directories, and the target must already have a `session-manager-operations/` dir. Provenance rides
  on the Epic (`EpicSource.producer: 'cross-project-feedback'` + `fromCwd`/`fromEpicId`), which
  `lib/epicOrigin.ts` renders as a chip so the receiving human sees the claim came from an agent that never
  read their codebase. There is no reply channel; a receipt event chained onto the sending Epic is the whole
  loop.
- **Verified human request auto-starts a cross-project proposal.** The mint is unchanged — the Epic is still born
  `proposed`. When the tool call carries `autoStart: true` + `humanRequestQuote`, main stamps `source.autoApprove`
  only if the quote is verified, and the receiving renderer then approves and starts it through the normal
  `approveProposed` path. Verification is fail-closed; anything unverifiable degrades to the ordinary proposal:
  - `humanPromptLedger` is fed only by `chat:run` prompts with origin `'human'`. Terminal-view and Web Remote
    prompts never reach it, so they do not qualify.
  - The quote must appear verbatim in a human prompt, from the originating chat session, that names the target
    project.
  - Identity is `SM_CHAT_SESSION_ID` (MCP env, set only for interactive chat runs), so a scheduler job has no
    identity to match and can never auto-start. Agent-initiated proposals still wait for a human.
- **A scheduler job's question comes back to the session that wrote the PRD.** A `needs_review` park is a
  question, not a result: `lib/scheduler/rcaReport.cjs` writes a root-cause report beside the run log and
  `scheduler.cjs`'s `notifyNeedsReview` appends it as a `response` event on the authoring Epic (resolved from
  `sourcePromptId`, falling back to the job's `epicId`). Join-only — with no open authoring Epic, the report and
  the Scheduler tab are the whole record. This is why PRDs must be written to the point.

## Scheduler as a browser over TAB → EPIC → PRD

- The Scheduler tab is a viewer/operator surface scoped to the active TAB's project ("All projects" is the
  explicit machine-wide escape hatch). Its nav row is **PROJECT-face only** (`navGroups.ts`) because every
  route it renders is cwd-derived; a Home-face copy could only show a federated view, which is deliberately not
  built. Home still reports queue state, and those links route through `openPanel`, which asserts
  `navFace: 'project'` for any PROJECT-only NavKey (`isProjectOnlyNavKey`).
- On disk, per project: PRD sources in `scheduler/epics/<epic-id>/prds/` (every new PRD mints or joins an Epic
  via `epicMint.cjs`), queue + history shards in `scheduler/state/` (`queueStore.cjs`). A flat `scheduler/prds/`
  is auto-consolidated into `prds-archived/` at the top of every `reconcile()` pass, so a file dropped there
  while the app runs is swept before it can become a queue row. Machine-level state is runtime only:
  `~/.claude/session-manager/scheduler-machine.json`, run logs under `scheduled-plans/runs/`, and the session
  slot pool (`lib/scheduler/sessionSlots.cjs`) — the one machine-wide pool every scheduler job and chat run acquires from.
- **PRD authoring is API-only.** `scheduler_create_prd` validates frontmatter, atomically allocates `NN`, and
  enforces the Epic-join rule. A hand-written PRD is never sanctioned (`audit-ops-hygiene.cjs` and `ops-sweep`
  flag one); with the app not running, the agent stops and asks the human to start it.

## Single-writer law

Every `session-manager-operations/<namespace>/` has exactly one owning writer and everyone else reads,
enforced fail-closed in `src/main/lib/opsOwnership.cjs`: an undeclared writer, or a namespace with no owner,
throws. The `OWNERS` map in that file and [`../CLAUDE.md`](../CLAUDE.md) are the only enumerations of
namespaces, owners, and retention; adding a namespace or writer is a deliberate edit to that file, with each
owned namespace's README documenting its on-disk shape.

Owned namespaces are app runtime state where two racing writers would corrupt a JSON source of truth; the
skill-authored folders have one author per invocation and no such hazard, so no catch-all `general` namespace
exists to blur the two. See [`ops-maintenance-protocol.md`](ops-maintenance-protocol.md) for the drift caused
by skipping the same-PR registration of a new folder.

## Open-core and the relay

- **The APP and the Field Manual are both free.** No license check, entitlement gate, trial limit, nag, or
  "pro" tier, and no feature or chapter moves behind a purchase; the open-core pricing rule lives in the
  manual's own README.
- **The bilko.run relay stays live** — bridge `src/main/webRemote.cjs`, UI Settings → Phone remote. The relay,
  its routes, and the product-page copy in `~/Projects/Bilko/` are not decommissioned.
