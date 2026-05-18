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
  path: string;
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

export type ScheduleJobStatus = 'pending' | 'running' | 'completed' | 'failed';

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
    openInEditor: (cwd: string, editor?: string | null) => Promise<{ ok: boolean; editor?: string; error?: string }>;
    openInFinder: (cwd: string) => Promise<{ ok: boolean; error?: string }>;
    openInTerminal: (cwd: string) => Promise<{ ok: boolean; terminal?: string; error?: string }>;
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
    unsubscribe: (tabId: string) => Promise<{ ok: boolean }>;
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
  history: {
    aggregate: (req?: HistoryAggregateRequest) => Promise<HistoryAggregateResult>;
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
}

declare global {
  interface Window {
    api: SessionManagerAPI;
  }
  // Injected by Vite's `define` from package.json at build time.
  const __APP_VERSION__: string;
}

export {};
