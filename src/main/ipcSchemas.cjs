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

const openInEditor = z.object({
  cwd: z.string().min(1).max(4096),
  editor: z.string().max(256).nullable().optional(),
});

const openExternal = z.object({
  url: z.string().min(1).max(4096),
});

const openFileInEditor = z.object({
  path: z.string().min(1).max(4096),
  line: z.number().int().positive().optional(),
  col: z.number().int().positive().optional(),
  editor: z.string().max(256).nullable().optional(),
});

const openInFinder = z.object({
  cwd: z.string().min(1).max(4096),
});

const openInTerminal = z.object({
  cwd: z.string().min(1).max(4096),
});

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
// Workspace-scoped markdown store at ~/.claude/session-manager/memories/<ws>/.
// Slug regex must match memoryTool.cjs SLUG_RE; workspace regex matches its
// encodeWorkspace() output (alphanumeric + dash) plus 'default'.
const MEMORY_WORKSPACE_RE = /^[a-zA-Z0-9-_]{1,256}$/;
const MEMORY_SLUG_RE = /^[a-z0-9-_]+\.md$/;
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

// ──────────────────────────────────────────── Voice (F1/F5/F7/F8)
// Mirrors voiceSettings.cjs isValidConfig / isValidDevicePref / isValid…
// validators (ad-hoc on disk). Schemas here gate the IPC boundary so a
// malformed renderer payload can never reach the file writer.
const VOICE_ACCELERATOR_RE = /^(CommandOrControl|CmdOrCtrl|Cmd|Command|Ctrl|Control|Alt|Option|Shift|Super|Meta)(\+(CommandOrControl|CmdOrCtrl|Cmd|Command|Ctrl|Control|Alt|Option|Shift|Super|Meta))*\+([A-Z]|[0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Enter|Backspace|Delete|Escape|Esc)$/;

const voiceSetHotkey = z.object({
  accelerator: z.string().regex(VOICE_ACCELERATOR_RE),
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
const PLUGIN_SLUG_RE = /^[a-z0-9\-/]+$/;
const pluginsInstall = z.object({
  slug: z.string().regex(PLUGIN_SLUG_RE).min(1).max(128),
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

module.exports = {
  // Centralized slug regex — used by scheduler.cjs and queueOps.cjs for
  // direct test()/match() containment checks alongside the zod parses.
  SCHEDULE_SLUG_RE,
  SCHEDULE_RUN_ID_RE,
  schemas: {
    webRemotePair,
    webRemoteRevokeDevice,
    webRemoteAuditTail,
    ptySpawn,
    ptyTabId,
    ptyWrite,
    ptyResize,
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
    scheduleArchivePrd,
    scheduleRetagPrd,
    setConfigSchema,
    openInEditor,
    openExternal,
    openFileInEditor,
    openInFinder,
    openInTerminal,
    archiveProject,
    historyAggregate,
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
    agentMemoryList,
    agentMemoryGet,
    agentMemorySet,
    agentMemoryDelete,
    watchersAdd,
    watchersList,
    watchersRemove,
    watchersKillTab,
  },
  validated,
};
