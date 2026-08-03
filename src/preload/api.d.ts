export interface BuildTarget {
  registry: string;
  packageName: string;
  versionBumpPolicy: string;
  gates: string[];
  discovered?: boolean;
}

export interface ActionOutcome {
  ok: boolean;
  kind?: 'info' | 'warn' | 'error';
  message: string;
}

export interface SpawnResult {
  pid: number;
  cwd: string;
  /** True when spawn() found an existing PTY for this tabId and reattached. */
  reattached: boolean;
}

export interface PtyExit {
  exitCode: number;
  signal?: number;
}

export interface WriteErrorEvent {
  tabId: string;
  reason: string;
}

export interface BrowserNavState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  isSecure: boolean;
}

/** One captured recorder step (PRD 408 engine → PRD 409 panel). */
export interface RecordStep {
  n: number;
  /** `select` is accepted by replay/export (PRD 410) for forward-compat;
   * the live engine does not emit it yet. */
  verb: 'navigate' | 'click' | 'type' | 'select' | 'wait-for' | 'drag';
  target: string;
  kind?: 'nav' | 'assert';
  /** True for `type` steps — the actual typed value is never captured. */
  masked?: boolean;
  /** Engine-suggested `{{var}}` name for a `type` step (e.g. field name). */
  variableSuggestion?: string;
  /** Renderer-owned: set once the user checks "parameterize as {{var}}". */
  variable?: string | null;
  /** `select` steps only — the option value to choose on replay/export. */
  value?: string;
  /** Click position, or drag-start position for `drag` steps. */
  x?: number;
  /** Click position, or drag-start position for `drag` steps. */
  y?: number;
  /** `drag` steps only — drag-end target selector. */
  endTarget?: string;
  /** `drag` steps only — drag-end x position. */
  endX?: number;
  /** `drag` steps only — drag-end y position. */
  endY?: number;
}

/** Per-step replay outcome (PRD 410), streamed as `browser:replay-step:<viewId>`. */
export interface ReplayStepResult {
  n: number;
  status: 'pass' | 'fail';
  detail?: string;
}

/** find-in-page result (PRD 402), streamed as `browser:find-result:<viewId>`. */
export interface FindResult {
  requestId: number;
  matches: number;
  activeMatchOrdinal: number;
}

/** Element-picker event (PRD 403), streamed as `browser:picker-event:<viewId>`. */
export interface PickerEvent {
  type: 'hover' | 'pick' | 'unpick' | 'exit';
  selector?: string;
  label?: string;
  tag?: string;
  rect?: { x: number; y: number; width: number; height: number };
  /** Present on a 'pick' event fired by an unmodified click — the selection was replaced, not accumulated. */
  replace?: boolean;
}

/** One entry in `~/.claude/session-manager/browser/history.json` (PRD 402). */
export interface BrowserHistoryEntry {
  url: string;
  title: string;
  ts: number;
}

/** One entry in `~/.claude/session-manager/browser/bookmarks.json` (PRD 402). */
export interface BrowserBookmark {
  url: string;
  title: string;
  ts: number;
}

export interface ReadJsonResult {
  exists: boolean;
  raw: string;
  data: unknown;
  parseError: string | null;
  mtimeMs: number;
  error: string | null;
}

export interface ReadTextResult {
  exists: boolean;
  text: string;
  mtimeMs: number;
  error: string | null;
}

/** One resolved node in a CLAUDE.md-like file's `@path` import chain. */
export interface ImportRef {
  path: string;
  exists: boolean;
  sizeBytes: number;
  tokenEstimate: number;
  ok: boolean;
}

/** Declared owner ids for the single-writer law over a project's
 *  session-manager-operations/ root. Mirrors OWNERS in
 *  src/main/lib/opsOwnership.cjs — one writer per namespace; everyone reads. */
export type OpsWriter = 'epics' | 'scheduler' | 'project-home' | 'browser';

export interface WriteResult {
  ok: boolean;
  mtimeMs: number;
  error?: string;
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  mtimeMs: number;
  size: number;
}

export interface ListDirResult {
  ok: boolean;
  entries: DirEntry[];
  error: string | null;
}

export interface ConfigChangedEvent {
  path: string;
  mtimeMs: number;
  kind: 'add' | 'change' | 'unlink';
}

export type TranscriptEventKind =
  | 'tool_use'
  | 'todo_write'
  | 'plan'
  | 'usage'
  | 'agent_spawn'
  | 'message'
  | string;

export interface TranscriptEvent {
  kind: TranscriptEventKind;
  data: unknown;
  raw: unknown;
}

export interface SubscribeResult {
  ok: boolean;
  path: string | null;
  error?: string;
}

export interface PersistedTab {
  id: string;
  sessionId: string;
  cwd: string;
  label: string;
  presetId: string | null;
}

export interface LoadedSessions {
  tabs: PersistedTab[];
  activeTabId: string | null;
  /** True when the main process rotated all session IDs on boot (e.g. force-fresh). */
  freshStart?: boolean;
}

export interface LayoutEnvelope {
  version: number;
  /** Panel ids present in `dockview` at save time — pruned against the live registry on hydrate. */
  panels: string[];
  /** Opaque dockview `SerializedDockview` blob (from `api.toJSON()`/for `api.fromJSON()`). */
  dockview: Record<string, unknown>;
}

export interface UsageWindow {
  utilization: number;
  resets_at: string | null;
}

export interface UsageSnapshot {
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  seven_day_sonnet: UsageWindow | null;
  seven_day_opus: UsageWindow | null;
  seven_day_oauth_apps: UsageWindow | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number | null;
    utilization: number | null;
    currency: string | null;
  } | null;
  [key: string]: unknown;
}

export interface BillingData {
  usage: UsageSnapshot;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  credentialsExpiresAt: string | null;
  fetchedAt: number;
}

export type BillingFetchResult =
  | { kind: 'ok'; data: BillingData }
  | { kind: 'ok-stale'; data: BillingData; staleSince: number; lastError: string }
  | { kind: 'auth'; message: string; httpStatus: number; expiredAt?: number | null; cached?: BillingData; staleSince?: number }
  | { kind: 'transient'; message: string; httpStatus: number | null }
  | { kind: 'meter_rate_limited'; message: string; httpStatus: number; cached?: BillingData; staleSince?: number }
  | { kind: 'config'; message: string };

// ── MCP server live connection probe (`claude mcp list`)
export interface McpServerStatus {
  name: string;
  target: string;
  transport: 'stdio' | 'http' | 'sse' | 'ws' | 'unknown';
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'unknown';
}

export interface McpStatusResult {
  ok: boolean;
  servers: McpServerStatus[];
  error?: string;
  checkedAt: number;
}

/** One global `~/.claude/agents/<name>.md` persona, per the Agent Library nav page. */
export interface AgentPersona {
  name: string;
  description: string | null;
  tools: string[];
  model: string | null;
  color: string | null;
  /** Epic intent tags (tagLibrary.ts's TAG_LIBRARY) this persona is associated with. */
  tags: string[];
  /** "<Department> — <Human title>" (e.g. "Engineering — Architect"), free text — drives
   *  department grouping in the New Epic Agent picker. Optional/null when not set. */
  title?: string | null;
  path: string;
  body: string;
  /** Project names (basename of cwd) whose currently-open tab overlays this agent. */
  overridingProjects: string[];
}

/** Payload for `agents.savePersona` — creates or overwrites a global persona file. */
export interface AgentPersonaSaveInput {
  name: string;
  /** Previous filename, when renaming an existing persona. Omit when creating. */
  originalName?: string;
  description: string;
  tools: string[];
  model: string;
  color: string;
  tags: string[];
  title?: string;
  body: string;
}

export interface VoiceHotkeyConfig {
  accelerator: string;
  mode: 'hold' | 'toggle';
  global: boolean;
  schemaVersion: 1;
}

export interface VoiceHotkeyEvent {
  phase: 'down' | 'up';
  source: 'window' | 'global';
}

export interface VoiceSetHotkeyResult {
  ok: boolean;
  config: VoiceHotkeyConfig;
}

/** F5 — persisted audio-input device preference. */
export interface VoiceDevicePref {
  selectedDeviceId: string | null;
  selectedLabel: string | null;
  schemaVersion: 1;
}

/** F7 — first-run mic-check wizard state. */
export interface VoiceWizardState {
  /** Schema version stamped at the time the user completed the wizard, or null. */
  completedSchema: number | null;
  /** ISO-8601 completion timestamp, or null if never completed. */
  completedAt: string | null;
  /** Hardcoded current schema constant; bumping invalidates all completed wizards. */
  currentSchema: number;
}

export interface VoiceMarkWizardCompleteResult {
  ok: boolean;
  completedSchema: number;
  completedAt: string;
  currentSchema: number;
}

/**
 * F8 — semantic turn-detection settings. MVP shape only; the actual
 * smart-turn-v3 ONNX model is not loaded in v1. Persisted at
 * ~/.config/session-manager/voice.json under `turnDetector`. See PRD F8 v2.
 */
export interface VoiceTurnDetectorState {
  enabled: boolean;
  /** 'audio' = smart-turn-v3 (planned); 'text' = rejected on license; 'off' = pure-VAD (default). */
  mode: 'audio' | 'text' | 'off';
  schemaVersion: 1;
}

export interface VoiceSetTurnDetectorResult {
  ok: boolean;
  state: VoiceTurnDetectorState;
}

export interface TestFireHookArgs {
  command: string;
  env?: Record<string, string>;
  payload: string;
  timeoutMs?: number;
}

export interface TestFireHookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface OtelConfig {
  enabled: boolean;
  endpoint: string;
  /** Newline-separated "Key: Value" pairs. */
  headers: string;
  serviceName: string;
  /** Mirrors upstream OTEL_LOG_USER_PROMPTS — opt-in PII. */
  includeContent: boolean;
  schemaVersion: 1;
}

export interface OtelStatus {
  enabled: boolean;
  initialized: boolean;
  error: string | null;
  includeContent: boolean;
}

export interface OtelSetConfigResult {
  ok: boolean;
  error: string | null;
  config: OtelConfig;
  status: OtelStatus;
}

export type ScheduleFirePolicy = 'manual' | 'on-reset' | 'when-available';

export interface ScheduleConfig {
  /** Legacy on/off — kept for backwards compat with v0.4 queue.json. New
   *  installs derive enablement from firePolicy ('manual' === disabled). */
  enabled: boolean;
  /** Minutes to wait after the 5h reset before firing pending jobs.
   *  Used by 'on-reset'. Ignored by 'when-available' and 'manual'. */
  offsetMinutes: number;
  concurrencyCap: number;
  defaultCwd: string;
  /** Auto-fire policy. Default 'when-available'. */
  firePolicy: ScheduleFirePolicy;
  /** When firePolicy='when-available', fire only if five_hour utilization is
   *  strictly below this percent. 0–100. Default 90. */
  utilizationThreshold: number;
  schemaVersion: 1;
}

export type ScheduleJobStatus = 'pending' | 'running' | 'investigating' | 'completed' | 'failed' | 'needs_review';

export interface ScheduleJobRuntime {
  pid: number;
  runId: string;
  startedAt: string | null;
  /** Claude session UUID for the `--session-id` arg — populated when the job spawns. */
  sessionId?: string;
  /** Resolved cwd the job was launched in (may differ from job.cwd if defaultCwd was applied). */
  cwd?: string;
}

export interface ScheduleJob {
  slug: string;
  title: string;
  cwd: string | null;
  parallelGroup: number;
  estimateMinutes: number | null;
  bodyPreview: string;
  status: ScheduleJobStatus;
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  /** Claude session UUID passed via `--session-id`. Set when the job spawns
   *  and persisted across queue reloads so the renderer can find the JSONL
   *  transcript even after restart. */
  sessionId?: string;
  runtime?: ScheduleJobRuntime;
  /**
   * Set when the post-run verifier downgrades the job.
   * Values: 'halt' | 'deps_unmet' | 'transcript_errors' | 'verify_unavailable'
   * Cleared when the job is reset to 'pending'.
   */
  verifierVerdict?: string;
  /** Per-job values carried in queue.json for dependency checking. */
  /** Explicit cross-PRD ordering (PRD 832): slugs that must complete before
   *  this job is eligible. Replaces the retired shared-NN-parallel convention. */
  dependsOn?: string[];
  /** The originating claude session — the Epic's claudeSessionId, resolved
   *  from active-index.json at ingest (PRD 832). An Epic IS a tagged session. */
  originSessionId?: string | null;
  /** Originating tab id (PRD frontmatter `sourceTabId`), refreshed from the
   *  PRD file on every reconcile. When the PRD was authored from inside a
   *  PromptSessionConversation, this equals that PromptSession's own id
   *  (its chat key) — lets the Scheduler UI trace a job back to the
   *  PromptSession that spawned it. */
  sourceTabId?: string | null;
  /** Originating prompt id (PRD frontmatter `sourcePromptId`) — the
   *  PromptSession (Epic) id this PRD was dispatched from. Kept alongside
   *  `sourceTabId` for referential tracing even when the tab/session no
   *  longer resolves. */
  sourcePromptId?: string | null;
  /** The Epic this job's PRD belongs to, derived from the PRD's directory
   *  (`scheduler/epics/<epicId>/prds/`) — fact on disk, unlike the
   *  intent-carrying `sourcePromptId`/`sourceTabId`, which can disagree.
   *  Authoritative source for "which Epic is this from" in every UI. */
  epicId?: string | null;
}

export interface SchedulePaths {
  root: string;
  prds: string;
  runs: string;
  queue: string;
}

export type SchedulePauseReason = 'rate_limit' | 'auth' | 'network' | 'manual' | 'reset_failure';

export interface SchedulePauseInfo {
  reason: SchedulePauseReason;
  /** When the pause was first set (ISO). */
  since: string;
  /** ISO timestamp at which auto-resume will fire (typically next 5h reset).
   *  null means "indefinite — wait for manual Run now". */
  resumeAt: string | null;
}

export interface ScheduleHealthSnapshot {
  bootedAt: number;
  lastPollAt: number | null;
  lastPollOk: boolean;
  consecutiveFailures: number;
  /** Kind of the most recent poll failure: 'transient' | 'meter_rate_limited' | 'auth' | null */
  lastFailureKind: string | null;
  backoffNextAt: number | null;
  nextResetCached: string | null;
  pausedSince: number | null;
  pauseReason: SchedulePauseReason | null;
  runningJobs: { slug: string; startedAt: number; pid: number }[];
}

export interface PrdListItem {
  slug: string;
  parallelGroup: number;
  title: string;
  cwd: string;
  estimateMinutes: number | null;
  mtimeMs: number;
  /** PRD frontmatter `sourcePromptId` — the PromptSession (Epic) id this PRD
   *  was dispatched from, if any. */
  sourcePromptId?: string | null;
  /** Owning Epic id, derived from the PRD's directory. See ScheduleJob.epicId. */
  epicId?: string | null;
  /** True when this PRD's source .md was found in a `prds-archived/` dir
   *  (its scheduler job already ran to completion) rather than the live
   *  `prds/` dir. Archived PRDs have no matching queue.json job row (the
   *  row may have aged out into history.jsonl), so consumers must read
   *  `archivedStatus` instead of joining on a job to know the outcome. */
  archived?: boolean;
  /** Only present when `archived` is true — the resolved terminal outcome
   *  ('completed' vs 'failed') of the job that produced this archived PRD. */
  archivedStatus?: 'completed' | 'failed';
}

export interface SupervisorConfig {
  enabled: boolean;
  intervalMinutes: number;
  maxConcurrentProbes: number;
  probeStaleThresholdMinutes: number;
}

export interface SupervisorLogEntry {
  ts: number;
  jobSlug: string;
  lastActivityAgeMin: number;
  verdict: 'ok' | 'stuck';
  action: 'none' | 'kill-bash' | 'kill-agent';
  targetPid: number | null;
  reason: string;
  costUsd: number | null;
}

export interface SchedulePollHealth {
  lastPollAt: number | null;
  lastPollOk: boolean;
  consecutiveFailures: number;
  lastFailureKind: string | null;
}

export interface ScheduleEffectiveConcurrency {
  cap: number;
  /** 'env' when SM_SCHEDULER_MAX_CONCURRENCY pins the cap; 'config' when concurrencyCap governs. */
  source: 'env' | 'config';
}

export interface ScheduleStateSnapshot {
  config: ScheduleConfig & { supervisor?: SupervisorConfig };
  jobs: ScheduleJob[];
  scheduledFor: string | null;
  lastRunAt: string | null;
  nextReset: string | null;
  /** Set when scheduler self-paused (rate-limit detected). null when running normally. */
  paused: SchedulePauseInfo | null;
  /** Latest five_hour utilization percent (0–100) cached from billing.fetchUsage. null if unknown. */
  utilization: number | null;
  /** Poll health — last billing poll result; used to detect stale utilization. */
  pollHealth?: SchedulePollHealth;
  /** Effective concurrency cap and whether it's env-pinned or config-driven. */
  effectiveConcurrency: ScheduleEffectiveConcurrency;
  /** Returned only by the initial state() call, not the broadcast event. */
  paths?: SchedulePaths;
}

export interface HistoryAggregateRequest {
  fromDate?: string;
  toDate?: string;
}

export interface DayProjectRow {
  date: string;
  projectCwd: string;
  encodedCwd: string;
  promptCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  toolCallCount: number;
  toolBreakdown: Record<string, number>;
  sessionCount: number;
  errorCount: number;
  estimatedCostUsd: number;
  byModel: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    /** Set when the model id didn't match opus/sonnet/haiku and was priced at Sonnet rates as a fallback. */
    estimated?: boolean;
  }>;
}

export interface HistoryAggregateResult {
  rows: DayProjectRow[];
  partial: boolean;
  scannedMs: number;
  /** Total $ saved across all rows from cache-read pricing vs. full input pricing. Global, not per-row. */
  cacheSavingsUsd: number;
}

export interface SessionScanEntry {
  sessionId: string;
  projectEncoded: string;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface SessionScanResult {
  sessions: SessionScanEntry[];
  scannedMs: number;
}

export interface HistoryDashboardRequest {
  rangeDays: 30 | 60 | 90 | 0;
}

export interface HistoryDashboardTotals {
  promptCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  toolCallCount: number;
  sessionCount: number;
  errorCount: number;
  activeMinutes: number;
  estimatedCostUsd: number;
}

export interface HistoryDashboardProjectRow extends HistoryDashboardTotals {
  date: string;
  projectDir: string;
  toolBreakdown: Record<string, number>;
  byModel: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    estimated?: boolean;
  }>;
}

export interface HistoryDashboardDay {
  date: string;
  byProject: Record<string, HistoryDashboardProjectRow>;
}

export interface HistoryDashboardResult {
  from: string;
  to: string;
  days: HistoryDashboardDay[];
  prevTotals: HistoryDashboardTotals;
  totals: HistoryDashboardTotals;
  byProjectTotals: Record<string, HistoryDashboardTotals>;
  byModelTotals: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    estimated?: boolean;
  }>;
  toolsByProject: Record<string, Record<string, number>>;
  generatedAt: number;
  /** Dates included in `days` that are NOT yet finalized (typically just today). */
  provisionalDates: string[];
}


export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  mtimeMs: number;
}

export interface FilesListResult { ok: boolean; entries: FileEntry[]; error: string | null }
export interface FilesReadResult { ok: boolean; text: string; error: string | null; size: number; binary?: boolean; mime?: string }
export interface FilesWriteResult { ok: boolean; error: string | null }
export interface FilesCreateResult { ok: boolean; path?: string; error: string | null }
export interface FilesRenameResult { ok: boolean; newPath?: string; error: string | null }
export interface FilesDeleteResult { ok: boolean; error: string | null }
export interface FilesDuplicateResult { ok: boolean; path?: string; error?: string | null }
export interface DocEditResult { ok: boolean; after?: string; error?: string }
export interface DocEditSessionResult { tabId: string; requestId: string; ok: boolean; after?: string; error?: string }

export interface WatcherInfo {
  watcherId: string;
  tabId: string;
  label: string;
  command: string;
  cwd: string;
  pid: number | null;
  startedAt: number;
  lineCount: number;
}

export interface WatcherAddResult {
  watcherId: string;
  tabId: string;
  label: string;
  command: string;
  cwd: string;
  pid: number | null;
  startedAt: number;
}

export interface WatcherLineEvent {
  tabId: string;
  watcherId: string;
  line: string;
  ts: number;
}

export interface WatcherClosedEvent {
  tabId: string;
  watcherId: string;
}

export interface TeamMember {
  name: string;
  agentType: string | null;
  model: string | null;
}

export interface TeamInfo {
  name: string;
  configPath: string;
  description: string | null;
  leadAgentId: string | null;
  members: TeamMember[];
  memberCount: number;
  inboxDepth: number;
}

export interface TeamsListResult {
  teams: TeamInfo[];
}

// ────────────────────────────────────────────── Bundle D — queue ops

export interface LintFinding {
  rule: string;
  line: number;
  snippet: string;
  severity: 'warn' | 'error';
}

export interface LintReport {
  slug: string;
  findings: LintFinding[];
}

export interface LintQueueResult {
  reports: LintReport[];
  scannedAt: number;
}

export interface ArchivePrdResult {
  ok: boolean;
  archived: number;
  archivedTo: string | null;
  results: Array<{ ok: boolean; slug: string; error?: string; archivedTo?: string }>;
  error?: string;
}

export interface RetagPrdItem {
  slug: string;
  /** New parallel-group number; if set on an NN-kebab slug, the file is renamed. */
  parallelGroup?: number;
  estimateMinutes?: number;
}

export interface RetagPrdResult {
  ok: boolean;
  retagged: number;
  results: Array<{
    ok: boolean;
    slug: string;
    newSlug?: string;
    before?: Record<string, string>;
    after?: Record<string, string>;
    error?: string;
  }>;
  error?: string;
}

export interface ScheduleHistoryResult {
  ok: boolean;
  jobs: ScheduleJob[];
  error?: string;
}

// ────────────────────────────────────────────── Bundle C (cycle 3) — Memory tab

export interface MemoryEntry {
  name: string;
  path: string;
  mtimeMs: number;
  bytes: number;
}

export interface MemoryListResult {
  entries: MemoryEntry[];
  workspace: string;
  error: string | null;
}

export interface MemoryReadResult {
  content: string;
  exists: boolean;
  mtimeMs: number;
  bytes: number;
  error: string | null;
}

export interface MemoryMutationResult {
  ok: boolean;
  error: string | null;
}

export interface MemoryClusterLink {
  from: string;
  to: string;
  label?: string;
}

export interface MemoryCluster {
  id: string;
  name: string;
  summary: string;
  memberSlugs: string[];
  links: MemoryClusterLink[];
}

export interface MemoryAggregateResult {
  workspace: string;
  generatedAt: number | null;
  clusters: MemoryCluster[];
  orphans: string[];
  cached: boolean;
  error?: string;
}

export interface MemoryStaleEntry {
  name: string;
  ageDays: number;
  inboundLinks: number;
  deadRefs: string[];
  stale: boolean;
  reasons: string[];
}

export interface MemoryStaleResult {
  entries: MemoryStaleEntry[];
  workspace: string;
  error: string | null;
}

// ────────────────────────────────────────────── Project Brief (PRD 837)
// Persisted at <cwd>/session-manager-operations/project-brief/brief.json.
export type ProjectBriefPinnableBlock = 'what' | 'conventions';

export interface ProjectBriefArea {
  name: string;
  files: number;
  note: string;
  epic: string | null;
  heat: number;
}

export interface ProjectBriefScopeEntry {
  when: string;
  kind: 'added' | 'narrowed' | 'decided';
  text: string;
  src: string;
}

export interface ProjectBrief {
  version: number;
  synthesizedAt: string;
  /** ISO timestamp of the last hand-edit through `projectBrief.update`, or null. */
  editedAt: string | null;
  model: string;
  purpose: string;
  what: string[];
  areas: ProjectBriefArea[];
  scope: ProjectBriefScopeEntry[];
  conventions: string[];
  pins: { what: boolean; conventions: boolean };
  pinned: { what: string[] | null; conventions: string[] | null };
}

export interface PromptSessionTranscriptTurn {
  v: 1;
  epicId: string;
  eventId: string | null;
  role: 'user' | 'assistant';
  at: string;
  text: string;
}

export interface ProjectBriefSource {
  label: string;
  detail: string;
  mtimeMs: number | null;
  drift: boolean;
}

export interface ProjectBriefGetResult {
  brief: ProjectBrief | null;
  sources: ProjectBriefSource[];
}

export type ProjectBriefRefreshResult =
  | { ok: true; brief: ProjectBrief }
  | { ok: false; error: string };

export type ProjectBriefSetPinResult =
  | { ok: true; brief: ProjectBrief }
  | { ok: false; error: string };

/** Hand-edit patch over brief.json. Editing `what`/`conventions` auto-pins them. */
export interface ProjectBriefPatch {
  purpose?: string;
  what?: string[];
  conventions?: string[];
  areas?: ProjectBriefArea[];
  scope?: ProjectBriefScopeEntry[];
}

export type ProjectBriefUpdateResult =
  | { ok: true; brief: ProjectBrief }
  | { ok: false; error: string };

// ────────────────────────────────────────────── Project Pages (PRD 929-932, 969, project-home-hosted-html-spec)
export interface ProjectPagesOutput {
  home: string;
  /** Absent when `isDefault` is true — the shipped default only covers the home lens. */
  marketing?: string;
  /** Absent when `isDefault` is true — the shipped default only covers the home lens. */
  feature?: string;
  /** Absent when `isDefault` is true — the shipped default only covers the home lens. */
  architecture?: string;
  /** Absent for output generated before the 'brief' lens existed (PRD 969), or
   *  when `isDefault` is true — a project must regenerate to pick it up. */
  brief?: string;
  /** null for the shipped default (never generated). */
  generatedAt: string | null;
  /** True when `home` is the build-time shipped default, not this project's own
   *  generated output — the renderer must label provenance rather than infer it. */
  isDefault: boolean;
}

export interface ProjectPagesGetResult {
  /** Never null in practice — a project with no generated output still gets the
   *  shipped default (isDefault: true). The type stays nullable defensively. */
  output: ProjectPagesOutput | null;
}

// ────────────────────────────────────────────── Host on Bilko.run
export interface BilkoHostBundleManifest {
  schemaVersion: 1;
  slug: string;
  version: string;
  builtAt: string;
  gitSha: string;
  gitBranch: string;
  hostKit: { version: string };
  golden: { path: string; expect: string };
  health: Record<string, unknown>;
  bundle: { sizeBytesGz: number; fileCount: number };
  /** Not part of the host-contract schema itself — this app's own staleness bookkeeping (see BilkoHostGetResult.bundleStale). */
  documentCount: number;
  documents: Array<{ subpath: string; title: string }>;
}

export type BilkoHostPublishStatus =
  | 'not-published'
  | 'bundle-ready'
  | 'publishing'
  | 'published'
  | 'publish-failed';

export interface BilkoHostPublishState {
  status: BilkoHostPublishStatus;
  slug: string;
  url?: string;
  lastAttemptAt?: string;
  lastError?: string;
}

export type BilkoHostDocumentSource =
  | { kind: 'project-page-lens'; lens: 'home' | 'marketing' | 'feature' | 'architecture' }
  | { kind: 'file'; path: string };

export interface BilkoHostDocument {
  id: string;
  /** '' for the root document (dist/index.html); otherwise a '/'-joined lowercase-kebab path, e.g. 'special-doc/01'. */
  subpath: string;
  title: string;
  source: BilkoHostDocumentSource;
  addedAt: string;
  /** Where this document resolves once published, given the project's current/derived slug. */
  url: string;
}

export interface BilkoHostGetResult {
  hasMarketingPage: boolean;
  projectName: string;
  packagePrivate: boolean;
  packageHomepage: string | null;
  packageVersion: string;
  defaultSlug: string;
  documents: BilkoHostDocument[];
  /** True when the on-disk dist/ bundle doesn't reflect the current document list — Prepare Bundle (then Publish) is owed. */
  bundleStale: boolean;
  bundleManifest: BilkoHostBundleManifest | null;
  publishState: BilkoHostPublishState | null;
}

export interface BilkoHostPrepareBundleResult {
  distPath: string;
  manifest: BilkoHostBundleManifest;
}

export interface BilkoHostDocumentListResult {
  documents: Array<Omit<BilkoHostDocument, 'url'>>;
}

// ────────────────────────────────────────────── Per-subagent memory
// Stored at ~/.claude/session-manager/agent-memory/<agentId>.json. Keyed by
// agent name (the .md filename in ~/.claude/agents/), not by workspace cwd.

export type AgentMemoryCategory = 'command' | 'preference' | 'pattern' | 'failure' | 'workflow';

export interface AgentMemoryEntry {
  id: string;
  body: string;
  category: AgentMemoryCategory | null;
  createdAt: number;
  updatedAt: number;
  bytes: number;
}

export interface AgentMemoryListResult {
  entries: AgentMemoryEntry[];
  agentId: string;
  error: string | null;
}

export interface AgentMemoryGetResult {
  entry: AgentMemoryEntry | null;
  error: string | null;
}

export interface AgentMemoryMutationResult {
  ok: boolean;
  error: string | null;
}

// ────────────────────────────────────────────── Git status (richer than app:git-branch)

/** Mirrors the status returned by src/main/git.cjs mapStatus(). */
export type GitFileStatusType =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'staged'
  | 'conflict';

export interface GitFileStatus {
  /** Absolute path. Always inside cwd (we resolve relative paths against it). */
  path: string;
  /** Path as git reported it, relative to the repo root. */
  relativePath: string;
  status: GitFileStatusType;
  /** Raw porcelain X (index) character. ' ', 'M', 'A', 'D', 'R', 'C', 'U', '?'. */
  indexStatus: string;
  /** Raw porcelain Y (worktree) character. ' ', 'M', 'D', 'U', '?'. */
  workTreeStatus: string;
}

export interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  uncommittedCount: number;
  files: GitFileStatus[];
}

/** Map keyed by absolute path. Same enum as GitFileStatus.status. */
export type GitFileStatusMap = Record<string, GitFileStatusType>;

// ────────────────────────────────────────────── Bundle F — plugins install

export interface PluginInstallResult {
  ok: boolean;
  exitCode: number;
  error?: string;
}

export interface PluginInstallProgressEvent {
  slug: string;
  line: string;
}

// ────────────────────────────────────────────── Web Remote (PRD 08)

export interface WebRemoteDevice {
  deviceId: string;
  deviceName: string;
  issuedAt: string;
  lastConnectedAt: string | null;
}

export interface WebRemoteStatus {
  enabled: boolean;
  remoteControlEnabled: boolean;
  connected: boolean;
  e2eActive: boolean;
  /** True once the user has confirmed the SAS on the desktop. */
  e2eAuthenticated: boolean;
  /** Explicit E2E session state for UI rendering. */
  e2eState: 'idle' | 'pending_sas' | 'authenticated' | 'failed';
  /** 6-digit Short Authentication String pending user confirmation, or null. */
  pendingSas: string | null;
  devices: WebRemoteDevice[];
}

export interface WebRemotePairResult {
  ok: boolean;
  deviceId?: string;
  error?: string;
}

export interface WebRemoteMutationResult {
  ok: boolean;
  error?: string;
}

export interface WebRemoteAuditTailResult {
  ok: boolean;
  lines?: string[];
  error?: string;
}

// ────────────────────────────────────────────── Chat runner (PRD 319)

export interface ChatRunPayload {
  tabId: string;
  /** UUID for the claude session — created by the caller; stays the same across
   *  resumes so transcript context carries forward. */
  sessionId: string;
  prompt: string;
  cwd: string;
  /** When true, use --resume <sessionId> instead of --session-id. */
  resume?: boolean;
  /** Originating PromptTicket.id (PRD 748) when dequeued from a tab's
   *  prompt queue — absent for a fresh manual send. */
  promptId?: string;
}

export interface ChatCreatePrdPayload {
  title: string;
  cwd: string;
  estimateMinutes: number;
  goal: string;
  acceptanceCriteria: string[];
  implementationNotes: string;
  outOfScope?: string[];
  slug?: string;
  parallelGroup?: number;
  /** Originating PromptTicket.id (PRD 748) — traces the PRD back to the prompt that spawned it. */
  sourcePromptId?: string;
  /** Originating tab id — used at job completion to route a status prompt back into the tab. */
  sourceTabId?: string;
  /** User-selected Feature/Bug tag (PRD 774) carried from the originating PromptTicket. */
  tag?: 'feature' | 'bug' | 'discussion' | 'build' | 'project-home-builder' | 'bilko-host-publisher';
}

export type ChatCreatePrdResult =
  | { ok: true; nn: number; filename: string }
  | { ok: false; status: number; error: string };

export interface ChatRunQueuedEvent {
  tabId: string;
  sessionId: string;
  /** 1-based position in the FIFO queue while waiting behind a busy lane. */
  position: number;
}

export interface ChatRunStartedEvent {
  tabId: string;
  sessionId: string;
}

export interface ChatRunOutputEvent {
  tabId: string;
  /** Incremental text delta from one assistant content block. */
  delta: string;
}

export interface ChatRunToolUseEvent {
  tabId: string;
  /** tool_use content block id from the stream-json event. */
  id: string;
  kind: 'skill' | 'mcp' | 'tool';
  label: string;
  /** Populated only for Edit/Write tool_use blocks; undefined for every other kind. */
  diff?: { filePath: string; oldText?: string; newText?: string };
}

export interface ChatRunNeedsInputEvent {
  tabId: string;
  sessionId: string;
  /** Questions the agent is blocked on. */
  questions: string[];
  /** Everything the agent produced before the stop-signal sentinel, trimmed. */
  answerBody: string;
  /** Full raw assistant text including the stop-signal sentinel. @deprecated use answerBody */
  raw: string;
}

export interface ChatRunCompleteEvent {
  tabId: string;
  sessionId: string;
  /** The run's own final assistant message verbatim. */
  finalMessage: string;
}

export interface ChatRunErrorEvent {
  tabId: string;
  sessionId: string;
  message: string;
}

export interface ChatRunNoticeEvent {
  tabId: string;
  sessionId: string;
  message: string;
}

/** Pushed by enqueueExternalPrompt (PRD 753) — Web Remote, the admin HTTP
 *  route, or an MCP caller asking to enqueue a prompt into an open tab. */
export interface ChatExternalSendEvent {
  tabId: string;
  prompt: string;
}

export interface SessionManagerAPI {
  app: {
    version: () => Promise<string>;
    homeDir: () => Promise<string>;
    cwd: () => Promise<string>;
    engageRulesPath: () => Promise<string | null>;
    pickDirectory: () => Promise<string | null>;
    gitBranch: (cwd: string) => Promise<string | null>;
    /** Publish target for 'build'-tagged Epics — null disables the Build toolbar button. */
    resolveBuildTarget: (cwd: string) => Promise<BuildTarget | null>;
    rebootApp: () => void;
    testFireHook: (args: TestFireHookArgs) => Promise<TestFireHookResult>;
    /** F7 — true under SM_E2E=1; renderer uses this to suppress wizard auto-trigger. */
    isE2E: () => Promise<boolean>;
    /** `--simple` CLI flag → stripped single-terminal layout in `cwd`. */
    launchMode: () => Promise<{ simple: boolean; cwd: string }>;
    /** Boot diagnostic — resolved claude binary path + whether it was found
     *  on disk (false means spawn will rely on PATH and may ENOENT). */
    claudeBinStatus: () => Promise<{ resolved: string; foundOnDisk: boolean }>;
    /** Boot diagnostic — assertCwdInsideHome(os.homedir()) result. ok=false
     *  on macOS symlinked-/Users mismatch and blocks all session spawns. */
    homeSelfCheck: () => Promise<{ ok: boolean; error?: string; realCwd?: string }>;
    onNewSession: (handler: () => void) => () => void;
    onRebootSession: (handler: () => void) => () => void;
    archiveProject: (encoded: string) => Promise<{ ok: boolean; error?: string }>;
  };
  pty: {
    spawn: (payload: { tabId: string; cwd: string; cols?: number; rows?: number }) => Promise<SpawnResult>;
    write: (payload: { tabId: string; data: string }) => void;
    resize: (payload: { tabId: string; cols: number; rows: number }) => void;
    kill: (tabId: string) => void;
    /** Subset of `tabIds` (session keys) that currently have a live PTY —
     *  used by the Epics workspace to reconcile Terminal-mode attachment
     *  after a renderer reload (PRD 833 C1). */
    alive: (tabIds: string[]) => Promise<string[]>;
    onData: (tabId: string, handler: (data: string) => void) => () => void;
    onExit: (tabId: string, handler: (info: PtyExit) => void) => () => void;
    onWriteError: (handler: (ev: WriteErrorEvent) => void) => () => void;
  };
  browser: {
    create: (payload: { viewId: string; partition: string }) => Promise<{ ok: boolean }>;
    setBounds: (payload: { viewId: string; x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean }>;
    show: (viewId: string) => Promise<{ ok: boolean }>;
    hide: (viewId: string) => Promise<{ ok: boolean }>;
    destroy: (viewId: string) => Promise<{ ok: boolean }>;
    navigate: (payload: { viewId: string; url: string }) => Promise<{ ok: boolean; error?: string }>;
    back: (viewId: string) => Promise<{ ok: boolean; error?: string }>;
    forward: (viewId: string) => Promise<{ ok: boolean; error?: string }>;
    reload: (viewId: string) => Promise<{ ok: boolean; error?: string }>;
    stop: (viewId: string) => Promise<{ ok: boolean; error?: string }>;
    onNavState: (viewId: string, handler: (state: BrowserNavState) => void) => () => void;
    recordStart: (viewId: string) => Promise<{ ok: boolean; error?: string }>;
    recordStop: (viewId: string) => Promise<{ ok: boolean; error?: string }>;
    onRecordStep: (viewId: string, handler: (step: RecordStep) => void) => () => void;
    captureDom: (payload: { viewId: string; kind: 'text' | 'html' }) => Promise<
      | { ok: true; url: string; title: string; text: string; truncated?: boolean }
      | { ok: false; error: string }
    >;
    captureShot: (viewId: string) => Promise<
      | { ok: true; url: string; title: string; dataUrl: string }
      | { ok: false; error: string }
    >;
    saveBinary: (path: string, base64: string, writer?: OpsWriter) => Promise<{ ok: boolean; error?: string }>;
    /** Opens a native "Save As" dialog and writes `text` to the chosen path directly
     *  (bypasses config.cjs's write-boundary check — the path is user-chosen via OS dialog). */
    saveRecording: (payload: { defaultName: string; text: string }) => Promise<
      | { ok: true; path: string }
      | { ok: false; canceled: true }
      | { ok: false; error: string }
    >;
    replay: (payload: {
      viewId: string;
      steps: RecordStep[];
      values?: Record<string, string>;
      continueOnError?: boolean;
    }) => Promise<{ ok: boolean; error?: string; stopped?: boolean; failedAt?: number }>;
    onReplayStep: (viewId: string, handler: (step: ReplayStepResult) => void) => () => void;
    setZoom: (payload: { viewId: string; factor: number }) => Promise<{ ok: boolean; error?: string; factor?: number }>;
    find: (payload: { viewId: string; text: string; forward?: boolean }) => Promise<{ ok: boolean; error?: string }>;
    stopFind: (viewId: string) => Promise<{ ok: boolean; error?: string }>;
    onFindResult: (viewId: string, handler: (result: FindResult) => void) => () => void;
    pickerStart: (viewId: string) => Promise<{ ok: boolean; error?: string }>;
    pickerStop: (viewId: string) => Promise<{ ok: boolean; error?: string; wasPicking?: boolean }>;
    onPickerEvent: (viewId: string, handler: (ev: PickerEvent) => void) => () => void;
    /** Selection-scoped capture pipeline (PRD 404): filter -> prune -> summarize -> chunk for 'agent', outerHTML for 'html', CDP AX-tree for 'a11y', fallback-chain for 'selector'. */
    capture: (payload: {
      viewId: string;
      selectors: string[];
      mode: 'agent' | 'html' | 'a11y' | 'selector';
    }) => Promise<
      | { ok: true; mode: string; text: string; meta: { chunks?: number; tokens?: number } }
      | { ok: false; error: string }
    >;
    /** Fired when the embedded page tries to open a new window (target="_blank", window.open, ctrl/cmd-click) — the main process denies the native popup and forwards the URL here. */
    onOpenTabRequest: (handler: (payload: { url: string }) => void) => () => void;
  };
  transcripts: {
    subscribe: (payload: { tabId: string; cwd: string; sessionUuid: string }) => Promise<SubscribeResult>;
    /** Release the sub back to the LRU cache (view-switch). Does not destroy the watcher. */
    unsubscribe: (tabId: string) => Promise<{ ok: boolean }>;
    /** Permanently destroy the sub (genuine tab close). */
    closeTab: (tabId: string) => Promise<{ ok: boolean }>;
    buffer: (tabId: string) => Promise<TranscriptEvent[]>;
    pathFor: (cwd: string, sessionUuid: string) => Promise<string>;
    /** Batched token-usage totals, one map entry per requested sessionId. A
     *  session with no transcript file yet (or one over the main-process size
     *  cap) maps to null. */
    usageFor: (cwd: string, sessionIds: string[]) => Promise<Record<string, { inputTokens: number; outputTokens: number } | null>>;
    onEvent: (tabId: string, handler: (ev: TranscriptEvent) => void) => () => void;
  };
  sessions: {
    load: () => Promise<LoadedSessions>;
    save: (payload: LoadedSessions) => Promise<{ ok: boolean }>;
  };
  layout: {
    load: () => Promise<LayoutEnvelope | null>;
    save: (payload: LayoutEnvelope) => Promise<{ ok: boolean }>;
  };
  billing: {
    fetch: () => Promise<BillingFetchResult>;
  };
  mcp: {
    status: () => Promise<McpStatusResult>;
  };
  agents: {
    listPersonas: () => Promise<AgentPersona[]>;
    savePersona: (payload: AgentPersonaSaveInput) => Promise<{ ok: boolean; path: string }>;
    deletePersona: (payload: { name: string }) => Promise<{ ok: boolean }>;
    removeOverride: (payload: { name: string; projectName: string }) => Promise<{ ok: boolean }>;
    /** Fires after any save/delete/removeOverride — subscribers should re-fetch listPersonas(). */
    onChanged: (handler: () => void) => () => void;
  };
  logs: {
    write: (
      scope: string,
      level: 'debug' | 'info' | 'warn' | 'error',
      message: string,
      meta?: unknown,
      ctx?: { cwd?: string; tabId?: string; epicId?: string; tags?: string[] },
    ) => void;
    dir: () => Promise<string>;
  };
  config: {
    readJson: (path: string) => Promise<ReadJsonResult>;
    readText: (path: string) => Promise<ReadTextResult>;
    /** `writer` declares the owning surface for the single-writer law — required
     *  when `path` is inside a project's session-manager-operations/ root. */
    writeJson: (path: string, data: unknown, writer?: OpsWriter) => Promise<WriteResult>;
    writeText: (path: string, text: string, writer?: OpsWriter) => Promise<WriteResult>;
    listDir: (path: string, opts?: { filesOnly?: boolean; dirsOnly?: boolean; includeHidden?: boolean }) => Promise<ListDirResult>;
    exists: (path: string) => Promise<boolean>;
    watch: (paths: string[]) => void;
    unwatch: (paths: string[]) => void;
    onChanged: (handler: (info: ConfigChangedEvent) => void) => () => void;
    parseImports: (path: string) => Promise<{ ok: true; imports: ImportRef[] } | { ok: false; error: string }>;
  };
  voice: {
    onHotkey: (handler: (event: VoiceHotkeyEvent) => void) => () => void;
    onHotkeyConfigChanged: (handler: (cfg: VoiceHotkeyConfig) => void) => () => void;
    getHotkeyConfig: () => Promise<VoiceHotkeyConfig>;
    setHotkeyConfig: (cfg: VoiceHotkeyConfig) => Promise<VoiceSetHotkeyResult>;
    setRecording: (recording: boolean) => void;
    /** F5: read persisted audio-input device preference. */
    getDevicePref: () => Promise<VoiceDevicePref>;
    /** F5: persist audio-input device preference. */
    setDevicePref: (pref: { selectedDeviceId: string | null; selectedLabel: string | null }) => Promise<{ ok: boolean }>;
    /** F7: read first-run wizard state + current schema constant. */
    getWizardState: () => Promise<VoiceWizardState>;
    /** F7: stamp wizard as complete with the current schema. */
    markWizardComplete: () => Promise<VoiceMarkWizardCompleteResult>;
    /** F8 — read persisted turn-detector settings. */
    getTurnDetector: () => Promise<VoiceTurnDetectorState>;
    /** F8 — persist turn-detector settings. */
    setTurnDetector: (state: VoiceTurnDetectorState) => Promise<VoiceSetTurnDetectorResult>;
  };
  watchers: {
    add: (payload: { tabId: string; label?: string; command: string; cwd?: string | null }) => Promise<WatcherAddResult>;
    list: (tabId: string) => Promise<WatcherInfo[]>;
    remove: (watcherId: string) => Promise<{ ok: boolean }>;
    killTab: (tabId: string) => Promise<{ ok: boolean }>;
    onLine: (handler: (ev: WatcherLineEvent) => void) => () => void;
    onClosed: (handler: (ev: WatcherClosedEvent) => void) => () => void;
  };
  otel: {
    getConfig: () => Promise<OtelConfig>;
    setConfig: (cfg: OtelConfig) => Promise<OtelSetConfigResult>;
    status: () => Promise<OtelStatus>;
    configPath: () => Promise<string>;
  };
  files: {
    list: (path: string, showHidden?: boolean) => Promise<FilesListResult>;
    read: (path: string) => Promise<FilesReadResult>;
    write: (path: string, content: string) => Promise<FilesWriteResult>;
    create: (parentPath: string, name: string, kind: 'file' | 'folder') => Promise<FilesCreateResult>;
    rename: (path: string, newName: string) => Promise<FilesRenameResult>;
    delete: (path: string) => Promise<FilesDeleteResult>;
    duplicate: (path: string) => Promise<FilesDuplicateResult>;
  };
  docEdit: {
    run: (payload: { path: string; before: string; instruction: string; documentText?: string }) => Promise<DocEditResult>;
    runInSession: (payload: {
      tabId: string;
      sessionId: string;
      cwd: string;
      before: string;
      instruction: string;
      documentText?: string;
      requestId: string;
    }) => Promise<{ ok: boolean }>;
    onSessionResult: (handler: (payload: DocEditSessionResult) => void) => () => void;
  };
  /** Consolidated shell open/reveal. One method, discriminated on `as`, replaces
   *  the former app.openIn* / app.openExternal / files.openExternal / files.showInFinder.
   *  Each variant's boundary guard (home-scope / http(s)-only) runs in the main handler. */
  shell: {
    open: (
      opts:
        | { as: 'editor'; cwd: string; editor?: string | null }
        | { as: 'fileInEditor'; path: string; line?: number; col?: number; editor?: string | null }
        | { as: 'finder'; cwd: string }
        | { as: 'terminal'; cwd: string }
        | { as: 'external'; url: string }
        | { as: 'openPath'; path: string }
        | { as: 'revealPath'; path: string }
    ) => Promise<{ ok: boolean; opener?: string; error?: string }>;
  };
  history: {
    aggregate: (req?: HistoryAggregateRequest) => Promise<HistoryAggregateResult>;
    scanProjects: () => Promise<SessionScanResult>;
    dashboard: (req: HistoryDashboardRequest) => Promise<HistoryDashboardResult>;
  };
  schedule: {
    state: () => Promise<ScheduleStateSnapshot>;
    /** Machine-wide claude -p slot pool (sessionSlots.cjs): total/inUse/holders + [min,max]/default/envOverride. */
    sessionSlots: () => Promise<{
      total: number; inUse: number; holders: { owner: string; at: string }[];
      min: number; max: number; default: number; envOverride: boolean;
    }>;
    /** Set the slot pool's user cap (Home tab), [0, 10]; 0 pauses new launches. Ignored if SM_SESSION_SLOTS is set. */
    setSessionSlots: (cap: number) => Promise<{
      total: number; inUse: number; holders: { owner: string; at: string }[];
      min: number; max: number; default: number; envOverride: boolean;
    }>;
    setConfig: (partial: Partial<ScheduleConfig & { supervisor?: Partial<SupervisorConfig> }>) => Promise<{ ok: boolean; config: ScheduleConfig }>;
    resetJob: (slug: string) => Promise<{ ok: boolean; error?: string }>;
    runNow: () => Promise<{ ok: boolean }>;
    forceTick: () => Promise<ActionOutcome>;
    resume: () => Promise<{ ok: boolean }>;
    /** Re-scan prds/ and merge into queue.json; broadcasts updated state. */
    rescan: () => Promise<ActionOutcome>;
    /** Move all pending+failed PRDs to prds-archived/<ISO>/ and drop their
     *  queue entries. Completed/running entries are preserved. */
    clearQueue: () => Promise<{ ok: boolean; archived: number; archivedTo: string | null }>;
    openFolder: () => Promise<{ ok: boolean }>;
    readPrd: (slug: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
    readLog: (runId: string, slug: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
    writePrd: (slug: string, body: string) => Promise<{ ok: true; bytesWritten: number } | { ok: false; error: string }>;
    listPrds: () => Promise<PrdListItem[]>;
    health: () => Promise<ScheduleHealthSnapshot>;
    onState: (handler: (snapshot: ScheduleStateSnapshot) => void) => () => void;
    /** Bundle D — scan all PRDs for unbounded loops + missing frontmatter. */
    lintQueue: () => Promise<LintQueueResult>;
    /** Bundle D — move PRDs to prds-archived/<ISO>/. Never deletes. */
    archivePrds: (slugs: string[]) => Promise<ArchivePrdResult>;
    /** Bundle D — bulk retag parallelGroup and/or estimateMinutes. */
    retagPrds: (items: RetagPrdItem[]) => Promise<RetagPrdResult>;
    /** Return the last N completed/failed jobs from queue.json (newest first). */
    getHistory: (limit?: number) => Promise<ScheduleHistoryResult>;
  };
  supervisor: {
    /** Debug-only: run a supervisor tick immediately. Used by e2e tests. */
    tickNow: () => Promise<{ ok: boolean }>;
    /** Return last 50 supervisor log entries, descending by ts. */
    getLog: () => Promise<SupervisorLogEntry[]>;
  };
  teams: {
    /** Enumerate ~/.claude/teams/<name>/config.json + inbox depths. */
    list: () => Promise<TeamsListResult>;
  };
  plugins: {
    /** Run `claude plugin install <slug>` in a hidden pty. Streams output
     *  via `onInstallProgress`. Returns { ok, exitCode } on exit.
     *  Pass `marketplace` for a non-official plugin: the source is registered
     *  via `claude plugin marketplace add <add>` first, then `<slug>@<name>`
     *  is installed. */
    install: (payload: {
      slug: string;
      marketplace?: { add: string; name: string };
    }) => Promise<PluginInstallResult>;
    onInstallProgress: (handler: (ev: PluginInstallProgressEvent) => void) => () => void;
  };
  clipboard: {
    /** Ctrl+V image paste — reads OS clipboard, saves any image to a temp
     *  PNG, and returns the absolute path so the renderer can type it into
     *  the PTY. `ok:false, empty:true` when the clipboard holds no image. */
    pasteImage: () => Promise<
      | { ok: true; path: string; bytes: number }
      | { ok: false; empty?: true; error?: string }
    >;
    /** Ctrl+V text paste — reads OS clipboard text via Electron's native API
     *  (renderer's navigator.clipboard.readText() is denied by the
     *  permission-request handler, which only allows media permissions). */
    pasteText: () => Promise<
      | { ok: true; text: string }
      | { ok: false; error?: string }
    >;
    /** Write side — copies a Capture-panel screenshot data URL to the OS clipboard. */
    copyImage: (dataUrl: string) => Promise<{ ok: boolean; error?: string }>;
    /** Write side — copies arbitrary text (e.g. a recorded flow export) to the OS clipboard. */
    writeText: (text: string) => Promise<{ ok: boolean; error?: string }>;
  };
  memory: {
    /** List markdown memory entries for the given workspace (defaults to 'default'). */
    list: (workspace?: string) => Promise<MemoryListResult>;
    /** Read the contents of one memory entry. */
    read: (name: string, workspace?: string) => Promise<MemoryReadResult>;
    /** Atomic write of a memory entry (max 1 MiB). */
    write: (name: string, content: string, workspace?: string) => Promise<MemoryMutationResult>;
    /** Delete a memory entry. */
    delete: (name: string, workspace?: string) => Promise<MemoryMutationResult>;
    /** Create a new memory entry with starter frontmatter + body. */
    create: (name: string, description?: string, workspace?: string) => Promise<MemoryMutationResult>;
    /** Aggregate workspace memories into semantic clusters. `refresh:true` fires a cost-gated `claude -p` pass; otherwise returns the cache only. */
    aggregate: (workspace: string, refresh?: boolean) => Promise<MemoryAggregateResult>;
    /** Deterministic, zero-LLM-cost staleness report. `cwd` (optional) scopes the dead-repo-ref check. */
    stale: (workspace?: string, cwd?: string) => Promise<MemoryStaleResult>;
  };
  projectBrief: {
    /** Read brief.json (or null if none yet) plus cheaply-computed source/drift metadata. Never fires an LLM call. */
    get: (cwd: string) => Promise<ProjectBriefGetResult>;
    /** Cost-gated headless synthesis. Acquires a machine session slot first; returns `{ok:false}` if none free or a refresh is already running for this cwd. */
    refresh: (cwd: string) => Promise<ProjectBriefRefreshResult>;
    /** Pin/unpin a synthesized block ('what' | 'conventions'), freezing or clearing its frozen copy. */
    setPin: (cwd: string, block: ProjectBriefPinnableBlock, pinned: boolean) => Promise<ProjectBriefSetPinResult>;
    /** Hand-edit brief.json in place — no LLM cost. Edited pinnable blocks are auto-pinned so the next refresh preserves them. */
    update: (cwd: string, patch: ProjectBriefPatch) => Promise<ProjectBriefUpdateResult>;
  };
  projectPages: {
    /** Read output/*.html + manifest.json (or `{output: null}` if none exist yet). Never fires an LLM call. */
    get: (cwd: string) => Promise<ProjectPagesGetResult>;
  };
  bilkoHost: {
    /** Read compatibility-gate inputs + any existing bundle/publish state. Never fires an LLM call. */
    get: (cwd: string) => Promise<BilkoHostGetResult>;
    /** Stage A: rebuild the whole dist/ tree + dist/manifest.json from the current document list. Pure, no cost, idempotent. */
    prepareBundle: (cwd: string, slug: string) => Promise<BilkoHostPrepareBundleResult>;
    /** Add a hosted sub-path document (never the root, which always exists). Does not touch dist/ — Prepare Bundle picks it up. */
    addDocument: (cwd: string, subpath: string, title: string, source: BilkoHostDocumentSource) => Promise<BilkoHostDocumentListResult>;
    /** Remove a hosted document (never the root). Only updates documents.json — the file stays live until the next Prepare Bundle + Publish. */
    removeDocument: (cwd: string, id: string) => Promise<BilkoHostDocumentListResult>;
  };
  promptSessionTranscript: {
    /** Append one full-text turn to an Epic's durable JSONL transcript. Best-effort — resolves `{ok:false}` rather than throwing on failure. */
    append: (
      cwd: string,
      epicId: string,
      turn: { role: 'user' | 'assistant'; text: string; at?: string; eventId?: string },
    ) => Promise<{ ok: boolean }>;
    /** Read back an Epic's full-text turns (optionally capped to the last `limit`). Skips corrupt lines rather than throwing. */
    read: (cwd: string, epicId: string, limit?: number) => Promise<{ turns: PromptSessionTranscriptTurn[] }>;
  };
  auditLog: {
    /** Append one Epic-lifecycle audit event to ~/.claude/session-manager/audit-log.jsonl.
     *  Kind allowlist is enforced main-side (ipcSchemas.cjs) — this channel is
     *  append-only, no read/list IPC exists. */
    append: (
      kind: 'epic_create' | 'epic_approve' | 'epic_complete' | 'epic_delete' | 'epic_resume' | 'epic_duplicate',
      fields: { cwd: string; epicId: string; source: string },
    ) => Promise<{ ok: boolean }>;
  };
  agentMemory: {
    /** List all memory entries for one subagent. Sorted newest first. */
    list: (agentId: string) => Promise<AgentMemoryListResult>;
    /** Get one entry's full body. Returns `{entry:null}` if missing. */
    get: (agentId: string, entryId: string) => Promise<AgentMemoryGetResult>;
    /** Upsert one entry. Atomic write through config.cjs; max body 1 MiB. */
    set: (
      agentId: string,
      entryId: string,
      body: string,
      category?: AgentMemoryCategory,
    ) => Promise<AgentMemoryMutationResult>;
    /** Delete one entry. Removes the file outright when last entry is removed. */
    delete: (agentId: string, entryId: string) => Promise<AgentMemoryMutationResult>;
  };
  git: {
    /** Full git status for `cwd`. Returns null when not a git repo, git is
     *  missing, or the call times out (5s ceiling). Cached per-cwd for 5s. */
    status: (cwd: string) => Promise<GitStatusResult | null>;
    /** `{ absPath: status }` map. Returns `{}` for non-git / errored cwds.
     *  Same 5s cache as status(). Designed for a file-tree sidebar where the
     *  renderer needs per-row badges without a separate git call per file. */
    fileStatus: (cwd: string) => Promise<GitFileStatusMap>;
  };
  webRemote: {
    getStatus: () => Promise<WebRemoteStatus>;
    enable: () => Promise<WebRemoteMutationResult>;
    disable: () => Promise<WebRemoteMutationResult>;
    /** Allow MUTATE-tier commands (pty spawn/write, scheduler writes). Default off. */
    enableControl: () => Promise<WebRemoteMutationResult>;
    /** Block MUTATE-tier commands — mobile becomes read-only mirror. */
    disableControl: () => Promise<WebRemoteMutationResult>;
    pair: (otp: string) => Promise<WebRemotePairResult>;
    revokeDevice: (deviceId: string) => Promise<WebRemoteMutationResult>;
    auditTail: (lines?: number) => Promise<WebRemoteAuditTailResult>;
    onStatus: (handler: (status: WebRemoteStatus) => void) => () => void;
    onTokenRevoked: (handler: (ev: { deviceId: string }) => void) => () => void;
    /** Revoke ALL paired devices and tear down every session immediately (panic). */
    revokeAll: () => Promise<WebRemoteMutationResult>;
    /** Subscribe to the completion event broadcast after revokeAll. */
    onRevokedAll: (handler: (ev: { revokedCount: number }) => void) => () => void;
    /** Confirm that the SAS shown on the desktop matches the browser — marks the
     *  E2E session as authenticated and unblocks MUTATE-tier commands. */
    confirmSas: () => Promise<WebRemoteMutationResult>;
  };
  chat: {
    /** Spawn a headless `claude -p` run for a tab. Results arrive via the on* listeners. */
    run: (payload: ChatRunPayload) => Promise<{ ok: boolean }>;
    /** Cancel the in-flight run for a tab (SIGTERM→SIGKILL). Resolves once the
     *  run has fully settled (terminal event fired). No-op when idle. */
    cancel: (tabId: string) => Promise<void>;
    onQueued: (handler: (e: ChatRunQueuedEvent) => void) => () => void;
    onRunStarted: (handler: (e: ChatRunStartedEvent) => void) => () => void;
    onOutput: (handler: (e: ChatRunOutputEvent) => void) => () => void;
    onToolUse: (handler: (e: ChatRunToolUseEvent) => void) => () => void;
    onNeedsInput: (handler: (e: ChatRunNeedsInputEvent) => void) => () => void;
    onComplete: (handler: (e: ChatRunCompleteEvent) => void) => () => void;
    onError: (handler: (e: ChatRunErrorEvent) => void) => () => void;
    onNotice: (handler: (e: ChatRunNoticeEvent) => void) => () => void;
    /** Fires when a main-process caller (Web Remote, admin HTTP route, MCP
     *  tool) pushes a prompt into an open tab's queue from outside the
     *  renderer (PRD 753). */
    onExternalSend: (handler: (e: ChatExternalSendEvent) => void) => () => void;
    /** Classify a queued PromptTicket's text as 'inline' (run through
     *  chatRunner) or 'develop' (dispatch to /develop for PRD decomposition).
     *  A single bounded `claude -p` call, never a scheduler job. */
    classifyTicket: (payload: { text: string }) => Promise<'inline' | 'develop'>;
    /** Author a mechanical draft PRD from a queued PromptTicket classified
     *  'develop' — an in-process call to prdCreate.createPrd, never an HTTP
     *  round-trip. The draft is meant to be reviewed/edited in the Scheduler
     *  tab's PRD editor before it runs. */
    createPrd: (payload: ChatCreatePrdPayload) => Promise<ChatCreatePrdResult>;
  };
  exchanges: {
    /** Durable per-exchange log entries for a project, newest-first (max 100 by default). */
    list: (payload: {
      cwd: string;
      sessionId?: string;
      limit?: number;
      offset?: number;
    }) => Promise<Exchange[]>;
  };
  promptSessions: {
    /** Fires when the main process appends an event to a PromptSession's
     *  chain on disk (currently only the scheduler's response-event append
     *  from notifyOriginatingTab) — lets an already-hydrated Epic pick it up
     *  live instead of waiting for a restart. */
    onEventAppended: (handler: (e: PromptSessionEventAppendedPayload) => void) => () => void;
    /** Main-side read-merge-write of a cwd's active-index.json
     *  (lib/activeIndexMerge.cjs) — persistActiveIndex sends only its own
     *  in-memory contribution for the cwd; disk stays main's truth, merged
     *  inside the same lock epicMint.cjs's ensureEpic serializes through. */
    mergeActiveIndex: (payload: PromptSessionsMergeActiveIndexPayload) => Promise<PromptSessionsMergeActiveIndexResult>;
    /** Mints a brand-new 'proposed' Epic through main's own ensureEpic()
     *  (lib/promptSessionsCreateEpic.cjs) instead of the renderer
     *  hand-constructing the PromptSession record itself. Unused today —
     *  additive step 1 of a two-PRD chain; a later PRD routes
     *  createPromptSession through this. */
    create: (payload: PromptSessionsCreateEpicPayload) => Promise<PromptSessionsCreateEpicResult>;
  };
}

// ─────────────────────────────────── PromptSessions active-index merge
export interface PromptSessionsMergeActiveIndexPayload {
  cwd: string;
  sessions: Record<string, unknown>;
  events: Record<string, unknown[]>;
  removedIds?: string[];
  source: 'epics';
}

export interface PromptSessionsMergeActiveIndexResult {
  sessions: Record<string, unknown>;
  events: Record<string, unknown[]>;
}

// ─────────────────────────────────── PromptSessions create-epic (main-side ensureEpic)
export interface PromptSessionsCreateEpicPayload {
  cwd: string;
  goalText: string;
  tag?: 'feature' | 'bug' | 'discussion' | 'build' | 'project-home-builder' | 'bilko-host-publisher';
  agentType?: string;
  source?: {
    producer: 'new-epic-ui' | 'scheduler-dispatch';
    prdSlug?: string;
    runId?: string;
    sourceTabId?: string;
  };
}

export interface PromptSessionsCreateEpicResult {
  epicId: string;
  session: Record<string, unknown>;
}

// ─────────────────────────────────── PromptSession event-appended broadcast

export interface PromptSessionEventAppendedPayload {
  cwd: string;
  promptSessionId: string;
  event: {
    id: string;
    promptSessionId: string;
    kind: 'prompt' | 'prd_created' | 'response' | 'closed';
    causedByEventId: string | null;
    at: string;
    prdSlug?: string;
    text?: string;
  };
}

// ────────────────────────────────────────────── Exchanges (PRD 324 read path)

export interface Exchange {
  /** ISO 8601 timestamp when the exchange was recorded. */
  ts: string;
  /** Claude session UUID. */
  sessionId: string;
  /** Project cwd. */
  cwd: string;
  /** The user prompt that started the exchange. */
  prompt: string;
  /** The verbatim assistant result. */
  result: string;
  /** Haiku-generated one-sentence summary. */
  summary: string;
  /** Haiku model used for the summary (informational). */
  model?: string;
  /** Set when summarization failed — `result` is available but `summary` may be empty. */
  degraded?: boolean;
  /** Originating PromptTicket.id (PRD 748) when this exchange was dispatched
   *  from a queued ticket — absent on historical records and fresh manual
   *  sends with no ticket (PRD 749; never backfilled). */
  promptId?: string;
}

declare global {
  interface Window {
    api: SessionManagerAPI;
  }
  // Injected by Vite's `define` from package.json at build time.
  const __APP_VERSION__: string;
}

export {};
