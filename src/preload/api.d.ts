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
  claudeSessionId: string;
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
  | { kind: 'config'; message: string };

// ── Usage matrix (AgOps dashboard, main-side aggregator)
export type UsageMatrixState = 'idle' | 'executing' | 'plan' | 'background';
export type UsageMatrixIntensity = 'idle' | 'low' | 'medium' | 'critical';
export type UsageMatrixCacheState = 'warm' | 'expiring' | 'cold';

export interface UsageMatrixAlert {
  level: 'info' | 'warn';
  code:
    | 'geometric-growth'
    | 'long-session'
    | 'cache-cold-start'
    | 'cache-cold'
    | 'subagent-fanout';
  message: string;
}

export interface UsageMatrixTab {
  tabId: string;
  workspace: string;
  cwd: string;
  state: UsageMatrixState;
  turns: number;
  lastEventAt: number;
  lastAssistantAt: number;
  cacheAgeMs: number | null;
  cacheState: UsageMatrixCacheState;
  tokensPerMin: number;
  intensity: UsageMatrixIntensity;
  avgTokensPerTurn: number;
  cumulativeUsage: { input: number; output: number; cacheRead: number; cacheCreate: number };
  subagentsActive: number;
  subagentsSpawned: number;
  geometricGrowth: boolean;
  alerts: UsageMatrixAlert[];
}

export interface UsageMatrixSnapshot {
  generatedAt: number;
  tabs: UsageMatrixTab[];
  totals: {
    activeSessions: number;
    subagentsActive: number;
    subagentsSpawned: number;
    tokensTotal: number;
    combinedTokensPerMin: number;
  };
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

export type ScheduleJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'needs_review';

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
  dependsOn?: string[];
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
}

export interface HistoryAggregateResult {
  rows: DayProjectRow[];
  partial: boolean;
  scannedMs: number;
}

export interface ConversationSummary {
  /** ISO 8601 timestamp of the first event in the conversation (or file mtime fallback). */
  timestamp: string;
  /** Decoded project cwd, e.g. /home/user/Projects/foo. */
  projectFolder: string;
  stats: {
    /** Wall-clock duration in ms (first event ts → last event ts). Omitted when unknown. */
    duration?: number;
    /** Sum of input + output tokens across the file. 0 when no usage blocks present. */
    estimatedTokens: number;
  };
}

export interface ListConversationsResult {
  conversations: ConversationSummary[];
  scannedMs: number;
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
export interface FilesShellResult { ok: boolean; error?: string }

export interface SearchFileEntry {
  name: string;
  path: string;
  isDirectory: false;
  isFile: true;
}
export interface SearchFilesResult {
  ok: boolean;
  files: SearchFileEntry[];
  error: string | null;
  usedRipgrep: boolean;
}
export interface SearchTextMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}
export interface SearchTextResult {
  ok: boolean;
  matches: SearchTextMatch[];
  error: string | null;
  usedRipgrep: boolean;
}

export interface RepoLanguageStats { files: number; lines: number }
export interface RepoTopDirectory { path: string; fileCount: number; totalLines: number }
export interface RepoGitStatusSummary { uncommitted: number; branch: string | null }
export interface RepoAnalyzeResult {
  ok: true;
  cwd: string;
  totalFiles: number;
  totalLines: number;
  languageBreakdown: Record<string, RepoLanguageStats>;
  topDirectories: RepoTopDirectory[];
  gitStatus: RepoGitStatusSummary;
  truncated: boolean;
  durationMs: number;
}
export interface RepoAnalyzeError { ok: false; error: string }

export interface HiveRole { label: string; prompt: string }
export interface Hive {
  slug: string;
  name: string;
  description: string;
  roles: HiveRole[];
  defaultPlan?: string;
}
export interface HiveListResult { hives: Hive[]; error: string | null }
export interface HiveGetResult { hive: Hive | null; error: string | null }
export interface HiveMutationResult { ok: boolean; error: string | null }

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

export interface AgentMemoryAgentSummary {
  agentId: string;
  bytes: number;
  mtimeMs: number;
}

export interface AgentMemoryListAgentsResult {
  agents: AgentMemoryAgentSummary[];
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

// ────────────────────────────────────────────── SuperAgent
// "Boss" run that dispatches specialist subagents on the active tab's claude
// session. Renderer-driven progress — main only owns lifecycle + prompt write.

export type SuperAgentDepth = 'quick' | 'standard' | 'deep';
export type SuperAgentStatus = 'idle' | 'running' | 'done' | 'error';

export interface SuperAgentRunState {
  status: SuperAgentStatus;
  prompt: string;
  specialistCount: number;
  depth: SuperAgentDepth;
  startedAt: number | null;
  finishedAt: number | null;
  error?: string;
}

export interface SuperAgentStartArgs {
  tabId: string;
  prompt: string;
  specialistCount: number;
  depth: SuperAgentDepth;
}

export interface SuperAgentStartResult {
  ok: boolean;
  error?: string;
}

export interface SuperAgentStateChangedEvent {
  tabId: string;
  state: SuperAgentRunState | null;
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

export interface SessionManagerAPI {
  app: {
    version: () => Promise<string>;
    homeDir: () => Promise<string>;
    cwd: () => Promise<string>;
    engageRulesPath: () => Promise<string | null>;
    pickDirectory: () => Promise<string | null>;
    gitBranch: (cwd: string) => Promise<string | null>;
    rebootApp: () => void;
    testFireHook: (args: TestFireHookArgs) => Promise<TestFireHookResult>;
    /** F7 — true under SM_E2E=1; renderer uses this to suppress wizard auto-trigger. */
    isE2E: () => Promise<boolean>;
    /** Boot diagnostic — resolved claude binary path + whether it was found
     *  on disk (false means spawn will rely on PATH and may ENOENT). */
    claudeBinStatus: () => Promise<{ resolved: string; foundOnDisk: boolean }>;
    /** Boot diagnostic — assertCwdInsideHome(os.homedir()) result. ok=false
     *  on macOS symlinked-/Users mismatch and blocks all session spawns. */
    homeSelfCheck: () => Promise<{ ok: boolean; error?: string; realCwd?: string }>;
    onNewSession: (handler: () => void) => () => void;
    onRebootSession: (handler: () => void) => () => void;
    openInEditor: (cwd: string, editor?: string | null) => Promise<{ ok: boolean; opener?: string; error?: string }>;
    /** Open an http/https URL in the OS default browser. file://, javascript:,
     *  and other schemes are rejected with `ok:false` to prevent abuse. */
    openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
    /** Open a specific file at line:col in the user's editor. Editors with
     *  goto-line support (code/cursor/subl) get the `-g file:line:col` form;
     *  others open the file alone. Image files are routed to the OS default viewer. */
    openFileInEditor: (filePath: string, line?: number, col?: number, editor?: string | null) => Promise<{ ok: boolean; opener?: string; error?: string }>;
    openInFinder: (cwd: string) => Promise<{ ok: boolean; opener?: string; error?: string }>;
    openInTerminal: (cwd: string) => Promise<{ ok: boolean; opener?: string; error?: string }>;
    archiveProject: (encoded: string) => Promise<{ ok: boolean; error?: string }>;
  };
  pty: {
    spawn: (payload: { tabId: string; cwd: string; cols?: number; rows?: number }) => Promise<SpawnResult>;
    write: (payload: { tabId: string; data: string }) => void;
    resize: (payload: { tabId: string; cols: number; rows: number }) => void;
    kill: (tabId: string) => void;
    onData: (tabId: string, handler: (data: string) => void) => () => void;
    onExit: (tabId: string, handler: (info: PtyExit) => void) => () => void;
    onWriteError: (handler: (ev: WriteErrorEvent) => void) => () => void;
  };
  transcripts: {
    subscribe: (payload: { tabId: string; cwd: string; sessionUuid: string }) => Promise<SubscribeResult>;
    /** Release the sub back to the LRU cache (view-switch). Does not destroy the watcher. */
    unsubscribe: (tabId: string) => Promise<{ ok: boolean }>;
    /** Permanently destroy the sub (genuine tab close). */
    closeTab: (tabId: string) => Promise<{ ok: boolean }>;
    buffer: (tabId: string) => Promise<TranscriptEvent[]>;
    pathFor: (cwd: string, sessionUuid: string) => Promise<string>;
    onEvent: (tabId: string, handler: (ev: TranscriptEvent) => void) => () => void;
  };
  sessions: {
    load: () => Promise<LoadedSessions>;
    save: (payload: LoadedSessions) => Promise<{ ok: boolean }>;
  };
  billing: {
    fetch: () => Promise<BillingFetchResult>;
  };
  usageMatrix: {
    snapshot: () => Promise<UsageMatrixSnapshot>;
    onTick: (handler: (snap: UsageMatrixSnapshot) => void) => () => void;
  };
  logs: {
    write: (scope: string, level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown) => void;
    dir: () => Promise<string>;
  };
  config: {
    readJson: (path: string) => Promise<ReadJsonResult>;
    readText: (path: string) => Promise<ReadTextResult>;
    writeJson: (path: string, data: unknown) => Promise<WriteResult>;
    writeText: (path: string, text: string) => Promise<WriteResult>;
    listDir: (path: string, opts?: { filesOnly?: boolean; dirsOnly?: boolean; includeHidden?: boolean }) => Promise<ListDirResult>;
    exists: (path: string) => Promise<boolean>;
    watch: (paths: string[]) => void;
    unwatch: (paths: string[]) => void;
    onChanged: (handler: (info: ConfigChangedEvent) => void) => () => void;
  };
  voice: {
    onHotkey: (handler: (event: VoiceHotkeyEvent) => void) => () => void;
    onHotkeyConfigChanged: (handler: (cfg: VoiceHotkeyConfig) => void) => () => void;
    getHotkeyConfig: () => Promise<VoiceHotkeyConfig>;
    setHotkeyConfig: (cfg: VoiceHotkeyConfig) => Promise<VoiceSetHotkeyResult>;
    getHotkeyConfigPath: () => Promise<string>;
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
    openExternal: (path: string) => Promise<FilesShellResult>;
    showInFinder: (path: string) => Promise<FilesShellResult>;
  };
  search: {
    files: (cwd: string, query?: string, opts?: { limit?: number }) => Promise<SearchFilesResult>;
    text: (cwd: string, query: string, opts?: { limit?: number; caseSensitive?: boolean }) => Promise<SearchTextResult>;
  };
  repo: {
    analyze: (cwd: string) => Promise<RepoAnalyzeResult | RepoAnalyzeError>;
  };
  hives: {
    list: () => Promise<HiveListResult>;
    get: (slug: string) => Promise<HiveGetResult>;
    save: (slug: string, hive: Hive) => Promise<HiveMutationResult>;
    delete: (slug: string) => Promise<HiveMutationResult>;
  };
  history: {
    aggregate: (req?: HistoryAggregateRequest) => Promise<HistoryAggregateResult>;
    listConversations: () => Promise<ListConversationsResult>;
    scanProjects: () => Promise<SessionScanResult>;
  };
  schedule: {
    state: () => Promise<ScheduleStateSnapshot>;
    setConfig: (partial: Partial<ScheduleConfig & { supervisor?: Partial<SupervisorConfig> }>) => Promise<{ ok: boolean; config: ScheduleConfig }>;
    resetJob: (slug: string) => Promise<{ ok: boolean; error?: string }>;
    runNow: () => Promise<{ ok: boolean }>;
    forceTick: () => Promise<{ ok: boolean }>;
    resume: () => Promise<{ ok: boolean }>;
    refreshReset: () => Promise<{ ok: boolean; nextReset: string | null }>;
    /** Re-scan prds/ and merge into queue.json; broadcasts updated state. */
    rescan: () => Promise<{ ok: boolean }>;
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
     *  via `onInstallProgress`. Returns { ok, exitCode } on exit. */
    install: (payload: { slug: string }) => Promise<PluginInstallResult>;
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
    /** List all agents that currently have a memory file on disk. */
    listAgents: () => Promise<AgentMemoryListAgentsResult>;
  };
  docEditor: {
    pickFile: (payload?: { lastDir?: string }) => Promise<{ path: string | null; error?: string }>;
    readFile: (path: string) => Promise<{ ok: boolean; text?: string; mtimeMs?: number; error?: string }>;
    writeFile: (path: string, text: string) => Promise<{ ok: boolean; mtimeMs?: number; error?: string }>;
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
  superagent: {
    /** Start a SuperAgent boss run — writes a structured prompt to the tab's
     *  PTY asking Claude to pick + dispatch specialists. Single run per tab. */
    start: (args: SuperAgentStartArgs) => Promise<SuperAgentStartResult>;
    /** Current run state for tab, or null if no run has been started. */
    status: (tabId: string) => Promise<SuperAgentRunState | null>;
    /** Mark the run as done. Does not interrupt Claude — the user can stop
     *  the in-PTY work via Ctrl-C; this only flips the renderer indicator. */
    stop: (tabId: string) => Promise<{ ok: boolean }>;
    onStateChanged: (handler: (ev: SuperAgentStateChangedEvent) => void) => () => void;
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
  kg: {
    /** Distilled knowledge graph + ingest status for ONE project (`cwd`).
     *  Omit `cwd` for the most-active project. */
    get: (cwd?: string) => Promise<KgState>;
    /** Projects seen in the prompt log, with per-project graph stats. */
    projects: () => Promise<KgProject[]>;
    /** Process new prompt-log lines into per-project graphs (incremental, global). */
    ingest: () => Promise<{ ok: boolean; added?: number; projects?: number; stopped?: boolean; error?: string; note?: string }>;
    /** Ask a question answered from ONE project's graph + prompts via claude -p. */
    ask: (question: string, cwd?: string) => Promise<{ ok: boolean; answer?: string; cited?: { ts: string; prompt: string }[]; error?: string }>;
    onIngestProgress: (handler: (ev: KgIngestProgress) => void) => () => void;
  };
}

export interface KgProject {
  cwd: string;
  /** Last path segment of `cwd`, for display. */
  label: string;
  /** Prompts logged for this project (real prompts only). */
  total: number;
  /** Prompts already distilled into this project's graph. */
  processed: number;
  /** total - processed. */
  pending: number;
  nodes: number;
  edges: number;
  lastIngest: string | null;
}

export interface KgNode {
  id: string;
  key: string;
  name: string;
  type: string;
  description: string;
  count: number;
  firstTs: string | null;
  lastTs: string | null;
}
export interface KgEdge {
  src: string;
  dst: string;
  relation: string;
  weight: number;
  lastTs: string | null;
}
export interface KgState {
  /** The project this graph belongs to. */
  cwd: string;
  /** Last path segment of `cwd`, for display. */
  label: string;
  nodes: KgNode[];
  edges: KgEdge[];
  status: {
    promptCount: number;
    totalPrompts: number;
    pending: number;
    lastIngest: string | null;
    ingesting: boolean;
    logPath: string;
  };
}
export interface KgIngestProgress {
  phase: 'start' | 'extract' | 'batch' | 'done' | 'error';
  ingesting: boolean;
  batch?: number;
  totalBatches?: number;
  added?: number;
  /** Set on `batch`: the project cwd whose graph just committed. */
  cwd?: string;
  error?: string;
}

declare global {
  interface Window {
    api: SessionManagerAPI;
  }
  // Injected by Vite's `define` from package.json at build time.
  const __APP_VERSION__: string;
}

export {};
