/**
 * Zod schemas for all IPC handler payloads. Applied at the boundary between
 * renderer and main — rejects malformed data before it reaches any business
 * logic. Throws ZodError on violation (caught by Electron's IPC harness and
 * surfaced as a rejected promise to the renderer).
 */

const { z } = require('zod');
const os = require('node:os');
const path = require('node:path');
const { PromptSessionSchema, EpicTagSchema, EpicSourceSchema } = require('./lib/promptSessionSchema.cjs');

// ──────────────────────────────────────────── PTY
const ptySpawn = z.object({
  tabId: z.string().min(1).max(128),
  cwd: z.string().min(1).max(4096),
  cols: z.number().int().min(10).max(1000).optional(),
  rows: z.number().int().min(3).max(1000).optional(),
  startupCommand: z.string().max(8192).optional().nullable(),
});

const ptyTabId = z.object({ tabId: z.string().min(1).max(128) });

// PRD 833 C1: Epics-workspace reconcile — which of these session keys still
// have a live PTY? Bounded so the renderer can't ask about unbounded lists.
const ptyAlive = z.object({ tabIds: z.array(z.string().min(1).max(128)).max(500) });

// v2 mobile: subscribe to a session's live state + summary. cwd is needed to
// locate the transcript JSONL (transcriptPath); validated against home-dir boundary
// in webRemote before any fs access.
const sessionSubscribe = z.object({
  // tabId becomes a transcript FILENAME (`<tabId>.jsonl`) — restrict to a
  // session-id charset (no '/', no '.', so it can't traverse out of the project
  // transcript dir). sessionId is a UUID, which satisfies this.
  tabId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  cwd: z.string().min(1).max(4096),
});

// 64 KiB cap per pty:write — typewriter input is bounded; a renderer firing
// megabytes per call is either a bug or an attack. Block it at the boundary.
const PTY_WRITE_MAX_BYTES = 64 * 1024;
const ptyWrite = z.object({
  tabId: z.string().min(1).max(128),
  data: z.string().max(PTY_WRITE_MAX_BYTES),
});

const ptyResize = z.object({
  tabId: z.string().min(1).max(128),
  cols: z.number().int().min(10).max(1000),
  rows: z.number().int().min(3).max(1000),
});

// ──────────────────────────────────────────── Browser (WebContentsView embed)
// viewId is a renderer-generated identifier; restrict to a safe charset (no
// '/', no '.') since it keys the in-process Map<viewId, WebContentsView> —
// not used as a filesystem path, but kept consistent with tabId conventions.
const BROWSER_VIEW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const browserViewId = z.object({
  viewId: z.string().min(1).max(128).regex(BROWSER_VIEW_ID_RE),
});

const browserCreate = z.object({
  viewId: z.string().min(1).max(128).regex(BROWSER_VIEW_ID_RE),
  // Non-persistent partition string (PRD 400 run-mode isolation). No leading
  // 'persist:' enforced here — callers choose persistence explicitly.
  partition: z.string().min(1).max(256),
});

const BOUNDS_INT = z.number().int().min(0).max(100000);
const browserSetBounds = z.object({
  viewId: z.string().min(1).max(128).regex(BROWSER_VIEW_ID_RE),
  x: BOUNDS_INT,
  y: BOUNDS_INT,
  width: BOUNDS_INT,
  height: BOUNDS_INT,
});

const browserNavigate = z.object({
  viewId: z.string().min(1).max(128).regex(BROWSER_VIEW_ID_RE),
  url: z.string().min(1).max(8192),
});

// PRD 407: DOM/text capture from the active browser sub-tab.
const browserCaptureDom = z.object({
  viewId: z.string().min(1).max(128).regex(BROWSER_VIEW_ID_RE),
  kind: z.enum(['text', 'html']),
});

// PRD 404: filter -> prune -> summarize -> chunk capture of a picked
// selection (browser:capture). selectors comes from the PRD 403 picker.
const browserCaptureSelection = z.object({
  viewId: z.string().min(1).max(128).regex(BROWSER_VIEW_ID_RE),
  selectors: z.array(z.string().min(1).max(2048)).min(1).max(50),
  mode: z.enum(['agent', 'html', 'a11y', 'selector']),
});

// PRD 407: clipboard image write (browser:copy-image). dataUrl is a PNG data
// URL from webContents.capturePage() — capped well above any realistic
// screenshot so a malformed/huge payload can't wedge the IPC channel.
const browserCopyImage = z.object({
  dataUrl: z.string().min(1).max(50_000_000),
});

// Recorder export (PRD 412): write arbitrary recorded-flow text to the OS
// clipboard, separate from the image-only browserCopyImage above.
const clipboardWriteText = z.object({
  text: z.string().max(1_000_000),
});

// Recorder export (PRD 412): native "Save As" dialog write, bypassing the
// config.cjs write-boundary since the path is user-chosen via OS dialog.
const browserSaveRecording = z.object({
  defaultName: z.string().min(1).max(255),
  text: z.string().max(1_000_000),
});

// PRD 407: binary-safe atomic write (browser:save-binary) for screenshot
// captures — config:write-text is utf8-only.
const browserSaveBinary = z.object({
  path: z.string().min(1).max(4096),
  base64: z.string().min(1).max(50_000_000),
  // Single-writer law (lib/opsOwnership.cjs) — required for ops-root paths.
  writer: z.string().min(1).max(64).optional(),
});

// PRD 410: replay a recorded step list against a live view. The renderer
// owns the step list (main never persists recorded steps), so every call is
// self-contained. `select` is accepted for forward-compat even though the
// live recorder engine doesn't emit it yet.
const browserReplayStep = z.object({
  n: z.number().int().min(1),
  verb: z.enum(['navigate', 'click', 'type', 'select', 'wait-for']),
  target: z.string().max(2000),
  value: z.string().max(2000).optional(),
  variable: z.string().max(64).nullable().optional(),
  kind: z.enum(['nav', 'assert']).optional(),
  masked: z.boolean().optional(),
  variableSuggestion: z.string().max(64).optional(),
});

const browserReplay = z.object({
  viewId: z.string().min(1).max(128).regex(BROWSER_VIEW_ID_RE),
  steps: z.array(browserReplayStep).max(500),
  values: z.record(z.string().max(64), z.string().max(2000)).optional(),
  continueOnError: z.boolean().optional(),
});

// PRD 402: address-bar zoom control. factor is clamped again in
// browserView.cjs's setZoom — this just bounds the wire payload.
const browserSetZoom = z.object({
  viewId: z.string().min(1).max(128).regex(BROWSER_VIEW_ID_RE),
  factor: z.number().min(0.1).max(10),
});

// PRD 402: Cmd/Ctrl+F find bar.
const browserFind = z.object({
  viewId: z.string().min(1).max(128).regex(BROWSER_VIEW_ID_RE),
  text: z.string().max(2000),
  forward: z.boolean().optional(),
});

// ──────────────────────────────────────────── Transcripts
const SESSION_UUID_RE = /^[a-zA-Z0-9-]{1,64}$/;

const transcriptSubscribe = z.object({
  tabId: z.string().min(1).max(128),
  cwd: z.string().min(1).max(4096),
  sessionUuid: z.string().regex(SESSION_UUID_RE),
});

const transcriptTabId = z.object({ tabId: z.string().min(1).max(128) });

const transcriptPath = z.object({
  cwd: z.string().min(1).max(4096),
  sessionUuid: z.string().regex(SESSION_UUID_RE),
});

// Batched token-usage lookup for the Epics workspace (one call per visible
// set of Epics rather than a per-row IPC round trip). Bounded array size —
// mirrors ptyAlive's cap for the same reason (renderer can't ask unbounded).
const transcriptUsageFor = z.object({
  cwd: z.string().min(1).max(4096),
  sessionIds: z.array(z.string().regex(SESSION_UUID_RE)).max(500),
});

// ──────────────────────────────────────────── Config
const configPath = z.object({ path: z.string().min(1).max(4096) });

// `writer` carries the renderer's declared owner id for the single-writer law
// (lib/opsOwnership.cjs). Optional on the wire because most writes target
// ~/.claude, not a project ops root; writes INSIDE the ops root are refused
// when it is absent or wrong.
const configWriteJson = z.object({
  path: z.string().min(1).max(4096),
  data: z.unknown(),
  writer: z.string().min(1).max(64).optional(),
});

const configWriteText = z.object({
  path: z.string().min(1).max(4096),
  text: z.string(),
  writer: z.string().min(1).max(64).optional(),
});

const configListDir = z.object({
  path: z.string().min(1).max(4096),
  opts: z.object({
    filesOnly: z.boolean().optional(),
    dirsOnly: z.boolean().optional(),
    includeHidden: z.boolean().optional(),
  }).optional(),
});

const configWatch = z.array(z.string().min(1).max(4096));

const configParseImports = z.object({ path: z.string().min(1).max(4096) });

// ──────────────────────────────────────────── PromptSessions (Epics) active-index merge
// lib/activeIndexMerge.cjs's read-merge-write, invoked over IPC by the
// renderer's persistActiveIndex (state/promptSessions.ts) instead of that
// module doing its own config:read-json/config:write-json round trip. Payload
// carries only the CALLING renderer's in-memory contribution for this cwd —
// disk is main's truth, merged inside the same withPathLock epicMint.cjs uses.
//
// Epic ids are keys here (Electron's structured-clone IPC transport, unlike
// JSON.parse, can produce an own-enumerable "__proto__" key on a cloned
// object) — the regex excludes the prototype-pollution trio so a malformed/
// hostile payload fails validation before it ever reaches activeIndexMerge.cjs
// (which additionally uses null-prototype merge targets as defense in depth).
// Real epic ids are `${slugify(goalText)}-${uuid8}` (epicMint.cjs) — max 64
// mirrors slugify's 48-char cap plus the "-" + 8 hex chars suffix, rounded up.
const PROMPT_SESSION_ID_RE = /^(?!__proto__$|constructor$|prototype$)[A-Za-z0-9_-]{1,64}$/;

// Per-ROW validation, not per-BATCH. persistActiveIndex (state/promptSessions.ts)
// sends every open Epic for a cwd in ONE call, so validating the map with a
// single parse meant one malformed/legacy row rejected the whole payload —
// every other legitimate Epic for that cwd silently stopped persisting (the
// renderer only logs the failure). Dropping just the offending row matches how
// the rest of this pipeline already fails: per-id (activeIndexMerge.cjs's
// tombstone/resurrection handling), never per-batch.
const dropInvalidSessions = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const kept = Object.create(null);
  for (const id of Object.keys(raw)) {
    if (!PROMPT_SESSION_ID_RE.test(id)) {
      console.warn(`[ipc] merge-active-index: dropping session with invalid id ${JSON.stringify(id)}`);
      continue;
    }
    const parsed = PromptSessionSchema.safeParse(raw[id]);
    if (!parsed.success) {
      console.warn(`[ipc] merge-active-index: dropping malformed session ${id} — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      continue;
    }
    kept[id] = raw[id];
  }
  return kept;
};

const promptSessionsMergeActiveIndex = z.object({
  cwd: z.string().min(1).max(4096),
  sessions: z.preprocess(dropInvalidSessions, z.record(z.string().regex(PROMPT_SESSION_ID_RE), PromptSessionSchema)).refine(
    (v) => Object.keys(v).length <= 2000,
    { message: 'too many sessions in one merge payload' },
  ),
  events: z.record(z.string().regex(PROMPT_SESSION_ID_RE), z.array(z.unknown()).max(5000)).refine(
    (v) => Object.keys(v).length <= 2000,
    { message: 'too many event chains in one merge payload' },
  ),
  removedIds: z.array(z.string().regex(PROMPT_SESSION_ID_RE)).max(500).optional(),
  // Always the literal 'epics' on the wire — the handler ignores this value
  // and hardcodes the writer id itself (single-writer law,
  // lib/opsOwnership.cjs); requiring the literal here just means a
  // forged/malformed payload fails validation before it reaches the merge.
  source: z.literal('epics'),
});

// Renderer entry point for main's ensureEpic() (lib/promptSessionsCreateEpic.cjs)
// — additive step 1 of a two-PRD chain; unused by the app until the next PRD
// routes state/promptSessions.ts's createPromptSession through it. `tag`/
// `source` reuse promptSessionSchema.cjs's own enums rather than retyping
// the value lists a third time.
const promptSessionsCreateEpic = z.object({
  cwd: z.string().min(1).max(4096),
  goalText: z.string().min(1).max(20000),
  tag: EpicTagSchema.optional(),
  agentType: z.string().min(1).max(256).optional(),
  source: EpicSourceSchema.optional(),
});

// ──────────────────────────────────────────── Sessions
const sessionsPayload = z.object({
  tabs: z.array(z.object({
    id: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    cwd: z.string().min(1).max(4096),
    label: z.string().max(256),
    presetId: z.string().max(128).nullable(),
  })),
  activeTabId: z.string().max(128).nullable(),
});

// ──────────────────────────────────────────── Workbench layout
// layout:save envelope — validated at the shape level only (version + panel
// id list); `dockview` is dockview's own opaque SerializedDockview blob and
// is intentionally z.unknown() so a dockview library upgrade never fails
// validation on a shape this schema doesn't know about. Zero-panel layouts
// are refused here too (defense in depth — the renderer serializer already
// refuses to call save() with an empty panels list).
const layoutEnvelope = z.object({
  version: z.number().int().min(1),
  panels: z.array(z.string().min(1).max(128)).min(1).max(64),
  dockview: z.record(z.string(), z.unknown()),
}).strict();

// ──────────────────────────────────────────── Schedule
const SCHEDULE_SLUG_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SCHEDULE_RUN_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

const scheduleSlug = z.object({
  slug: z.string().regex(SCHEDULE_SLUG_RE),
});

const scheduleReadLog = z.object({
  slug: z.string().regex(SCHEDULE_SLUG_RE),
  runId: z.string().regex(SCHEDULE_RUN_ID_RE),
});

// PRD write: slug + body (≤256 KiB, matches PRD_WRITE_MAX_BYTES in scheduler.cjs).
const PRD_WRITE_MAX_BYTES = 256 * 1024;
const scheduleWritePrd = z.object({
  slug: z.string().regex(SCHEDULE_SLUG_RE),
  body: z.string().refine(
    (s) => Buffer.byteLength(s, 'utf8') <= PRD_WRITE_MAX_BYTES,
    `body must be ≤ ${PRD_WRITE_MAX_BYTES} bytes`,
  ),
});

// PRD create (admin API — scheduler_create_prd, PRD 549). This slug is
// deliberately STRICTER than SCHEDULE_SLUG_RE: it becomes a brand-new
// filename segment written to disk by the create route, not a lookup key
// for an existing file, so it excludes '.' and '_' too (matches
// pluginInstall.cjs's slug precedent, minus '/' — this slug must never
// introduce a subdirectory).
const PRD_CREATE_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// title/cwd become frontmatter VALUES (`title: ${title}`) in prdCreate.cjs's
// hand-rolled `key: value` serializer, which — unlike a real YAML
// library — has no escaping. A title/cwd containing '\n' could inject a
// bare `\n---\n` that terminates the frontmatter block early (per
// prdFrontmatter.cjs's `indexOf('\n---')` parse) and smuggle extra
// frontmatter-shaped lines into the body. Block newlines at the boundary
// instead of trying to escape them later.
const NO_NEWLINE_RE = /^[^\r\n]*$/;
const schedulerCreatePrd = z.object({
  title: z.string().min(1).max(200).regex(NO_NEWLINE_RE, 'must not contain newlines'),
  cwd: z.string().min(1).max(4096).regex(NO_NEWLINE_RE, 'must not contain newlines'),
  estimateMinutes: z.number().int().min(1).max(100000),
  goal: z.string().min(1).max(20000),
  acceptanceCriteria: z.array(z.string().min(1).max(2000)).min(1).max(100),
  implementationNotes: z.string().min(1).max(20000),
  outOfScope: z.array(z.string().min(1).max(2000)).max(100).optional(),
  slug: z.string().min(1).max(60).regex(PRD_CREATE_SLUG_RE).optional(),
  // DEPRECATED (PRD 832): accepted for wire-compat but ignored — numbers are
  // strictly unique per project; use dependsOn for ordering.
  parallelGroup: z.number().int().min(1).max(999999).optional(),
  // Explicit ordering (PRD 832): slugs that must complete before this PRD
  // becomes eligible. Written to frontmatter as `dependsOn: [a, b]`.
  dependsOn: z.array(z.string().min(1).max(160).regex(/^[A-Za-z0-9][\w.-]*$/)).max(20).optional(),
  // An EXISTING Epic's promptSessionId (PRD 748) — NOT a PromptTicket.id.
  // ensureEpic() (epicMint.cjs) joins the Epic whose active-index.json
  // sessions key literally equals this value; the renderer only ever sends
  // PromptTicket.promptSessionId here (see state/chat.ts), never
  // PromptTicket.id — those are distinct fields. Same newline-injection
  // guard as title/cwd since it also becomes a frontmatter value.
  sourcePromptId: z.string().min(1).max(128).regex(NO_NEWLINE_RE, 'must not contain newlines').optional(),
  // Originating tab id (PRD 761) — used at job completion to route a status
  // prompt back into the chat tab that queued this PRD, via
  // enqueueExternalPrompt (PRD 753). Same newline-injection guard.
  sourceTabId: z.string().min(1).max(128).regex(NO_NEWLINE_RE, 'must not contain newlines').optional(),
  // The calling MCP process's own claude session id (scheduler-mcp-server.cjs
  // forwards its inherited SM_CHAT_SESSION_ID env var here when the model
  // omitted sourcePromptId) — never written to frontmatter itself; prdCreate.cjs's
  // createPrd() resolves it against active-index.json to fill sourcePromptId
  // when it matches an existing Epic's claudeSessionId, so a PRD queued from
  // within an Epic's own chat session joins that Epic even if the tool call
  // forgot to pass sourcePromptId explicitly.
  originClaudeSessionId: z.string().min(1).max(128).regex(NO_NEWLINE_RE, 'must not contain newlines').optional(),
  // User-selected Feature/Bug tag (PRD 774) carried from the originating
  // PromptTicket — deterministic, never LLM-classified. NOT the same value
  // set as PromptSession's Epic-mission `tag` (lib/promptSessionSchema.cjs's
  // EpicTagSchema) — that one also includes 'bilko-host-publisher'. Keep
  // these two enums in sync deliberately if their meanings ever converge;
  // don't assume editing one updates the other.
  tag: z.enum(['feature', 'bug', 'discussion', 'build', 'project-home-builder']).optional(),
});

// Bulk archive: slug list, capped to limit unbounded retag/archive payloads.
const scheduleArchivePrd = z.object({
  slugs: z.array(z.string().regex(SCHEDULE_SLUG_RE)).min(1).max(500),
});

const scheduleRetagItem = z.object({
  slug: z.string().regex(SCHEDULE_SLUG_RE),
  parallelGroup: z.number().int().min(0).max(999).optional(),
  estimateMinutes: z.number().int().min(1).max(100000).optional(),
}).refine(
  (it) => it.parallelGroup !== undefined || it.estimateMinutes !== undefined,
  'at least one of parallelGroup or estimateMinutes is required',
);

const scheduleRetagPrd = z.object({
  items: z.array(scheduleRetagItem).min(1).max(500),
});

// ──────────────────────────────────────────── Projects
const ENCODED_SLUG_RE = /^[A-Za-z0-9._-]+$/;

// Consolidated shell "open/reveal" API. One channel (shell:open) replaces the
// former app:open-in-editor / open-file-in-editor / open-in-finder /
// open-in-terminal / open-external + files:open-external / show-in-finder.
// Discriminated on `as`; each variant carries only its own fields. Per-variant
// path/URL guards still run inside the handler (checkInsideHome / http(s) only).
const _pathStr = z.string().min(1).max(4096);
const _editorStr = z.string().max(256).nullable().optional();
const shellOpen = z.discriminatedUnion('as', [
  z.object({ as: z.literal('editor'), cwd: _pathStr, editor: _editorStr }),
  z.object({ as: z.literal('fileInEditor'), path: _pathStr, line: z.number().int().positive().optional(), col: z.number().int().positive().optional(), editor: _editorStr }),
  z.object({ as: z.literal('finder'), cwd: _pathStr }),
  z.object({ as: z.literal('terminal'), cwd: _pathStr }),
  z.object({ as: z.literal('external'), url: _pathStr }),
  z.object({ as: z.literal('openPath'), path: _pathStr }),
  z.object({ as: z.literal('revealPath'), path: _pathStr }),
]);

const archiveProject = z.object({
  encoded: z.string().regex(ENCODED_SLUG_RE).min(1).max(4096),
});

const home = os.homedir();
const setConfigSchema = z.object({
  enabled: z.boolean().optional(),
  offsetMinutes: z.number().int().min(0).max(180).optional(),
  concurrencyCap: z.number().int().min(1).max(20).optional(),
  defaultCwd: z.string().max(4096).refine(
    (s) => s === home || s.startsWith(home + path.sep),
    'defaultCwd must be inside home directory'
  ).optional(),
  firePolicy: z.enum(['when-available', 'on-reset', 'manual']).optional(),
  utilizationThreshold: z.number().min(0).max(200).optional(),
  supervisor: z.object({
    enabled: z.boolean().optional(),
    intervalMinutes: z.number().int().min(5).max(60).optional(),
    maxConcurrentProbes: z.number().int().min(1).max(5).optional(),
    probeStaleThresholdMinutes: z.number().int().min(5).max(30).optional(),
  }).optional(),
}).strict();

// Machine-wide claude -p slot pool cap (sessionSlots.cjs) — deliberately its own
// schema/channel rather than folded into setConfigSchema: it governs the shared
// process pool, not any one project's scheduler config, and its range (0-10, 0
// pauses new launches) differs from concurrencyCap's (1-20).
const setSessionSlotsSchema = z.object({
  cap: z.number().int().min(0).max(10),
}).strict();

// ──────────────────────────────────────────── Memory tool (Bundle C, cycle 3)
// Workspace-scoped markdown store at ~/.claude/projects/<ws>/memory/.
// Slug regex is shared with memoryTool.cjs/memoryAggregate.cjs via lib/memorySlug.cjs;
// workspace regex matches encodeWorkspace() output (alphanumeric + dash) plus 'default'.
const MEMORY_WORKSPACE_RE = /^[a-zA-Z0-9-_]{1,256}$/;
const { MEMORY_SLUG_RE } = require('./lib/memorySlug.cjs');
// 1 MiB hard cap — matches MAX_FILE_BYTES in memoryTool.cjs.
const MEMORY_MAX_BYTES = 1024 * 1024;

const memoryList = z.object({
  workspace: z.string().regex(MEMORY_WORKSPACE_RE).optional(),
}).strict();

const memoryRead = z.object({
  workspace: z.string().regex(MEMORY_WORKSPACE_RE).optional(),
  name: z.string().regex(MEMORY_SLUG_RE),
}).strict();

const memoryWrite = z.object({
  workspace: z.string().regex(MEMORY_WORKSPACE_RE).optional(),
  name: z.string().regex(MEMORY_SLUG_RE),
  content: z.string().max(MEMORY_MAX_BYTES),
}).strict();

const memoryDelete = z.object({
  workspace: z.string().regex(MEMORY_WORKSPACE_RE).optional(),
  name: z.string().regex(MEMORY_SLUG_RE),
}).strict();

const memoryCreate = z.object({
  workspace: z.string().regex(MEMORY_WORKSPACE_RE).optional(),
  name: z.string().regex(MEMORY_SLUG_RE),
  description: z.string().max(2048).optional(),
}).strict();

// memory:stale — deterministic staleness scorer (PRD 601). `cwd`, when given,
// is only used for the dead-ref existence check and is re-validated via
// config.validatePath in memoryTool.cjs before use.
const memoryStale = z.object({
  workspace: z.string().regex(MEMORY_WORKSPACE_RE).optional(),
  cwd: z.string().max(4096).optional(),
}).strict();

// memory:aggregate — Memory Clusters (PRD 356). `workspace` here is already
// the encoded cwd slug (memoryAggregate.cjs reads directly from
// ~/.claude/projects/<workspace>/memory/), same regex as the other memory:*
// handlers. `refresh: true` is the cost gate that fires the single claude -p
// clustering pass; falsy returns the cached result.
const memoryAggregate = z.object({
  workspace: z.string().regex(MEMORY_WORKSPACE_RE),
  refresh: z.boolean().optional(),
}).strict();

// ──────────────────────────────────────────── Project Brief (PRD 837)
// cwd is validated for real via config.cjs's validatePath (allowedRoots =
// home dir) at first fs access in projectBrief.cjs — this schema only bounds
// the wire shape.
const PROJECT_BRIEF_BLOCK = z.enum(['what', 'conventions']);
const projectBriefCwd = z.object({
  cwd: z.string().min(1).max(4096),
}).strict();

// ──────────────────────────────────────────── Project Pages (PRD 932)
// Same validation split as projectBriefCwd above: real path validation is
// config.cjs's validatePath at first fs access in projectPages.cjs.
const projectPagesCwd = z.object({
  cwd: z.string().min(1).max(4096),
}).strict();

// ──────────────────────────────────────────── Host on Bilko.run
// Same validation split: real path validation is config.cjs's validatePath
// at first fs access in bilkoHost.cjs — these schemas only bound wire shape.
const bilkoHostCwd = z.object({
  cwd: z.string().min(1).max(4096),
}).strict();
const bilkoHostPrepareBundle = z.object({
  cwd: z.string().min(1).max(4096),
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'slug must be lowercase kebab-case'),
}).strict();
const BILKO_HOST_DOCUMENT_SOURCE = z.union([
  z.object({ kind: z.literal('project-page-lens'), lens: z.enum(['home', 'marketing', 'feature', 'architecture']) }).strict(),
  z.object({ kind: z.literal('file'), path: z.string().min(1).max(4096) }).strict(),
]);
const bilkoHostAddDocument = z.object({
  cwd: z.string().min(1).max(4096),
  subpath: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  source: BILKO_HOST_DOCUMENT_SOURCE,
}).strict();
const bilkoHostRemoveDocument = z.object({
  cwd: z.string().min(1).max(4096),
  id: z.string().min(1).max(200),
}).strict();
const projectBriefSetPin = z.object({
  cwd: z.string().min(1).max(4096),
  block: PROJECT_BRIEF_BLOCK,
  pinned: z.boolean(),
}).strict();
// Hand-edit patch. Only bounds the wire shape (sizes + which keys exist);
// per-field shape is enforced by projectBriefCore.validateUpdateField so the
// rule lives in one unit-tested place. At least one key is required.
const PROJECT_BRIEF_TEXT = z.string().max(20_000);
const projectBriefUpdate = z.object({
  cwd: z.string().min(1).max(4096),
  patch: z.object({
    purpose: PROJECT_BRIEF_TEXT.optional(),
    what: z.array(PROJECT_BRIEF_TEXT).max(50).optional(),
    conventions: z.array(PROJECT_BRIEF_TEXT).max(100).optional(),
    areas: z.array(z.record(z.unknown())).max(100).optional(),
    scope: z.array(z.record(z.unknown())).max(200).optional(),
  }).strict().refine((p) => Object.keys(p).length > 0, { message: 'patch is empty' }),
}).strict();

// ──────────────────────────────────────────── Prompt session transcript
// (durable full-text turn store, PRD 863). cwd/epicId are only bounded for
// wire shape here — real path safety is config.cjs's validatePath/
// validateWrite inside promptSessionTranscript.cjs.
const PROMPT_SESSION_EPIC_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const PROMPT_SESSION_TRANSCRIPT_ROLE = z.enum(['user', 'assistant']);
const promptSessionTranscriptAppend = z.object({
  cwd: z.string().min(1).max(4096),
  epicId: z.string().regex(PROMPT_SESSION_EPIC_ID_RE),
  role: PROMPT_SESSION_TRANSCRIPT_ROLE,
  text: z.string().max(2_000_000),
  at: z.string().max(64).optional(),
  eventId: z.string().max(128).optional(),
}).strict();
const promptSessionTranscriptRead = z.object({
  cwd: z.string().min(1).max(4096),
  epicId: z.string().regex(PROMPT_SESSION_EPIC_ID_RE),
  limit: z.number().int().positive().max(10_000).optional(),
}).strict();

// ──────────────────────────────────────────── Audit log (renderer Epic
// lifecycle trace, PRD 940). Kind allowlist is enforced HERE, main-side — the
// renderer cannot write arbitrary kinds through this channel, only the six
// Epic lifecycle transitions it emits from promptSessions.ts.
const AUDIT_LOG_KIND = z.enum([
  'epic_create',
  'epic_approve',
  'epic_complete',
  'epic_delete',
  'epic_resume',
  'epic_duplicate',
]);
const auditLogAppend = z.object({
  kind: AUDIT_LOG_KIND,
  cwd: z.string().min(1).max(4096),
  epicId: z.string().min(1).max(256),
  source: z.string().min(1).max(256),
}).strict();

// ──────────────────────────────────────────── Per-subagent memory
// Distinct from the workspace-scoped Memory tool: agentMemory is keyed by
// subagent name (the .md filename in ~/.claude/agents/, e.g. "code-reviewer"),
// not by cwd. Storage lives at ~/.claude/session-manager/agent-memory/<agentId>.json.
// Regex caps must stay in lockstep with agentMemory.cjs AGENT_ID_RE / ENTRY_ID_RE.
const AGENT_MEMORY_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const AGENT_MEMORY_CATEGORY = z.enum(['command', 'preference', 'pattern', 'failure', 'workflow']);
const AGENT_MEMORY_MAX_BODY = 1024 * 1024; // 1 MiB — must match MAX_BODY_BYTES in agentMemory.cjs

const agentMemoryList = z.object({
  agentId: z.string().regex(AGENT_MEMORY_ID_RE),
}).strict();

const agentMemoryGet = z.object({
  agentId: z.string().regex(AGENT_MEMORY_ID_RE),
  entryId: z.string().regex(AGENT_MEMORY_ID_RE),
}).strict();

const agentMemorySet = z.object({
  agentId: z.string().regex(AGENT_MEMORY_ID_RE),
  entryId: z.string().regex(AGENT_MEMORY_ID_RE),
  body: z.string().max(AGENT_MEMORY_MAX_BODY),
  category: AGENT_MEMORY_CATEGORY.optional(),
}).strict();

const agentMemoryDelete = z.object({
  agentId: z.string().regex(AGENT_MEMORY_ID_RE),
  entryId: z.string().regex(AGENT_MEMORY_ID_RE),
}).strict();

// ──────────────────────────────────────────── Exchanges (PRD 324 read path)
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const exchangesList = z.object({
  cwd: z.string().min(1).max(4096),
  sessionId: z.string().regex(SESSION_ID_RE).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).max(100000).optional(),
}).strict();

// ──────────────────────────────────────────── Files (duplicate)
// files:duplicate — the rest of files:* keeps its schemas local to files.cjs;
// this one lives here per PRD 638 so it's reusable without importing files.cjs.
const filesDuplicate = z.object({ path: z.string().min(1).max(4096) });

// ──────────────────────────────────────────── Doc Edit (PRD 638 rewrite runner)
// docedit:run — consumed by docEdit.cjs's registerDocEditHandlers.
const docEditRun = z.object({
  path: z.string().min(1).max(4096),
  before: z.string().min(1).max(8000),
  instruction: z.string().min(1).max(2000),
  // 60000 is the intended document-context budget; the extra headroom
  // accommodates truncateDocumentText's head+tail+marker overhead (~60041
  // chars worst case) so an already-truncated payload never gets rejected.
  documentText: z.string().max(60100).optional(),
}).strict();

// docedit:run-in-session — consumed by docEdit.cjs's docEditViaSession (PRD 680: route a doc
// edit into an already-open, currently-idle chat session instead of an isolated claude -p).
const docEditRunInSession = docEditRun.omit({ path: true }).extend({
  tabId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  cwd: z.string().min(1).max(4096),
  requestId: z.string().min(1).max(128),
}).strict();

// ──────────────────────────────────────────── Chat runner (PRD 319)
// Prompt cap: 100 KiB. Matches a generous interactive message budget while
// preventing accidental megabyte pastes from reaching claude -p.
const CHAT_PROMPT_MAX_BYTES = 100 * 1024;

const chatRun = z.object({
  tabId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  // Non-empty; capped so a malformed renderer can't spawn a 100 MB child argv.
  prompt: z.string().min(1).refine(
    (s) => Buffer.byteLength(s, 'utf8') <= CHAT_PROMPT_MAX_BYTES,
    `prompt must be ≤ ${CHAT_PROMPT_MAX_BYTES} bytes`,
  ),
  cwd: z.string().min(1).max(4096),
  resume: z.boolean().optional().default(false),
  // Originating PromptTicket.id (PRD 748) when this run was dequeued from a
  // tab's prompt queue — absent for a fresh manual send with no ticket.
  promptId: z.string().min(1).max(128).optional(),
});

const chatCancel = z.object({
  tabId: z.string().min(1).max(128),
});

const chatClassifyTicket = z.object({
  text: z.string().min(1).refine(
    (s) => Buffer.byteLength(s, 'utf8') <= CHAT_PROMPT_MAX_BYTES,
    `text must be ≤ ${CHAT_PROMPT_MAX_BYTES} bytes`,
  ),
});

// External-caller entry point (admin HTTP route + MCP tool + web-remote
// command, PRD 753) — pushes a prompt into an already-open tab's chat queue
// from outside the renderer. tabId only (no sessionId/cwd): those are
// resolved renderer-side from useSessions, same as the AC requires.
const chatExternalSend = z.object({
  tabId: z.string().min(1).max(128),
  prompt: z.string().min(1).refine(
    (s) => Buffer.byteLength(s, 'utf8') <= CHAT_PROMPT_MAX_BYTES,
    `prompt must be ≤ ${CHAT_PROMPT_MAX_BYTES} bytes`,
  ),
});

// ──────────────────────────────────────────── Web Remote
// OTP is 8 uppercase alphanumeric chars (case-insensitive entry, normalised to upper in handler).
const WEB_REMOTE_OTP_RE = /^[A-Z0-9]{8}$/i;
const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const webRemotePair = z.object({
  otp: z.string().regex(WEB_REMOTE_OTP_RE),
}).strict();

const webRemoteRevokeDevice = z.object({
  deviceId: z.string().regex(DEVICE_ID_RE),
}).strict();

const webRemoteAuditTail = z.object({
  lines: z.number().int().min(1).max(500).optional(),
}).strict();

// ──────────────────────────────────────────── History
const DATE_YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

const historyAggregate = z.object({
  fromDate: z.string().regex(DATE_YYYY_MM_DD).optional(),
  toDate: z.string().regex(DATE_YYYY_MM_DD).optional(),
}).nullish();

const historyDashboard = z.object({
  rangeDays: z.union([z.literal(30), z.literal(60), z.literal(90), z.literal(0)]),
}).strict();

// ──────────────────────────────────────────── Voice (F1/F5/F7/F8)
// Mirrors voiceSettings.cjs isValidConfig / isValidDevicePref / isValid…
// validators (ad-hoc on disk). Schemas here gate the IPC boundary so a
// malformed renderer payload can never reach the file writer.
const VOICE_ACCELERATOR_RE = /^(CommandOrControl|CmdOrCtrl|Cmd|Command|Ctrl|Control|Alt|Option|Shift|Super|Meta)(\+(CommandOrControl|CmdOrCtrl|Cmd|Command|Ctrl|Control|Alt|Option|Shift|Super|Meta))*\+([A-Z]|[0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Enter|Backspace|Delete|Escape|Esc)$/;

const voiceSetHotkey = z.object({
  accelerator: z.string().max(128).regex(VOICE_ACCELERATOR_RE),
  mode: z.enum(['hold', 'toggle']),
  global: z.boolean(),
  schemaVersion: z.number().int().optional(),
}).passthrough();

const voiceSetDevicePref = z.object({
  selectedDeviceId: z.string().max(256).nullable(),
  selectedLabel: z.string().max(256).nullable(),
  schemaVersion: z.number().int().optional(),
}).passthrough();

const voiceSetTurnDetector = z.object({
  enabled: z.boolean(),
  mode: z.enum(['audio', 'text', 'off']),
  schemaVersion: z.number().int().optional(),
}).passthrough();

const voiceSetRecording = z.boolean();

// ──────────────────────────────────────────── Watchers
// watchers:add runs `spawn(command, { shell: true })` — second-highest blast
// radius after app:test-fire-hook. The 8 KiB cap on `command` is the same
// cap watchers.cjs uses internally; centralizing here so the schema is the
// injection fence rather than relying on the inline schemas in watchers.cjs.
const watchersAdd = z.object({
  tabId: z.string().min(1).max(128),
  label: z.string().max(256).optional().default(''),
  command: z.string().min(1).max(8192),
  cwd: z.string().max(4096).optional().nullable(),
});

const watchersList = z.object({ tabId: z.string().min(1).max(128) });
const watchersRemove = z.object({ watcherId: z.string().min(1).max(128) });
const watchersKillTab = z.object({ tabId: z.string().min(1).max(128) });

// ──────────────────────────────────────────── Hooks / git / plugins
// Free-form env: keys must be safe identifier shape (no '=' / NUL / weird
// unicode), values must be plain strings, both length-capped. We don't
// restrict the key set — Hooks can legitimately need any env name — but we
// do refuse anything that wouldn't survive a child_process env-block round
// trip.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const appTestFireHook = z.object({
  command: z.string().min(1).max(16 * 1024),
  env: z.record(z.string().regex(ENV_KEY_RE).max(256), z.string().max(8 * 1024))
    .nullable()
    .optional(),
  payload: z.string().max(1 * 1024 * 1024).optional(),
  timeoutMs: z.number().int().min(0).max(30_000).optional(),
}).passthrough();

const appGitBranch = z.object({
  cwd: z.string().min(1).max(4096),
}).passthrough();

// build:resolve-target — see src/main/lib/buildTarget.cjs. cwd is a trusted
// TAB cwd, not validatePath'd here (same invariant as appGitBranch above).
const buildResolveTarget = z.object({
  cwd: z.string().min(1).max(4096),
}).passthrough();

// git:status / git:file-status — see src/main/git.cjs. cwd is validatePath'd
// inside the handler (allowedRoots = home), so the schema only enforces shape.
const gitStatus = z.object({
  cwd: z.string().min(1).max(4096),
}).passthrough();

const gitFileStatus = z.object({
  cwd: z.string().min(1).max(4096),
}).passthrough();

const repoAnalyze = z.object({
  cwd: z.string().min(1).max(4096),
}).passthrough();

// Plugin install: mirrors pluginInstall.cjs SLUG_RE + length cap. Defense in
// depth — install() re-checks; the schema rejects earlier.
// Leading char must be alphanumeric — a `-` prefix would be parsed as a CLI flag
// by `claude plugin install` (argv injection). Mirrors pluginInstall.cjs SLUG_RE.
const PLUGIN_SLUG_RE = /^[a-z0-9][a-z0-9\-/]*$/;
const PLUGIN_MKT_ADD_RE = /^[A-Za-z0-9][A-Za-z0-9._\-]*\/[A-Za-z0-9._\-]+$/;
const pluginsInstall = z.object({
  slug: z.string().regex(PLUGIN_SLUG_RE).min(1).max(128),
  // Optional non-official marketplace: registered via `plugin marketplace add`
  // before install. pluginInstall.cjs re-validates (defense in depth).
  marketplace: z.object({
    // `owner/repo`, or the literal `bundled` sentinel (app's own packaged
    // marketplace — pluginInstall.cjs resolves it to an absolute path).
    add: z.string().min(1).max(200)
      .refine((v) => v === 'bundled' || PLUGIN_MKT_ADD_RE.test(v), 'invalid marketplace source'),
    name: z.string().regex(PLUGIN_SLUG_RE).min(1).max(128),
  }).optional(),
}).passthrough();
const pluginsAbort = z.object({
  slug: z.string().regex(PLUGIN_SLUG_RE).min(1).max(128),
}).passthrough();

/**
 * Wrap an IPC handler with schema validation. Returns a new handler that
 * parses the payload before calling the original. On invalid payload throws
 * a ZodError (caught by Electron's IPC harness → rejected promise). Existing
 * call sites already rely on throw semantics for malformed input, so we keep
 * that behavior for backwards compatibility.
 */
function validated(schema, handler) {
  return (_event, payload) => {
    const parsed = schema.parse(payload);
    return handler(parsed);
  };
}

// ──────────────────────────────────────────── Web Remote command allowlist
// Commands are split into three tiers:
//   READ_COMMANDS      — return data; allowed when remoteEnabled=true.
//   SAS_GATED_READS    — return sensitive user data (sessions, PRDs, logs,
//                        transcript summaries); additionally require
//                        _e2eAuthenticated=true (SAS confirmed by user).
//                        A compromised relay cannot exfiltrate this data from
//                        a session that has not been SAS-confirmed.
//   MUTATE_COMMANDS    — write files, spawn processes, or mutate persisted
//                        state; gated behind remoteControlEnabled=true AND
//                        _e2eAuthenticated=true.
// ALLOWED_COMMANDS is the union, kept for existing import compatibility.
//
// Ungated READ_COMMANDS (justify each):
//   cmd:app:version      — exposes only the app semver string; no user data.
//   cmd:session:unsubscribe — teardown lifecycle; returns nothing sensitive.
const READ_COMMANDS = new Set([
  'cmd:app:version',
  // v2 mobile: unsubscribe is a teardown lifecycle call with no data payload.
  'cmd:session:unsubscribe',
]);

// Sensitive reads — return user data; require SAS confirmation same as MUTATE.
const SAS_GATED_READS = new Set([
  'cmd:sessions:load',
  'cmd:history:aggregate',
  // subscribe initiates a live stream of session state/summary — sensitive.
  'cmd:session:subscribe',
  // NOTE: cmd:exchanges:list is intentionally NOT allowlisted — webRemote.cjs has
  // no dispatch handler for it, so an allowlist entry would only fail closed with
  // an opaque reject. Re-add here together with the handler when remote exchanges
  // are wired, so the allowlist always mirrors an actual capability.
  //
  // Scheduler/Epics commands (cmd:schedule:*) were removed here deliberately
  // (core scheduler/Epics redesign) — Remote no longer reaches into scheduler
  // internals at all; a future Remote rebuild will talk to Scheduler/Epics
  // through whatever higher-level surface that redesign lands on, not this
  // per-command allowlist.
]);

const MUTATE_COMMANDS = new Set([
  'cmd:sessions:save',
  'cmd:pty:spawn',
  'cmd:pty:write',
  // pty:kill terminates a live session; pty:resize drives the geometry of the
  // user's interactive PTY — both write live process state, so they are gated
  // behind remoteControlEnabled + SAS like every other mutation. A read-only
  // mobile mirror has no business killing or resizing the desktop's session.
  'cmd:pty:kill',
  'cmd:pty:resize',
  // Pushes a prompt into an open tab's chat queue — a real mutation of that
  // tab's session, same tier as pty:write.
  'cmd:chat:send',
]);

const ALLOWED_COMMANDS = new Set([...READ_COMMANDS, ...SAS_GATED_READS, ...MUTATE_COMMANDS]);

module.exports = {
  // Centralized slug regex — used by scheduler.cjs and queueOps.cjs for
  // direct test()/match() containment checks alongside the zod parses.
  SCHEDULE_SLUG_RE,
  SCHEDULE_RUN_ID_RE,
  PRD_CREATE_SLUG_RE,
  READ_COMMANDS,
  SAS_GATED_READS,
  MUTATE_COMMANDS,
  ALLOWED_COMMANDS,
  schemas: {
    webRemotePair,
    webRemoteRevokeDevice,
    webRemoteAuditTail,
    ptySpawn,
    ptyTabId,
    ptyAlive,
    ptyWrite,
    ptyResize,
    sessionSubscribe,
    browserViewId,
    browserCreate,
    browserSetBounds,
    browserNavigate,
    browserCaptureDom,
    browserCaptureSelection,
    browserCopyImage,
    browserSaveBinary,
    clipboardWriteText,
    browserSaveRecording,
    browserReplay,
    browserSetZoom,
    browserFind,
    transcriptSubscribe,
    transcriptTabId,
    transcriptPath,
    transcriptUsageFor,
    configPath,
    configWriteJson,
    configWriteText,
    configListDir,
    configWatch,
    configParseImports,
    sessionsPayload,
    layoutEnvelope,
    scheduleSlug,
    scheduleReadLog,
    scheduleWritePrd,
    schedulerCreatePrd,
    scheduleArchivePrd,
    scheduleRetagPrd,
    setConfigSchema,
    setSessionSlotsSchema,
    shellOpen,
    archiveProject,
    historyAggregate,
    historyDashboard,
    voiceSetHotkey,
    voiceSetDevicePref,
    voiceSetTurnDetector,
    voiceSetRecording,
    appTestFireHook,
    appGitBranch,
    buildResolveTarget,
    gitStatus,
    gitFileStatus,
    repoAnalyze,
    pluginsInstall,
    pluginsAbort,
    memoryList,
    memoryRead,
    memoryWrite,
    memoryDelete,
    memoryCreate,
    memoryAggregate,
    memoryStale,
    projectBriefCwd,
    projectPagesCwd,
    bilkoHostCwd,
    bilkoHostPrepareBundle,
    bilkoHostAddDocument,
    bilkoHostRemoveDocument,
    projectBriefSetPin,
    projectBriefUpdate,
    promptSessionTranscriptAppend,
    promptSessionTranscriptRead,
    promptSessionsMergeActiveIndex,
    promptSessionsCreateEpic,
    auditLogAppend,
    agentMemoryList,
    agentMemoryGet,
    agentMemorySet,
    agentMemoryDelete,
    watchersAdd,
    watchersList,
    watchersRemove,
    watchersKillTab,
    filesDuplicate,
    docEditRun,
    docEditRunInSession,
    chatRun,
    chatCancel,
    chatClassifyTicket,
    chatExternalSend,
    exchangesList,
  },
  validated,
};
