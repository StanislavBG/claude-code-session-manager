/**
 * mcpToolCatalog.cjs — single source of truth for what every
 * session-manager-scheduler MCP tool does, when to reach for it, and when
 * NOT to. Before this file, that knowledge lived only inside hand-written
 * `description` strings in scripts/scheduler-mcp-server.cjs's TOOLS array —
 * invisible to the app, the Home tab, the manual, and to a human debugging
 * why a session went off-piste. scheduler-mcp-server.cjs now BUILDS each
 * tool's live `description` from this catalog via composeDescription(), so
 * the two can never drift.
 *
 * Plain CJS, no Electron dependency — requirable from both the main process
 * and the standalone `node scripts/scheduler-mcp-server.cjs` process, same
 * constraint workTypeLibrary.cjs already satisfies (see that file's header).
 *
 * Composition rule (also asserted in mcpToolCatalog.test.cjs): a tool's live
 * description is `[purpose, whenToUse, whenNotToUse, notes].filter(Boolean)
 * .join(' ')` — deterministic, so a catalog edit provably reaches the live
 * MCP tool list with no separate hand-edit required.
 */
'use strict';

const { z } = require('zod');

const CatalogEntrySchema = z.object({
  name: z.string().min(1),
  group: z.enum(['scheduler', 'chat', 'feedback', 'help', 'project-home']),
  purpose: z.string().min(1),
  whenToUse: z.string().min(1),
  whenNotToUse: z.string().min(1),
  exampleArgs: z.record(z.string(), z.unknown()),
  notes: z.string().nullable(),
});

const RecipeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
});

const MCP_TOOL_CATALOG = [
  {
    name: 'scheduler_reset_job',
    group: 'scheduler',
    purpose: "Reset a stuck scheduler job by slug via the session-manager app's admin API.",
    whenToUse: 'Use after diagnosing why a job is stuck (e.g. via scheduler_get_prd/scheduler_list_jobs) and deciding it should re-run from pending.',
    whenNotToUse: 'Do not use as a first move on a "needs_review" job without reading it first — reset just clears status, it does not answer the question the job raised.',
    exampleArgs: { slug: 'add-mcp-tool-catalog', force: false },
    notes: 'Refuses a job whose status is already "completed" unless force:true is passed — resetting a completed job re-executes already-shipped work.',
  },
  {
    name: 'scheduler_list_jobs',
    group: 'scheduler',
    purpose: "List scheduler jobs via the session-manager app's admin API.",
    whenToUse: 'Use for a quick overview of live queue-row status (pending/running/completed/failed/needs_review) across the machine.',
    whenNotToUse: 'For PRD content (frontmatter/body) rather than just job status, or for filtering by cwd/Epic, use scheduler_list_prds instead.',
    exampleArgs: {},
    notes: null,
  },
  {
    name: 'scheduler_create_prd',
    group: 'scheduler',
    purpose: 'THE ONLY SANCTIONED WAY to author a PRD. Write a new PRD file via the '
      + "session-manager app's admin API. Server-side validates the frontmatter, "
      + 'atomically allocates the NN parallel-group number, appends the engineering '
      + 'standards, and writes the PRD file to disk. This tool ONLY writes the file — '
      + 'it does not create a scheduler queue row. The queue row is derived '
      + "automatically by the scheduler's next reconcile pass (typically within ~1 "
      + 'minute); the response has `enqueued: false` for exactly this reason. Every PRD '
      + 'must join an EXISTING, already-human-approved Epic (pass sourcePromptId) — this '
      + 'tool never mints a new one, and refuses the write if no Epic can be resolved. '
      + '`cwd` is OPTIONAL when called from inside an Epic session (chat or terminal, '
      + 'including from inside that Epic\'s own git worktree pwd): the server resolves '
      + 'the real project from the calling session\'s sourcePromptId/originClaudeSessionId, '
      + 'never from a worktree\'s own possibly-stale active-index.json snapshot. '
      + '`tag` and `agentType` are two DIFFERENT, independent fields — `tag` is WHAT KIND '
      + 'of work this PRD is (feature/bug/build/...); `agentType` is WHO executes it (a '
      + 'persona name, e.g. "dev-lead"). `agentType` defaults to "dev-lead" when omitted, '
      + 'and is rejected at write time if it does not name a real persona file.',
    whenToUse: 'Use whenever new work should be queued into an already-approved Epic — this is the /develop path.',
    whenNotToUse: 'TWO DISTINCT FAILURE MODES if this tool is not usable — do not conflate them: '
      + '(a) this tool call is PRESENT in your tool list but ERRORS as app-not-running / admin '
      + 'API unreachable — that is the ONLY case where hand-authoring the PRD file directly on '
      + 'disk is an acceptable DEGRADED, LAST-RESORT fallback; the caller MUST say so explicitly '
      + 'and visibly in its report (which file, why the tool was unreachable, that it needs '
      + 'verification) since the server-side validation, atomic NN allocation, and '
      + 'Epic-existence check this tool performs did not run for that file. '
      + '(b) this tool is ABSENT from your tool list entirely — you were never offered it, so '
      + 'there is no error to catch. That means the session-manager-scheduler MCP server is not '
      + 'registered for this project: a MISCONFIGURATION, not an offline app. In that case DO '
      + 'NOT hand-write any PRD file — stop and tell the human the MCP server is not registered '
      + '(fix: `claude mcp add session-manager-scheduler --scope user -- node '
      + '<session-manager-repo>/scripts/scheduler-mcp-server.cjs`, once at user scope covers '
      + 'every project).',
    exampleArgs: {
      title: 'Add unit tests for the retry backoff helper',
      cwd: '/home/bilko/Projects/session-manager',
      estimateMinutes: 30,
      goal: 'Cover retryWithBackoff.cjs edge cases (zero retries, max-delay clamp) that currently have no test.',
      acceptanceCriteria: ['New test file exercises zero-retry and max-delay-clamp cases', 'timeout 300 npm run typecheck passes', 'timeout 600 npm run test:unit passes'],
      implementationNotes: 'See src/main/lib/retryWithBackoff.cjs and its existing __tests__ sibling for the pattern to extend.',
      sourcePromptId: 'epic-id-of-an-already-approved-session',
    },
    notes: 'See /develop.',
  },
  {
    name: 'scheduler_list_prds',
    group: 'scheduler',
    purpose: "THE ONLY SUPPORTED WAY to list scheduled PRDs (live + archived) via the session-manager app's admin API. "
      + 'Each entry includes its real job status (pending/running/completed/failed/needs_review, or null if not yet '
      + 'queued/reconciled). Optionally filter by project cwd, Epic id, and/or status. Results are paginated (default '
      + 'limit 100, max 500) sorted by slug ascending — check `hasMore`/`total` in the response before assuming you '
      + "received every PRD; page further with `offset`. Default fields are compact (no parallelGroup/estimateMinutes/"
      + 'sourcePromptId/epicId/archivedStatus) — pass fields:"full" to restore them.',
    whenToUse: 'Use to survey PRDs by project/Epic/status before deciding which one to read, update, reset, or archive.',
    whenNotToUse: 'Do not assume a page without `hasMore` is the full result set without checking `total` — page further with `offset` first.',
    exampleArgs: { cwd: '/home/bilko/Projects/session-manager', status: 'needs_review' },
    notes: null,
  },
  {
    name: 'scheduler_get_prd',
    group: 'scheduler',
    purpose: "THE ONLY SUPPORTED WAY to read one PRD's full body + parsed frontmatter (live or archived) via the "
      + "session-manager app's admin API.",
    whenToUse: 'Use before editing/resetting a PRD, or to answer what a needs_review job actually asked.',
    whenNotToUse: 'For a fleet-wide overview instead of one PRD, use scheduler_list_prds.',
    exampleArgs: { slug: 'add-mcp-tool-catalog' },
    notes: null,
  },
  {
    name: 'scheduler_update_prd',
    group: 'scheduler',
    purpose: "THE ONLY SUPPORTED WAY to edit a NOT-yet-running PRD's frontmatter and/or body via the session-manager "
      + 'app\'s admin API. Refuses once a queue row exists for the slug and its status is anything but "pending" '
      + '(running/completed/failed/needs_review) — editing the spec under a live or already-finished executor is refused, '
      + 'not silently applied. Only recognized frontmatter keys (title, cwd, estimateMinutes, parallelGroup, '
      + 'sourcePromptId, sourceTabId, tag) may be patched; unrecognized keys (e.g. dependsOn) round-trip unchanged.',
    whenToUse: 'Use to correct a PRD scope/estimate/tag before it starts running — e.g. before resetting a needs_review job whose spec needs to change.',
    whenNotToUse: 'Do not use once the job is running or terminal (completed/failed/needs_review) without first resetting it back to pending — the route refuses the edit.',
    exampleArgs: { slug: 'add-mcp-tool-catalog', frontmatter: { estimateMinutes: 45 } },
    notes: null,
  },
  {
    name: 'scheduler_archive_prd',
    group: 'scheduler',
    purpose: "THE ONLY SUPPORTED WAY to archive one or more PRDs (move to prds-archived/) via the session-manager "
      + "app's admin API.",
    whenToUse: 'Use once a batch of PRDs is done and should stop showing up in default (live) listings.',
    whenNotToUse: 'Do not archive a PRD you still expect to reset/re-run — archived PRDs are not part of the live scheduling loop.',
    exampleArgs: { slugs: ['add-mcp-tool-catalog'] },
    notes: null,
  },
  {
    name: 'scheduler_cancel_job',
    group: 'scheduler',
    purpose: "THE ONLY SUPPORTED WAY to cancel a not-yet-terminal scheduler job via the session-manager app's admin "
      + 'API. A running job is SIGTERM\'d; a pending job is simply retired. There is no "cancelled" job status, so a '
      + 'cancelled job lands as "failed" with an error naming the cause. Refuses a slug whose job is already terminal '
      + '(completed/failed/needs_review) — nothing to cancel.',
    whenToUse: 'Use to stop a running or pending job that should not continue (e.g. it was queued in error, or scope changed underneath it).',
    whenNotToUse: 'Do not use on an already-terminal job (completed/failed/needs_review) — use scheduler_reset_job if it should run again.',
    exampleArgs: { slug: 'add-mcp-tool-catalog' },
    notes: null,
  },
  {
    name: 'scheduler_retag_prd',
    group: 'scheduler',
    purpose: "THE ONLY SUPPORTED WAY to rewrite a PRD's parallelGroup and/or estimateMinutes frontmatter (and, if "
      + "parallelGroup changes, its NN- filename prefix) via the session-manager app's admin API.",
    whenToUse: 'Use to correct an estimate or renumber a PRD file after it was created.',
    whenNotToUse: 'Do not use parallelGroup as an ordering/dependency barrier — it is only a unique-per-PRD display hint; use dependsOn on scheduler_create_prd/scheduler_update_prd for real ordering.',
    exampleArgs: { items: [{ slug: 'add-mcp-tool-catalog', estimateMinutes: 30 }] },
    notes: null,
  },
  {
    name: 'chat_send_prompt',
    group: 'chat',
    purpose: "Push a prompt into an already-open tab's chat queue via the session-manager app's admin "
      + 'API. The renderer resolves the tab (must currently be open) and runs the prompt through '
      + 'the same queued-vs-immediate path as a manual send.',
    whenToUse: 'Use to programmatically continue a conversation in a tab that is already open in the running app.',
    whenNotToUse: 'Do not use to start new work in a project you are not already chatting in — that is /develop (scheduler_create_prd) or feedback_open_session.',
    exampleArgs: { tabId: 'a1b2c3d4-tab-id', prompt: 'Please continue with the next step.' },
    notes: 'No-ops if the tab is unknown/closed.',
  },
  {
    name: 'feedback_list_projects',
    group: 'feedback',
    purpose: 'List the OTHER projects on this machine that can receive feedback (i.e. that Session Manager '
      + 'already manages — they have a session-manager-operations/ directory).',
    whenToUse: "Call this FIRST when you need the exact `toCwd` for feedback_open_session and are not certain of it — never guess a path.",
    whenNotToUse: 'A project missing from this list has simply never been opened in Session Manager; ask the human to open it once rather than inventing a path.',
    exampleArgs: {},
    notes: null,
  },
  {
    name: 'feedback_open_session',
    group: 'feedback',
    purpose: 'THE ONLY SANCTIONED WAY to hand a finding from THIS project to a DIFFERENT project. Opens a new '
      + "PROPOSED session in the receiving project's own Sessions queue, carrying your report as its "
      + 'opening prompt and stamped with where it came from. Session Manager performs the cross-folder '
      + 'write; you never write another project\'s files yourself.',
    whenToUse: 'Use when work in this project surfaces something that is genuinely another project\'s to fix. '
      + 'Write the report for a reader who has never seen your project: state the symptom, where you '
      + 'observed it, what you expected, and (if you know) the file in THEIR repo that looks responsible. '
      + 'Never assume they can see your code.',
    whenNotToUse: 'WHEN NOT TO USE IT: for work in the project you are ALREADY in, run /develop inside the Epic you '
      + 'are already in — this tool refuses toCwd === fromCwd outright.',
    exampleArgs: {
      toCwd: '/home/bilko/Projects/other-project',
      fromCwd: '/home/bilko/Projects/session-manager',
      title: 'Cross-project contract mismatch in the shared admin API',
      body: 'Symptom: X. Observed while doing Y in session-manager. Expected: Z. Suspected file: <path in their repo>.',
    },
    notes: 'WHAT THIS DOES NOT DO: it does not start anything, queue a PRD, or spend a token. The session '
      + 'lands as `proposed` and runs only if a human in the RECEIVING project presses "Approve & start". '
      + 'There is no callback and no reply channel — do not wait for an answer, and do not tell the user '
      + 'the other project has "been fixed" or "is working on it". Report only that the proposal was '
      + 'delivered.',
  },
  {
    name: 'project_home_get_contract',
    group: 'project-home',
    purpose: "Fetch the self-sufficient contract for generating this project's Project Home pages via the "
      + "session-manager app's admin API — the protocol steps, the ProjectPageSummary/ProjectPagePicks JSON "
      + 'schemas, the component catalog (all 5 lenses: home, marketing, feature, architecture, brief), the '
      + 'absolute output paths, and the full pipeline spec text. Nothing in the response requires reading '
      + "session-manager's own repo — this is what makes generation work on a machine with only the npm "
      + 'package installed.',
    whenToUse: 'Call this FIRST, before composing any ProjectPageSummary content or picking variants, whenever '
      + 'a project-home-builder session starts generating Project Home pages for a project.',
    whenNotToUse: 'Do not begin composing a ProjectPageSummary or choosing variants before calling this — it '
      + 'must be the FIRST call a project-home-builder session makes; every other project_home_* tool assumes '
      + "you already have this response's schema/catalog/paths in hand.",
    exampleArgs: { cwd: '/home/bilko/Projects/session-manager' },
    notes: "cwd is optional — defaults to the calling session's own project root (SM_PROJECT_ROOT or process.cwd()) when omitted.",
  },
  {
    name: 'project_home_validate_summary',
    group: 'project-home',
    purpose: 'Validate a composed ProjectPageSummary against the schema from project_home_get_contract via the '
      + "session-manager app's admin API, without writing anything to disk.",
    whenToUse: 'Use after composing (or editing) a ProjectPageSummary and before calling project_home_render — '
      + 'fix every returned {field, message} error and re-validate until valid:true.',
    whenNotToUse: 'Do not skip straight to project_home_render on an unvalidated summary — render does '
      + 're-validate server-side and rejects with no writes on failure, but catching errors here first saves a '
      + 'round trip and gives per-field detail sooner.',
    exampleArgs: { cwd: '/home/bilko/Projects/session-manager', summary: { title: 'Example Project' } },
    notes: "cwd is optional — defaults to the calling session's own project root (SM_PROJECT_ROOT or process.cwd()) when omitted.",
  },
  {
    name: 'project_home_render',
    group: 'project-home',
    purpose: 'Render and write all 5 Project Home lenses (home, marketing, feature, architecture, brief) plus '
      + "summary.json/picks.json/manifest.json via the session-manager app's admin API — the only write path "
      + 'for Project Home generation.',
    whenToUse: 'Use once project_home_validate_summary reports valid:true and a variant has been picked for '
      + "every lens/slot in the contract's catalog.",
    whenNotToUse: 'Must NOT be used to fabricate summary content — every field of the summary passed here must '
      + 'trace to something concrete about the real project (an Epic goal, a source file/dir, a convention, a '
      + 'git log entry). This tool re-validates the summary server-side and rejects with no writes on schema '
      + 'failure, but it only checks shape, never truthfulness.',
    exampleArgs: {
      cwd: '/home/bilko/Projects/session-manager',
      summary: { title: 'Example Project' },
      picks: { home: { hero: 'variant-a' } },
    },
    notes: "cwd is optional — defaults to the calling session's own project root (SM_PROJECT_ROOT or process.cwd()) when omitted.",
  },
  {
    name: 'project_home_status',
    group: 'project-home',
    purpose: "Report what already exists for this project's Project Home generation via the session-manager "
      + "app's admin API — summary.json/picks.json/each lens file's existence + mtime, and manifest.json's "
      + 'generatedAt.',
    whenToUse: 'Use before starting generation to see prior state, and again after project_home_render to '
      + 'confirm the new files landed.',
    whenNotToUse: 'Do not treat an all-absent result as an error — a project that has never generated a '
      + 'Project Home page yet still returns a well-formed status with every exists:false rather than failing.',
    exampleArgs: { cwd: '/home/bilko/Projects/session-manager' },
    notes: "cwd is optional — defaults to the calling session's own project root (SM_PROJECT_ROOT or process.cwd()) when omitted.",
  },
  {
    name: 'session_manager_help',
    group: 'help',
    purpose: 'THE ENTRY POINT — call this tool FIRST whenever you are unsure which session-manager-scheduler '
      + 'tool to reach for, or a call to this server just failed. Returns the same tool catalog every other '
      + "tool's description is composed from, this project's multi-tool recipes, and this machine's "
      + 'delegation-readiness state (tells apart "not registered", "registered but dead" — the process '
      + 'won\'t even answer tools/list — and "registered and answering").',
    whenToUse: 'Call with no arguments for the full grouped tool list plus recipe titles. Pass `tool` (a tool '
      + 'name) for that one tool\'s full entry, including its exampleArgs. Pass `topic` (a recipe id) for that '
      + 'recipe\'s step-by-step instructions. Pass both to get both sections in one call.',
    whenNotToUse: 'Do not use this to actually perform scheduler/chat/feedback work — it is read-only '
      + "documentation and never a substitute for calling the tool it describes.",
    exampleArgs: {},
    notes: 'Always returns the static catalog even when the session-manager app is not running — only the '
      + '`readiness` section of the response depends on the admin API being reachable.',
  },
];

const MCP_RECIPES = [
  {
    id: 'queue-work-via-develop',
    title: 'Queue work into an already-approved Epic (/develop)',
    steps: [
      'Confirm an Epic already exists for this work (proposed or active) — scheduler_create_prd never mints one.',
      'Call scheduler_create_prd with sourcePromptId set to that Epic id, plus title/cwd/estimateMinutes/goal/acceptanceCriteria/implementationNotes.',
      'The response has enqueued:false — the queue row is derived by the scheduler\'s next reconcile pass (~1 minute), not by this call.',
      'Optionally call scheduler_list_prds with cwd/status to confirm the PRD picked up a job row.',
    ],
  },
  {
    id: 'unstick-needs-review-job',
    title: 'Unstick a job stuck in needs_review',
    steps: [
      'Call scheduler_list_prds with status:"needs_review" (or scheduler_list_jobs) to find the stuck slug.',
      'Call scheduler_get_prd with that slug to read its full frontmatter + body and understand the question it raised.',
      'If the PRD spec needs to change, call scheduler_update_prd with the slug and a frontmatter/body patch — this is only accepted while the job is not yet running or terminal.',
      'Call scheduler_reset_job with { slug } to clear the needs_review status back to pending — force is only required if the job had already reached "completed".',
      'The next scheduler reconcile pass re-queues the job; confirm with scheduler_list_jobs or scheduler_list_prds.',
    ],
  },
  {
    id: 'hand-finding-to-another-project',
    title: 'Hand a finding to another project',
    steps: [
      'Call feedback_list_projects to get the exact toCwd for the receiving project — never guess a path.',
      'Call feedback_open_session with toCwd, fromCwd, a one-line title, and a self-contained body (symptom, where observed, expected behavior, suspected cause).',
      'The call only delivers a PROPOSED session in the receiving project — nothing runs until a human there presses Approve & start; there is no reply channel.',
    ],
  },
  {
    id: 'generate-project-home',
    title: "Generate a project's Project Home pages",
    steps: [
      "Call project_home_get_contract to get the protocol, ProjectPageSummary/ProjectPagePicks schemas, "
        + 'component catalog, absolute output paths, and pipeline spec — the FIRST call any '
        + 'project-home-builder session makes.',
      'Author a ProjectPageSummary matching the contract\'s summarySchema — every field must trace to '
        + 'something concrete about the real project; never fabricate content.',
      'Call project_home_validate_summary with { cwd, summary } and fix every {field, message} error it '
        + 'returns, re-validating until valid:true.',
      "For each lens and slot in the contract's catalog, choose exactly one variant id by judging the "
        + 'candidate variants against the summary you composed, assembling a ProjectPagePicks object '
        + '(lensId -> slotId -> variantId).',
      'Call project_home_render with { cwd, summary, picks } to render all 5 lenses and write '
        + 'summary.json/picks.json/output files.',
      "Call project_home_status to confirm the new files landed and read manifest.json's generatedAt.",
    ],
  },
];

for (const entry of MCP_TOOL_CATALOG) {
  CatalogEntrySchema.parse(entry);
}
for (const recipe of MCP_RECIPES) {
  RecipeSchema.parse(recipe);
}

function composeDescription(entry) {
  return [entry.purpose, entry.whenToUse, entry.whenNotToUse, entry.notes].filter(Boolean).join(' ');
}

module.exports = {
  MCP_TOOL_CATALOG,
  MCP_RECIPES,
  CatalogEntrySchema,
  RecipeSchema,
  composeDescription,
};
