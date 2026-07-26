/**
 * Zod schemas for all IPC handler payloads. Applied at the boundary between
 * renderer and main — rejects malformed data before it reaches any business
 * logic. Throws ZodError on violation (caught by Electron's IPC harness and
 * surfaced as a rejected promise to the renderer).
 */

const { z } = require('zod');
const os = require('node:os');
const path = require('node:path');

// ──────────────────────────────────────────── PTY
const ptySpawn = z.object({
  tabId: z.string().min(1).max(128),
  cwd: z.string().min(1).max(4096),
  cols: z.number().int().min(10).max(1000).optional(),
  rows: z.number().int().min(3).max(1000).optional(),
  startupCommand: z.string().max(8192).optional().nullable(),
});

const ptyTabId = z.object({ tabId: z.string().min(1).max(128) });

// v2 mobile: subscribe to a session's live state + summary. cwd is needed to
// locate the transcript JSONL (transcriptPath); validated against home-dir boundary
// in webRemote before any fs access.
const sessionSubscribe = z.object({
  // tabId becomes a transcript FILENAME (`<tabId>.jsonl`) — restrict to a
  // session-id charset (no '/', no '.', so it can't traverse out of the project
  // transcript dir). claudeSessionId is a UUID, which satisfies this.
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

// ──────────────────────────────────────────── Config
const configPath = z.object({ path: z.string().min(1).max(4096) });

const configWriteJson = z.object({
  path: z.string().min(1).max(4096),
  data: z.unknown(),
});

const configWriteText = z.object({
  path: z.string().min(1).max(4096),
  text: z.string(),
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

// ──────────────────────────────────────────── Sessions
const sessionsPayload = z.object({
  tabs: z.array(z.object({
    id: z.string().min(1).max(128),
    claudeSessionId: z.string().min(1).max(128),
    chatSessionId: z.string().min(1).max(128).optional(),
    cwd: z.string().min(1).max(4096),
    label: z.string().max(256),
    presetId: z.string().max(128).nullable(),
  })),
  activeTabId: z.string().max(128).nullable(),
});

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
  parallelGroup: z.number().int().min(1).max(999999).optional(),
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
});

const chatCancel = z.object({
  tabId: z.string().min(1).max(128),
});

const chatProbeContext = z.object({
  tabId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  cwd: z.string().min(1).max(4096),
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

// SuperAgent — "boss" run that writes a structured prompt to the active
// tab's PTY. Bounds match the inline schemas in superagent.cjs; centralizing
// here so the schema is the boundary fence rather than each handler.
const superagentStart = z.object({
  tabId: z.string().min(1).max(128),
  prompt: z.string().min(1).max(8 * 1024),
  specialistCount: z.number().int().min(1).max(8),
  depth: z.enum(['quick', 'standard', 'deep']),
}).strict();

const superagentTabId = z.object({
  tabId: z.string().min(1).max(128),
}).strict();

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
  'cmd:schedule:state',
  'cmd:schedule:read-prd',
  'cmd:schedule:read-log',
  'cmd:history:aggregate',
  // subscribe initiates a live stream of session state/summary — sensitive.
  'cmd:session:subscribe',
  // NOTE: cmd:exchanges:list is intentionally NOT allowlisted — webRemote.cjs has
  // no dispatch handler for it, so an allowlist entry would only fail closed with
  // an opaque reject. Re-add here together with the handler when remote exchanges
  // are wired, so the allowlist always mirrors an actual capability.
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
  'cmd:schedule:write-prd',
  'cmd:schedule:reset-job',
  'cmd:schedule:run-now',
  'cmd:schedule:set-config',
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
    configPath,
    configWriteJson,
    configWriteText,
    configListDir,
    configWatch,
    sessionsPayload,
    scheduleSlug,
    scheduleReadLog,
    scheduleWritePrd,
    schedulerCreatePrd,
    scheduleArchivePrd,
    scheduleRetagPrd,
    setConfigSchema,
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
    gitStatus,
    gitFileStatus,
    repoAnalyze,
    pluginsInstall,
    pluginsAbort,
    superagentStart,
    superagentTabId,
    memoryList,
    memoryRead,
    memoryWrite,
    memoryDelete,
    memoryCreate,
    memoryAggregate,
    memoryStale,
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
    chatProbeContext,
    exchangesList,
  },
  validated,
};
