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

const ptyWrite = z.object({
  tabId: z.string().min(1).max(128),
  data: z.string(),
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

// ──────────────────────────────────────────── Projects
const ENCODED_SLUG_RE = /^[A-Za-z0-9._-]+$/;

const openInEditor = z.object({
  cwd: z.string().min(1).max(4096),
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

// ──────────────────────────────────────────── History
const DATE_YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

const historyAggregate = z.object({
  fromDate: z.string().regex(DATE_YYYY_MM_DD).optional(),
  toDate: z.string().regex(DATE_YYYY_MM_DD).optional(),
}).optional().nullable();

/**
 * Wrap an IPC handler with schema validation. Returns a new handler that
 * parses the payload before calling the original.
 */
function validated(schema, handler) {
  return (_event, payload) => {
    const parsed = schema.parse(payload);
    return handler(parsed);
  };
}

module.exports = {
  schemas: {
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
    setConfigSchema,
    openInEditor,
    openInFinder,
    openInTerminal,
    archiveProject,
    historyAggregate,
  },
  validated,
};
