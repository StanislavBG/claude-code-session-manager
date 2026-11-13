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
  (`state/promptSessions.ts`). It carries an optional `agentType`, an optional `tag` and its `goalText`. The tag also sets how
  eagerly `/develop` fires inside the Epic's session (the `session-manager-dev:develop` skill's "Tag-aware
  default"): `feature`/`bug` treat PRD decomposition as the expected next step, `discussion` keeps it
  available but never assumed.
- **"Sessions" is the user-facing name; `Epic`/`PromptSession` is the code name.** Every UI surface says
  *session* because that is what an Epic is: a tagged claude session opened through AIM. `PromptSession`,
  `EpicTag`, `epicId`, every `epic-*` testid and every on-disk path (`scheduler/epics/<epic-id>/`) keep the
  code name — don't carry the label change into identifiers.
- **EPIC : claude-session = 1:1.** The 1:1 is with the Epic's agent-CLI session — Claude Code by default, or
  another CLI ([Agent CLI](#agent-cli)). `claudeSessionId` stays the app-level id either way. Each Epic mints its
  own `claudeSessionId`, never shared with or derived from a SessionTab's. **Chat and Terminal are two views over that one session**: Chat is headless
  `claude -p --resume <id>` via chatRunner, Terminal is interactive PTY `claude --resume <id>` in the Epic's
  cwd. Switching views hands the session off (mutually exclusive attachment) instead of minting a new
  sessionId, because context continuity across the switch is the invariant. The event chain
  (`prompt → prd_created → response → closed`, linked by `causedByEventId`) is the auditable trace of
  everything the Epic spawned. The one exception to minting is a **restored Epic** (`restoredSession: true`):
  it adopts an existing CLI session of the same project that no Epic or SessionTab owns instead of minting one,
  so a conversation begun in the plain CLI carries on as an Epic. It is still minted only by a human's New
  Session press and is still 1:1 (`epicMint.cjs`'s restore gate; candidates from `restorableSessions.cjs`).
- **Active Epics run in their own `git worktree`** (branch `sm-epic/<id>`, `gitWorktree.cjs`'s
  `createEpicWorktree`, created at `proposed → active`) so concurrent Epics on one project don't clobber each
  other's uncommitted edits; Terminal PTY and headless Chat both resolve their spawn cwd to it
  (`epicSpawnCwd.cjs`). Isolation folds back at exactly one checkpoint, `markCompleted`'s merge-before-archive
  step (`epicWorktreeMerge.cjs`'s `integrateEpicBranch`: ff-only → linear replay → merge-commit fallback → abort-and-flag;
  [when a merge commit still lands](scheduler-operations.md#5a-landing--linear-by-default-and-every-case-that-can-still-write-a-merge-commit)). A real
  conflict sets `worktree.status` to `needs_merge_resolution` (EpicDetail's banner, "Resolve in Terminal")
  rather than blocking anything. Settings' project scope holds the per-project opt-out. A restored Epic stays
  in the project checkout: `epicWorktreeMint.cjs` refuses `restoredSession` Epics at approve and reopen,
  because the adopted transcript is filed under the checkout's `~/.claude/projects` encoding and its history
  (and any uncommitted work) refers to that checkout — `planEpicSpawn` resumes it from the project cwd, so a
  worktree would sit unused while its queue row falsely showed isolation.
- **Persistence:** active Epics in `session-manager-operations/prompt-sessions/active-index.json`; completed ones archived one JSON per
  Epic in the same folder. Resume reopens the same Epic in place (same id and
  claudeSessionId, full history) — see [lifecycle](../prompt-sessions/README.md#lifecycle).
- **The Changes tab is a VIEW of an Epic inside `EpicDetail`** (no LeftNav entry; one read API, `epicChanges:get`).
  Its line comments go back to the Epic's own session as ONE follow-up chat message — never a new Epic or PRD,
  because review is iteration within the Epic (single-creator law).

## Agent + Tag, and the AIM prompt

- **Epic creation is two independent selections.** `agentType` (Actor — a persona from the Agents page,
  `~/.claude/agents/*.md`) and `tag` (Mission — what the Epic is for) are separate axes on `PromptSession`.
  Either may be None (see [Plain sessions](#plain-sessions)). The `tag` taxonomy is a closed union.
- **Both libraries live on one page, Agents (`AgentLibrary.tsx`, NavKey `agent-library`).** Its Personas tab is a
  full CRUD editor (`agentLibrary.cjs`'s `savePersona`/`deletePersona`/`removeOverride`) — don't describe it as
  read-only. Its Tags tab (`TagLibrary.tsx`) IS read-only: the closed taxonomy, each tag's opening framing, and
  the personas that carry it; a persona link there opens that persona on the Personas tab.
- **Tags are edited only on the persona.** Persona↔tag membership is many-to-many with one source of truth: each
  persona's `tags:` frontmatter (`AgentPersona.tags`), set in the persona editor's `tags` field and written
  through `savePersona`. The Tags tab only reads it back and never writes a persona file, so no second editor
  can drift from the first.
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
  `lib/epicIntake.ts`'s `composeEpicIntake` into `openingPrompt` (never `goalText`). Three slots, parts in
  emission order: **Actor** = persona (identity line + body; the frontmatter description only when there is no
  body); **Input** = grounding line (`lib/groundingBoard.ts`'s `summarizeGroundingBoard` over the real
  System/Project/Local inventory, computed fresh by `computeGroundingBoard` at submit if the board wasn't
  opened), Context Injections, attached references; **Mission** = the tag's job-type framing
  (`initialPromptTemplate`), then the human's goal (one slot, not separate blocks). Every part is independently
  optional and omitted when absent; an Epic with neither an Actor nor a Mission gets no grounding line.
  Framing only: Input stays real-data-derived and never becomes a second source of truth for what the `claude`
  CLI loads.
  - **Persistence:** sections store as `kind` = slot plus part (`EpicIntakeSection` in
    `src/renderer/lib/epicIntake.ts`). Epics stored with the 7 pre-AIM kinds stay valid and render through
    `toAimSections`. **Never narrow the stored kind enum** — `dropInvalidSessions` drops a whole Epic that fails
    the schema.
  - **Where the Actor comes from:** `~/.claude/agents/<name>.md` merged with the project overlay by
    `personaMerge.cjs`'s `resolveMergedPersona` — the frontmatter description and the markdown body. The body is
    pasted into the opening prompt because Claude Code loads an agent file's body only when it runs as a
    subagent.
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
  single-creator law is untouched: a human still presses the button. Agents reach the same library through
  macro_list, macro_save and macro_delete. macro_delete acts only for the calling session's own project and only
  in a session a human is attached to: a macro's last project deletes it, and any other project only drops itself,
  so one project never takes a button from another. A macro shown in every project, which includes every Project
  Home tool, is never removed by an agent's macro_delete; the human deletes it everywhere from the HOT KEYS manage
  panel ('Delete from every project?') or the macro editor's Delete everywhere.
  An xhigh/max persona makes every press open MacroCostDialog (useMacroCostPrompt, mounted once in App.tsx);
  'Run at <lower>' (default medium) is per launch: chat Epic `effort` override or build PRD `effort`
  frontmatter (in-process only; resolveEpicEffort's 'prd' rung outranks the persona); no macro or persona is edited.
- **A Project Home tool is app-level, not per project.** A macro with `surface: 'project-home'` (Project Home ▸
  Tools, plus the Pages / Videos library built-ins) is part of Session Manager and shown in every project
  (`projects: ['*']`); only what it generates — pages, videos, the matrix, the Epics it opens — is per project.
  `macroLibrary.cjs` enforces it fail-closed: `widenProjectHomeScope` widens stored entries on load and `saveMacro`
  forces `['*']` on write; `macroAdminRoutes.cjs` makes an agent's save need a verified human quote naming Project
  Home (`quoteNamesProjectHome`). A tool every install should have ships as a built-in in `builtinMacros.cjs`
  (`builtin-cpu-audit`). Incident, 2026-11-07: an agent's macro_save left "CPU audit & fixes" on
  session-manager's Project Home only, missing from every other project. Project Home personas run unforked in
  every project, with no project overlay body (session-manager's project-home-builder overlay was removed on
  2026-11-08).
- **An Epic's title + objective are fixed for the life of its session, and are its first prompt.** The New Epic
  card composes both through `composeEpicIntake` and sends the objective at creation; nothing rewrites
  `goalText` afterwards, because iteration belongs in follow-up messages and one short-lived Epic per unit of
  work is the intended shape. The queue row's `renameEpic` is a cosmetic carve-out (typo, clarity), never a
  repurposing.

## Agent CLI

- **A third independent selection.** Besides Actor and Mission, New Session picks which agent CLI runs the
  session: `PromptSession.agentCli` (`codex`, `gemini`, `antigravity`, `cursor`, `opencode`). Absent = Claude
  Code. An optional `agentCliModel` goes to that CLI; absent = the CLI's own default. Both are fixed for the
  life of the session, like the title and objective. `epicMint.cjs`'s `agentCliMintFields` validates them.
- **Chat runs the CLI headless** through the adapters in `src/main/lib/agent-cli/` (`agentCliTurn.cjs` plans
  the turn, `adapters/<cli>.cjs` spawns it). Each adapter translates the CLI's own output into Claude
  `stream-json` events, so chatRunner, the Chat feed and the usage readers stay unchanged.
- **Terminal types one shell line** that main builds from the adapter (`agentCli:terminal-command` in
  `agentCliIpc.cjs`). It launches or resumes the CLI's own interactive session in the Epic's cwd.
- **State lives outside the ops root** (`agentCliSessionStore.cjs`), keyed by `claudeSessionId`: the CLI's
  native session id in `~/.claude/session-manager/agent-cli/sessions/<id>.json`, and the Claude-compatible
  feed in `~/.claude/session-manager/agent-cli/transcripts/<id>.jsonl`.
- **Limits of a non-Claude Epic:**
  - `developLoop` is always `false` (forced at mint), so it takes no PRDs.
  - No "Restore a session" — restore adopts a Claude Code session only; mint refuses the pair.
  - No persona `model`/`effort` — those are Claude flags and are never forwarded. Only `agentCliModel` is.
  - Turns typed in the Terminal stay in the CLI's own history. They do not appear in the app's feed, which
    records Chat turns only.
- **Claude-only surfaces:** macros (hot keys), phone launches and scheduler PRDs always run Claude Code. The
  agent-CLI IPC channels are desktop-only and not in the web-remote allowlist.

## Settings is substrate, not per-Epic curation

- The Settings page (`Settings.tsx`: General / Permissions / Hooks / Raw tabs) and the Extensions page (Skills /
  MCP Servers / Plugins tabs) edit on-disk files the CLI reads on every invocation regardless of Epic. Settings
  spans three scopes (`lib/scopes.ts`'s `SETTINGS_SCOPES`: `~/.claude/settings.json`,
  `<cwd>/.claude/settings.json`, `<cwd>/.claude/settings.local.json`): the Home-face page is User scope, and the
  Project face's Claude config page mounts the same component at Project or Local scope, beside that project's
  `.mcp.json`, `.claude/skills/`, `CLAUDE.md` / `CLAUDE.local.md` and memory folder. One TAB hosts many Epics,
  so a Project-scope edit changes the substrate for every current and future Epic in that project (User scope:
  machine-wide). `groundingBoard.ts` only reports that these files exist.
- **Rule: if behavior should differ per Epic or task, it is a Tag (`initialPromptTemplate`), an Agent persona,
  or a future PRD — never a plain Settings edit.** Settings holds what is identical for the scope regardless of
  task: permissions, hooks, MCP servers, env vars, output style, default effort/reasoning mode.
- **`model` and `effort` are the carve-outs**, carried per-Epic by the persona's frontmatter (the Agents page's
  catalog-driven rows; `inherit` writes no line). `settings.json`'s `effortLevel` stays the substrate default
  and cannot hold session-only levels like `max`. Settings' "Model & Reasoning" card is advanced/raw-JSON-only
  because its one per-Epic field, `model`, is edited from the persona editor. Its other fields
  (`effortLevel`, `fastMode`, `alwaysThinkingEnabled`, …) are substrate-only.
- **`SystemPrompt.tsx` (sidebar label "CLAUDE.md") is User scope only** (`~/.claude/CLAUDE.md`). It is a
  HOME-face screen with no project context, so a project switcher could only dead-end or silently follow
  whichever project owned the active top tab; `<cwd>/CLAUDE.md` is contextual and discovered by the CLI from the
  session's cwd, so it and `CLAUDE.local.md` are edited on the Project face's Claude config page (CLAUDE.md tab,
  Project / Local). Don't re-add the switcher.
- **The Agents page (`AgentLibrary.tsx`) is Home-face too, so for the same reason it never reads the active
  tab.** A persona's project override names its project explicitly from a picker of every open project (one per
  unique tab cwd), written via `agents.savePersona` with `projectCwd` and dropped via
  `agents.removeOverride({ name, projectCwd })`; no project is preselected or special.
- **The System Prompt screen is a document set** rendered through `components/tabs/editor/DocumentEditorPane.tsx`:
  the root file plus every `@`-import in a selection-only left rail. Imports are editable through the same
  dirty-tracked store and SaveBar as the root (they are part of the prompt the CLI loads); only an unresolved import
  is read-only. The pane deliberately omits the Document Experience popover / Assistant rail, which spawn a
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
  - `humanPromptLedger` is fed only by `chat:run` prompts with origin `'human'` (and the first prompt of a
    phone-started session, which goes through `launchSession`). Terminal-view prompts and later Web Remote
    prompts never reach it, so they do not qualify.
  - The quote must appear verbatim in a human prompt, from the originating chat session, that names the target
    project.
  - Identity is `SM_CHAT_SESSION_ID` (MCP env, set only for interactive chat runs), so a scheduler job has no
    identity to match and can never auto-start. Agent-initiated proposals still wait for a human.
- **A granted macro press also auto-starts a cross-project proposal.** Second ground beside the verified quote;
  the mint is still `proposed` and the receiving renderer approves it through the same `approveProposed` path
  (`source.autoApprove.requestedBy: 'macro'`). The human pressing the macro and listing the target is the consent:
  - The setting (`autoStartTargets`: Off / All / Selected) is set only in the macro editor. The agent passes no
    flag and no quote.
  - The sender Epic is resolved only from `SM_CHAT_SESSION_ID`, never from the agent-supplied `fromEpicId`, and
    must be a `new-epic-ui` Epic carrying a `macroId`. The receiving Epic's producer is
    `cross-project-feedback`, so it can never chain: one hop.
  - Limit of 5 grants per sending session (released if the mint fails). Bug and feature tags only.
  - PRD jobs stay proposal-only: a scheduler job has no chat session identity, so it matches no macro.
  - The auto-started Epic gets the full composed persona and mission opening prompt, a no-ask turn
    instruction (`autoStartedSession.cjs`), and, if its first turn leaves no PRD queued, exactly one automatic
    follow-up turn telling it to run `/develop`.
  - Anything denied (macro gone, target not allowed, wrong tag, limit hit) degrades to an ordinary proposal
    with the reason in the result.
- **A scheduler job's question comes back to the session that wrote the PRD.** A `needs_review` park is a
  question, not a result: `lib/scheduler/rcaReport.cjs` writes a root-cause report beside the run log and
  `scheduler.cjs`'s `flushDueReviewNotices` appends it as a `response` event on the authoring Epic (resolved from
  `sourcePromptId`, falling back to the job's `epicId`). Join-only — with no open authoring Epic, the report and
  the Scheduler tab are the whole record. This is why PRDs must be written to the point.

## Scheduler as a browser over TAB → EPIC → PRD

- The Scheduler tab is a viewer/operator surface scoped to the active TAB's project ("All projects" is the
  explicit machine-wide escape hatch). Its nav row is **PROJECT-face only** (`navGroups.ts`) because every
  route it renders is cwd-derived; a Home-face copy could only show a federated view, which is deliberately not
  built. Home still reports queue state, and those links route through `openPanel`, which asserts
  `navFace: 'project'` for any PROJECT-only NavKey (`isProjectOnlyNavKey`).
- On disk, per project: PRD sources in `scheduler/epics/<epic-id>/prds/` (every new PRD mints or joins an Epic
  via `epicMint.cjs`), queue + history shards in `session-manager-operations/scheduler/state/` (`queueStore.cjs`). A flat scheduler/prds/
  is auto-consolidated into `session-manager-operations/scheduler/prds-archived/` at the top of every `reconcile()` pass, so a file dropped there
  while the app runs is swept before it can become a queue row. Machine-level state is runtime only:
  `~/.claude/session-manager/scheduler-machine.json`, run logs under `~/.claude/session-manager/scheduled-plans/runs/`, and the session
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
- **The bilko.run relay stays live** — bridge `src/main/webRemote.cjs`, UI App Settings → Phone remote. The relay,
  its routes, and the product-page copy in `~/Projects/Bilko/` are not decommissioned.

## Plain sessions

A "plain" session is the closest thing to running a bare `claude`: only the System/Project/Local settings
context plus the chosen model/effort.

- **Agent None** — `agentType` absent; no persona is injected.
- **Mission None** — `tag` absent ("No mission"). The 7-tag union is unchanged; None is absence, not an 8th tag.
- **`developLoop?: false`** — fixed for the life of the session. It disables the dev plugin in Chat and
  Terminal launches, skips the delegate-implementation injection, makes the PRD API refuse PRDs for the Epic,
  and lets the inline-implementation guard allow edits. Absent/true = the normal develop loop.
- **Model** — an agentless Epic's model falls back to the Claude settings model (no persona frontmatter to win).
