import type { PromptSession, PromptSessionEvent } from '../renderer/state/promptSessions';

/** Mirrors the item shape returned by main/lib/prereqs.cjs checkPrereqs(). */
export type OpsRetentionSettings = {
  runLogs: { maxAgeDays: number; keepPerSlug: number };
  runsArchiveDays: number;
  auditLogMonths: number;
  reservedMarkersKeep: number;
};
export type OpsRetentionPatch = {
  runLogs?: { maxAgeDays?: number; keepPerSlug?: number };
  runsArchiveDays?: number;
  auditLogMonths?: number;
  reservedMarkersKeep?: number;
};
export type OpsRetentionPreview = {
  runLogs: { files: number; bytes: number };
  runsArchive: { entries: number; bytes: number };
  tmp: { files: number; bytes: number };
};

export type AutoUpdaterState =
  | 'unsupported' | 'disabled' | 'idle' | 'checking'
  | 'downloading' | 'ready' | 'deferred' | 'error';

export type UpdateCheckResult = {
  current: string;
  latest: string | null;
  behind: boolean;
  channel?: 'npm' | 'installer';
  downloadUrl?: string | null;
};

/** Answer of `loginItem.status()` — whether Session Manager starts at OS login, and how. */
export type LoginItemStatus = {
  supported: boolean;
  enabled: boolean;
  mechanism: 'electron-login-item' | 'xdg-autostart' | 'launch-agent' | null;
  starts: 'npx' | 'app' | null;
  entryPath: string | null;
  reason: string | null;
};

export type AutoUpdaterStatus = {
  state: AutoUpdaterState;
  current: string;
  latest: string | null;
  progress: number | null;
  error: string | null;
  busyReason: string | null;
  lastCheckedAt: number | null;
  enabled: boolean;
  /** Latest-version probe result; present on `updater.status()` only (pushes omit it). */
  check?: UpdateCheckResult;
};

export interface PrereqItem {
  id: string;
  label: string;
  ok: boolean;
  version: string | null;
  detail: string | null;
  fix: { command: string; shell: 'sh' | 'powershell'; url?: string } | null;
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
  /** True when maxBytes was set and the file is larger than the read prefix. */
  truncated: boolean;
}

export interface ReadTextOptions {
  /** Read at most this many bytes from the start of the file instead of the whole file. */
  maxBytes?: number;
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
export type OpsWriter = 'epics' | 'scheduler' | 'project-home' | 'ui-prefs';

/** Result of config:can-write. */
export interface ConfigWriteAccess {
  ok: boolean;
  reason?: 'outside-boundary' | 'sensitive' | 'ops-root' | 'not-imported' | 'permission';
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

export interface TranscriptEventRef {
  filePath: string;
  byteOffset: number;
  byteLength: number;
}

export interface TranscriptEvent {
  kind: TranscriptEventKind;
  data: unknown;
  raw: unknown;
  /** Short, bounded human-scannable preview of `data` — never the source of truth. */
  previewText: string;
  /** Byte range of this event's source line on disk; null when classified with no file context. */
  ref: TranscriptEventRef | null;
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

export interface UsageLimitEntry {
  kind: string;
  group: string;
  percent: number | null;
  severity: string | null;
  resets_at: string | null;
  scope: { model?: { display_name?: string } } | null;
  is_active: boolean;
}

export interface UsageSnapshot {
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  seven_day_sonnet: UsageWindow | null;
  seven_day_opus: UsageWindow | null;
  seven_day_oauth_apps: UsageWindow | null;
  limits?: UsageLimitEntry[] | null;
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
  | { kind: 'meter_rate_limited'; message: string; httpStatus: number; retryAfterMs?: number | null; cached?: BillingData; staleSince?: number }
  | { kind: 'config'; message: string };

// ── MCP server live connection probe (`claude mcp list`)
export interface McpServerStatus {
  name: string;
  target: string;
  transport: 'stdio' | 'http' | 'sse' | 'ws' | 'unknown';
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'unknown';
  /** The line's trimmed text after the status glyph (e.g. "Connected"); may be empty. */
  statusText: string;
}

export interface McpStatusResult {
  ok: boolean;
  servers: McpServerStatus[];
  error?: string;
  checkedAt: number;
}

/** Mirrors schemas.mcpCheckServer (src/main/ipcSchemas.cjs). NAMES which configured server
 *  to check; main reads its config from disk (lib/mcpToolsProbe.cjs checkConfiguredMcpServer),
 *  so the renderer can't choose what is spawned. user = ~/.claude.json mcpServers; project =
 *  <cwd>/.mcp.json mcpServers (cwd: the project's absolute root); plugin = a server of the
 *  installed plugin `pluginKey` (name@marketplace). cwd counts for a project server only,
 *  pluginKey for a plugin server only. */
export type McpCheckRequest =
  | { source: 'user'; name: string; cwd?: string; pluginKey?: string }
  | { source: 'project'; name: string; cwd: string; pluginKey?: string }
  | { source: 'plugin'; name: string; cwd?: string; pluginKey: string };

/** One on-demand check of a configured MCP server (initialize → tools/list). A server
 *  that isn't configured resolves to { ok: false, status: 'failed', error: 'server not found' };
 *  an invalid request, a refused project cwd or an unparseable config file rejects, with
 *  nothing spawned. */
export type McpCheckResult =
  | { ok: true; status: 'connected'; tools: { name: string; description?: string }[]; checkedAt: number }
  | { ok: false; status: 'failed' | 'needs-auth'; error: string; checkedAt: number };

/** Mirrors WorkType (src/main/lib/prd/workTypeLibrary.cjs) / EpicTag (tagLibrary.ts) — the
 *  same Epic-mission taxonomy, reused here since an Agent persona's `tags` field is that
 *  same concept, not a free-form string list. */
export type AgentPersonaTag = 'feature' | 'bug' | 'discussion' | 'build' | 'project-home-builder' | 'art' | 'portfolio';

/** One declared `{{name}}` argument of a macro prompt (macroLibrary.cjs `MacroInputSchema`). */
export type AppPreviewStatus = 'starting' | 'running' | 'failed' | 'stopped';

/** One Epic's dev-server preview. cwd = project root, dir = folder the dev command runs in,
 *  command = the script text from package.json, startedAt = ISO time. */
export interface AppPreviewState {
  epicId: string;
  cwd: string;
  dir: string;
  script: string;
  command: string;
  port: number;
  url: string | null;
  status: AppPreviewStatus;
  error: string | null;
  pid: number | null;
  startedAt: string;
}

export interface AppPreviewScript {
  name: string;
  command: string;
}

export type AppPreviewScriptsResult =
  | { ok: true; dir: string; inWorktree: boolean; scripts: AppPreviewScript[]; suggested: string | null }
  | { ok: false; error: string };

export type AppPreviewStartResult =
  | { ok: true; state: AppPreviewState }
  | { ok: false; error: string };

export interface MacroInput {
  name: string;
  label: string;
  default?: string;
  required?: boolean;
  options?: string[];
}

/** Background-build descriptor on a built-in macro or a project Video tool (surface 'project-video'). */
export interface MacroJob {
  estimateMinutes: number;
  /** Project Video tool: repos the run may write to. */
  repoPaths?: string[];
  /** Project Video tool: true adds a human review step before the entry is published. */
  review?: boolean;
  entryKind?: 'knowledge' | 'video';
  artifactPaths?: string[];
}

export interface MacroJobDispatchInput {
  cwd: string;
  macroId: string;
  epicId: string;
  extraInstructions?: string;
  /** Per-launch effort chosen in the high-effort cost dialog: one of low, medium, high, xhigh, max;
   *  main refuses anything else. Omitted = the persona's own effort. */
  effort?: string;
  /** The press's {{name}} input values; a project Video tool renders its prompt with them. */
  inputValues?: Record<string, string>;
  /** A Demo Video press asking for the review stage: the job stops for a human review before the final save.
   *  Omitted or false = straight to the final save. */
  reviewStage?: boolean;
  /** A project Video tool press's picked library voice (voiceLibrary id); beats the tool's default voiceId.
   *  Omitted = the tool default, else the persona voice, else the kit default. */
  voiceId?: string;
}

export type MacroJobDispatchResult =
  | { ok: true; slug: string; epicId: string; entryId: string | null; stage: 'review' | 'final' | null }
  | { ok: false; error: string; activeSlug?: string };

export type MacroJobState = 'queued' | 'running' | 'done' | 'failed';

export interface MacroJobStatus {
  macroId: string;
  epicId: string | null;
  slug: string;
  state: MacroJobState;
  /** Raw queue status; a project Video tool whose entry waits on the human reports 'awaiting_review'. */
  status: 'awaiting_review' | (string & {});
  reason?: string | null;
  /** Project Video tool only: the video entry this run feeds (null when none matched). */
  entryId?: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Kind of a published artifact (lib/epic/artifactStore.cjs KINDS). */
export type ArtifactKind = 'video' | 'audio' | 'image' | 'doc' | 'data' | 'other';

/** Who produced an artifact (artifactStore.cjs cleanProducer). */
export interface ArtifactProducer {
  epicId: string | null;
  prdSlug: string | null;
  sessionId: string | null;
  taskId: string | null;
}

/** One artifacts:list row — a ledger entry + its owner folder + the owning Epic's title. */
export interface ArtifactEntry {
  /** File name inside `artifacts/<ownerId>/`. */
  name: string;
  title?: string | null;
  kind?: ArtifactKind | string;
  /** Bytes. */
  size?: number;
  sha256?: string;
  /** ISO timestamp. */
  createdAt?: string;
  producer?: ArtifactProducer | null;
  /** Epic id, or `_tasks/<task-id>` for Task-owned artifacts. */
  ownerId: string;
  epicTitle: string | null;
}

export type ArtifactsListResult =
  | { ok: true; artifacts: ArtifactEntry[] }
  | { ok: false; error: string };

/** One artifacts:worktrees row. `aheadOfBase` = commits on `branch` not on the base; `uncommitted` = `git status --porcelain` lines in the worktree (capped at 999); each null when unknown. */
export interface ArtifactWorktree {
  epicId: string;
  title: string | null;
  path: string;
  branch: string;
  aheadOfBase: number | null;
  uncommitted: number | null;
}

export type ArtifactsWorktreesResult =
  | { ok: true; worktrees: ArtifactWorktree[] }
  | { ok: false; error: string };

/** One user-defined sidebar HOT KEYS macro (macroLibrary.cjs). `projects` = absolute cwds or `'*'` (every project); a surface `'project-home'` macro is always `['*']` (only its generated artifacts are per project). */
/** One "Needs you" item an outside app posted (main/lib/feedback-remote/needsYouStore.cjs StoredItemSchema). */
export interface NeedsYouItem {
  app: string;
  id: string;
  title: string;
  why: string;
  link: string | null;
  /** 2-5 distinct choices; null = no answer buttons (informational only). */
  options: string[] | null;
  externalRef: string | null;
  status: 'open' | 'answered' | 'withdrawn';
  answer: string | null;
  createdAt: string;
  updatedAt: string;
  answeredAt: string | null;
}

export interface Macro {
  id: string;
  label: string;
  agentName: string;
  tag: AgentPersonaTag;
  prompt: string;
  projects: string[];
  /** Which strip shows this macro. Defaults to `'sessions'` when absent. */
  surface: 'sessions' | 'project-home' | 'project-video';
  /** True for a seeded, machine-authored macro (e.g. the built-in Project Home actions). */
  builtin?: boolean;
  /** Bumped by the seed when a builtin macro's definition changes, to reseed it. */
  builtinVersion?: number;
  createdAt: string;
  updatedAt: string;
  inputs?: MacroInput[];
  /** Projects ('*' or absolute cwds) this macro's session may start work in without approval. */
  autoStartTargets?: string[];
  /** True lets a script start this macro via POST /admin/macros/run. */
  scriptStart?: boolean;
  /** Set on built-ins whose press builds in the background, and on every project Video tool. */
  job?: MacroJob;
  /** A project Home / Video tool's default library voice (macroLibrary); its press preselects it. */
  voiceId?: string;
}

/** Omit `id` to create; set it to update an existing macro. */
export interface ClaudeConfigReadInput {
  fileId: 'settings' | 'claudeJson' | 'mcpJson';
  scope: 'user' | 'project' | 'local';
  cwd?: string | null;
}
export interface ClaudeConfigPatchInput extends ClaudeConfigReadInput {
  /** 1–8 non-empty segments. */
  keyPath: string[];
  /** Any JSON value; omit to delete the key. */
  value?: unknown;
}

/** toolRisk:read — scope 'user' = ~/.claude/tool-risk.json, 'project' = <cwd>/.claude/tool-risk.json. */
export interface ToolRiskReadInput {
  scope: 'user' | 'project';
  /** Required (absolute) for scope 'project'. */
  cwd?: string | null;
}
export type ToolRiskMark = 'read' | 'write' | 'confirm' | 'irreversible' | 'money' | 'public';
export interface ToolRiskReadResult {
  ok: boolean;
  path: string | null;
  exists: boolean;
  /** rule (mcp__srv__tool, mcp__srv__*, Bash(prefix:*), Bash(exact)) -> mark. */
  marks: Record<string, ToolRiskMark>;
  interactive: boolean;
  error?: string;
}
export interface ToolRiskWriteInput extends ToolRiskReadInput {
  marks: Record<string, ToolRiskMark>;
  /** Project only (refused for 'user'). true installs guard-tool-risk into
   *  <cwd>/.claude/settings.json PreToolUse; false removes it; omitted keeps the file's value. */
  interactive?: boolean;
}
export interface ToolRiskWriteResult {
  ok: boolean;
  path: string | null;
  error?: string;
}

export interface MacroSaveInput {
  id?: string;
  label: string;
  agentName: string;
  tag: AgentPersonaTag;
  prompt: string;
  projects?: string[];
  surface?: 'sessions' | 'project-home' | 'project-video';
  /** Omitted keeps the stored list on update; `[]` clears it. */
  inputs?: MacroInput[];
  /** Same omit/clear semantics as `inputs`. */
  autoStartTargets?: string[];
  /** True lets a script start this macro via POST /admin/macros/run. */
  scriptStart?: boolean;
}

/** One `agentCli.detect` row — a non-Claude agent CLI and whether it is installed. */
export interface AgentCliDetectRow {
  id: 'codex' | 'gemini' | 'antigravity' | 'cursor' | 'opencode';
  label: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  install: string | null;
  docs: string;
  login: string | null;
}

/** `agentCli.terminalCommand` result: a single-quoted shell line, or why there is none. */
export type AgentCliTerminalCommandResult =
  | { ok: true; command: string }
  | { ok: false; message: string };

/** One `packs.list` row — display data only; pack dir and laws text stay in main. */
export interface PackListRow {
  id: string;
  label: string;
  description: string;
  requires: { platform?: 'darwin' | 'linux' | 'win32' };
  /** True when the pack ships an always-on laws.md. */
  hasLaws: boolean;
}

export type PacksListResult =
  | { ok: true; packs: PackListRow[] }
  | { ok: false; error: string };

/** `packs.terminalArgs` result — `--plugin-dir`/`--append-system-prompt` args, already composed by main. */
export type PacksTerminalArgsResult = { ok: true; args: string[] };

/** One armory entry (`agentArmory.cjs`). */
export interface ArmoryItem {
  id: string;
  label: string;
  badges: ('risky' | 'banned' | 'floor')[];
}
export interface ArmoryMcpItem extends ArmoryItem {
  tools: ArmoryItem[];
  status: 'not-checked' | 'checked' | 'failing';
  scope: string;
}
export interface ArmoryPackItem extends ArmoryItem {
  skills: string[];
  source?: string;
}
export interface Armory {
  builtins: ArmoryItem[];
  bundledSkills: ArmoryItem[];
  mcpServers: ArmoryMcpItem[];
  packs: ArmoryPackItem[];
  unpackedSkills: string[];
  /** Sandbox environment profiles (`environmentProfiles.cjs`). */
  environments: { name: string; summary: string }[];
  errors: string[];
}

/** One global `~/.claude/agents/<name>.md` persona, per the Agent Library nav page. */
export interface AgentPersona {
  name: string;
  description: string | null;
  tools: string[];
  /** The `tools:` decision: undecided (no line) / bare (`[]`) / equipped / unbound (`*`). */
  loadout?: 'undecided' | 'bare' | 'equipped' | 'unbound';
  /** Declared MCP servers (`mcpServers:`); [] = none. */
  mcpServers?: string[];
  /** Declared context packs (`packs:`); [] = none. */
  packs?: string[];
  /** Declared environment profile (`environment:`); null = headless-default. */
  environment?: string | null;
  model: string | null;
  /** Per-Epic reasoning effort (`effort:` frontmatter; a `models.catalog` effort level). Null = inherit. Passed to the claude spawn as `--effort` (never `auto`). */
  effort: string | null;
  /** Default agent CLI for New Session (`agentCli:` frontmatter); null = Claude Code (or an unknown on-disk value). */
  agentCli?: AgentCliDetectRow['id'] | null;
  /** Default model for that CLI (`agentCliModel:` frontmatter); null when unset or agentCli is null. */
  agentCliModel?: string | null;
  color: string | null;
  /** Epic intent tags (tagLibrary.ts's TAG_LIBRARY) this persona is associated with. */
  tags: AgentPersonaTag[];
  /** Project cwds whose Sessions toolbar shows a one-click Action button for this
   *  agent. The single entry `'*'` means every project. Empty = no Action button. */
  projects: string[];
  /** The opening instruction that Action button sends into the new session.
   *  Null when this persona isn't wired as an Action. */
  action: string | null;
  /** Caption override for the Action button (defaults to the persona name). */
  actionLabel: string | null;
  /** "<Department> — <Human title>" (e.g. "Engineering — Architect"), free text — drives
   *  department grouping in the New Epic Agent picker. Optional/null when not set. */
  title?: string | null;
  /** Bundled-persona version stamp (seedAgentPersonas.cjs). Null for a persona that was never seeded, or has no stamp. */
  seedVersion?: number | null;
  /** Set when a newer bundled version exists that was not applied (edited file or unseen). Null/absent otherwise. */
  upgrade?: { installedVersion: number; bundledVersion: number; edited: boolean; bundledBody: string } | null;
  /** `executorOnly: true` frontmatter — persona only executes a scoped PRD; New Epic warns when it is picked as Actor. */
  executorOnly?: boolean;
  path: string;
  body: string;
  /** Project names (basename of cwd) whose currently-open tab overlays this agent. Display-only and never a key —
   *  two open projects can share a folder name; key on `overrideDetails[].cwd`. */
  overridingProjects: string[];
  /** Per open project with an overlay: which frontmatter keys / body the overlay overrides (merged view provenance).
   *  `cwd` is the open project's normalized absolute cwd — the key for `savePersona`'s `projectCwd` and
   *  `removeOverride`; `project` is its folder name, a display label only. */
  overrideDetails?: { project: string; cwd: string; fields: string[]; values?: Record<string, string>; bodyOverridden: boolean; issue: string | null }[];
}

/** Payload for `agents.savePersona` — creates or overwrites a global persona file. */
export interface AgentPersonaSaveInput {
  name: string;
  /** Previous filename, when renaming an existing persona. Omit when creating. */
  originalName?: string;
  description: string;
  tools: string[];
  /** Global save only: the loadout decision encoding `tools:` (omit = derive from `tools`). */
  loadout?: 'bare' | 'unbound' | 'equipped';
  /** Global save: declared MCP servers; omit = keep the file's value, `[]` = none. */
  mcpServers?: string[];
  /** Global save: declared context packs; omit = keep the file's value, `[]` = none. */
  packs?: string[];
  /** Global save: declared environment profile; omit = keep the file's value. */
  environment?: string;
  model: string;
  /** Effort level, or `'inherit'`/omitted to write no `effort:` line. */
  effort?: string;
  /** Default agent CLI for New Session. Omit to keep the existing file's value; `'claude'` removes it (and the model). */
  agentCli?: 'claude' | AgentCliDetectRow['id'];
  /** Model for a non-Claude agentCli; ignored otherwise. Carried over with agentCli when agentCli is omitted. */
  agentCliModel?: string;
  color: string;
  tags: AgentPersonaTag[];
  /** Project cwds (or the `'*'` sentinel) this persona's Action button appears in. Omit to keep the existing file's value; `[]` clears it. */
  projects?: string[];
  /** Opening instruction sent by this persona's Action button. Omit to keep the existing file's value. */
  action?: string;
  /** Caption override for this persona's Action button. Omit to keep the existing file's value. */
  actionLabel?: string;
  /** Omit to keep the existing file's value. */
  title?: string;
  /** An OPEN project's absolute cwd: write that project's frontmatter-only override (only `model`/`effort` are used)
   *  instead of the global file. A cwd that is not open is rejected — never a global write. */
  projectCwd?: string;
  /** Bundled-persona version stamp (seedAgentPersonas.cjs). Omit to carry over the existing file's stamp unchanged. */
  seedVersion?: number;
  /** Omit to keep the existing file's value. */
  executorOnly?: boolean;
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
 * ~/.claude/session-manager/voice.json under `turnDetector`. See PRD F8 v2.
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

export interface DelegationReadinessCheck {
  id:
    | 'scheduler-mcp'
    | 'scheduler-mcp-live'
    | 'scheduler-mcp-project-duplicate'
    | 'dev-plugin'
    | 'agent-personas'
    | 'prd-write-guard'
    | 'destructive-git-guard'
    | 'inline-implementation-guard'
    | 'self-schedule-guard';
  label: string;
  ok: boolean;
  detail: string;
  fix: string | null;
  /** Non-null when Session Manager can install this fix itself, one press. */
  fixAction: 'install-prd-write-guard' | 'install-destructive-git-guard' | 'install-inline-implementation-guard' | 'install-self-schedule-guard' | null;
  /** True when ok:true is a WARNING (still passing, but worth a human's attention) — today only scheduler-mcp-project-duplicate. */
  warn?: boolean;
  /** True when this check didn't run because a precondition (another check) already failed — reported ok:true, not a failure. */
  skipped?: boolean;
}

/** Result of installPrdWriteGuard, installDestructiveGitGuard,
 *  installInlineImplementationGuard, and installSelfScheduleGuard alike
 *  (delegationReadiness.cjs) — all four installers share one contract. */
export interface InstallGuardResult {
  ok: boolean;
  action: 'installed' | 'repaired' | 'already-installed' | 'error';
  settingsPath?: string;
  command?: string;
  error?: string;
}

export interface DelegationReadiness {
  ok: boolean;
  checks: DelegationReadinessCheck[];
}

/** First-boot seeder outcome, one per seeder id, derived from its marker file.
 *  `fix` is the manual remedy shown by the Plugins banner when `status` is 'failed' or 'exhausted'. */
export type SeedStatus = Record<
  'dev-plugin' | 'scheduler-mcp' | 'agent-personas',
  { status: 'done' | 'pending' | 'failed' | 'exhausted'; fix: string }
>;

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

// Customer feedback — client submissions + owner inbox. Shapes mirror
// src/main/lib/feedback-remote/customerFeedbackClient.cjs and customerFeedbackInbox.cjs.
export type CustomerFeedbackTag = 'bug' | 'feature' | 'discussion';
export type CustomerFeedbackStatus = 'open' | 'in_progress' | 'resolved' | 'wontfix';

export interface CustomerFeedbackItem {
  id: string;
  receipt: string | null;
  tag: CustomerFeedbackTag;
  title: string;
  body: string;
  submittedAt: number;
  status: CustomerFeedbackStatus;
  statusNote: string | null;
  statusAt: number | string | null;
  seenStatusAt: number | string | null;
  /** Images the feedback host confirmed it stored (0 when none were sent). */
  imageCount?: number;
}

export interface CustomerFeedbackInboxItem {
  id: string;
  receivedAt: string | number | null;
  tag: CustomerFeedbackTag;
  title: string;
  body: string;
  clientVersion: string | null;
  clientPlatform: string | null;
  moderation: string | null;
  status: CustomerFeedbackStatus;
  statusNote: string | null;
  statusAt: string | number | null;
  epicId: string | null;
  /** Screenshot metadata in submission order; `path` = local cache file, null until downloaded. */
  images: { mime: string; bytes: number; path: string | null }[];
  /** Host's opaque widget context (page/marks/console/network), <= 262144 bytes of JSON; untrusted shape. */
  context?: Record<string, unknown> | null;
}

export interface CustomerFeedbackOwnerInfo {
  ownerMode: boolean;
  projectCwd: string | null;
}

// Website-feedback widgets + their decrypted inbox. Results mirror
// src/main/lib/feedback-remote/siteFeedbackService.cjs (via siteFeedbackIpc.cjs, which strips
// secret-named fields); each `*Input` mirrors the same-named zod schema in src/main/ipcSchemas.cjs
// (SiteFeedbackWidgetCreateInput ↔ siteFeedbackWidgetCreate, …).
export type SiteFeedbackStatus = 'open' | 'in_progress' | 'resolved' | 'wontfix';
/** Relay box state; 'unknown' = relay unreadable, 'gone' = relay no longer lists the box. */
export type SiteFeedbackWidgetState = 'open' | 'paused' | 'unknown' | 'gone' | (string & {});
export type SiteFeedbackImageKind = 'screenshot' | 'annotated';

/** Every siteFeedback call resolves this on failure; relay error codes pass through verbatim. */
export interface SiteFeedbackFailure {
  ok: false;
  error: string;
  message: string;
  status?: number;
  retryAfterSec?: number;
}
export type SiteFeedbackResult<T> = ({ ok: true } & T) | SiteFeedbackFailure;

export interface SiteFeedbackWidget {
  boxId: string;
  projectCwd: string;
  fingerprint: string;
  createdAt: string;
  /** The one-line `<script>` embed. */
  snippet: string;
  label: string;
  allowedOrigins: string[];
  state: SiteFeedbackWidgetState;
  /** Envelopes waiting on the relay; null when the relay could not be read. */
  pending: number | null;
  hint: string | null;
}

/** updateWidget echoes the relay's view of the box. */
export interface SiteFeedbackWidgetPatched {
  boxId: string;
  label?: string;
  allowedOrigins?: string[];
  state?: string;
  pending?: number;
}

export interface SiteFeedbackSnippet {
  boxId: string;
  fingerprint: string;
  snippet: string;
}

/** meta.json of one stored item (siteFeedbackInbox.cjs InboxMeta). */
export interface SiteFeedbackItemMeta {
  hostId: string;
  boxId: string;
  receivedAt: string;
  origin: string;
  status: SiteFeedbackStatus;
  statusNote: string | null;
  epicId: string | null;
  statusChangedAt: string;
  /** The drain's signed-reporter check: true verified, false signature did not match, null / absent claimed by site. */
  reporterVerified?: boolean | null;
}

/** One inbox row (siteFeedbackInbox.cjs InboxSummary). */
export interface SiteFeedbackInboxItem extends SiteFeedbackItemMeta {
  title: string;
  type: SiteFeedbackReportType | (string & {});
  reporter: { id: string; name: string | null; email: string | null } | null;
}

export type SiteFeedbackReportType = 'bug' | 'feature' | 'other';
export type SiteFeedbackMarkColor = '#a83818' | '#f4b942' | '#2e5a3e' | '#1a1612';

export interface SiteFeedbackElementInfo {
  selector: string;
  label?: string;
  tag: string;
  id?: string;
  classes?: string[];
  text?: string;
  role?: string;
  ariaLabel?: string;
  xpath?: string;
}

export type SiteFeedbackMark =
  | { kind: 'pin'; n: number; x: number; y: number; color: SiteFeedbackMarkColor; note: string }
  | { kind: 'box'; n: number; x: number; y: number; w: number; h: number; color: SiteFeedbackMarkColor; note: string }
  | {
      kind: 'element'; n: number; x: number; y: number; w: number; h: number;
      color: SiteFeedbackMarkColor; note: string; element: SiteFeedbackElementInfo;
    }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; color: SiteFeedbackMarkColor }
  | { kind: 'draw'; points: [number, number][]; color: SiteFeedbackMarkColor }
  | { kind: 'text'; x: number; y: number; text: string; color: SiteFeedbackMarkColor };

/** Report v1 as stored (feedbackReport.cjs reportSchema / web/feedback-widget/schema/report.v1.json). */
export interface SiteFeedbackReport {
  schemaVersion: 1;
  clientReportId: string;
  project: string;
  type: SiteFeedbackReportType;
  title: string;
  details: string;
  createdAt: string;
  page: {
    url: string;
    title: string;
    viewport: { width: number; height: number; devicePixelRatio: number; scrollX: number; scrollY: number };
  };
  screenshot: { part: 'screenshot'; annotatedPart: 'annotated'; width: number; height: number; scale: number };
  marks: SiteFeedbackMark[];
  console:
    | { level: 'error'; message: string; stack?: string; source?: string; timestamp: string; count: number }[]
    | null;
  network:
    | { method: string; url: string; status: number | 'network-error' | 'timeout'; durationMs: number; timestamp: string }[]
    | null;
  user: { id: string; name?: string; email?: string; [k: string]: unknown } | null;
  client: { widgetVersion: string; captureError?: string };
}

/** One item in full (siteFeedbackInbox.cjs get()). `report` is null when report.json is unreadable. */
export interface SiteFeedbackItemDetail {
  meta: SiteFeedbackItemMeta;
  report: SiteFeedbackReport | null;
  /** Local file paths; null when that image is absent. Use inboxImage to display one. */
  imagePaths: { screenshot: string | null; annotated: string | null };
}

export interface SiteFeedbackDrainResult {
  stored: number;
  duplicates: number;
  rejected: number;
  goneBoxes: string[];
  heldBoxes: string[];
}

export interface SiteFeedbackWidgetCreateInput {
  cwd: string;
  label: string;
  allowedOrigins: string[];
}
export interface SiteFeedbackWidgetListInput {
  cwd?: string;
}
export interface SiteFeedbackWidgetUpdateInput {
  boxId: string;
  label?: string;
  allowedOrigins?: string[];
  state?: 'open' | 'paused';
}
export interface SiteFeedbackWidgetBoxInput {
  boxId: string;
}
export interface SiteFeedbackInboxListInput {
  cwd: string;
  status?: SiteFeedbackStatus;
}
export interface SiteFeedbackInboxGetInput {
  cwd: string;
  /** `FB-` + 5 of [0-9A-Z]. */
  hostId: string;
}
export interface SiteFeedbackInboxImageInput {
  cwd: string;
  hostId: string;
  /** Default 'annotated'. */
  which?: SiteFeedbackImageKind;
}
export interface SiteFeedbackInboxSetStatusInput {
  cwd: string;
  hostId: string;
  status: SiteFeedbackStatus;
  note?: string | null;
}
export interface SiteFeedbackInboxLinkEpicInput {
  cwd: string;
  hostId: string;
  epicId: string;
}

// Product telemetry (bilko.run) — anonymous, on-by-default, opt-out. See
// session-manager-operations/architecture/telemetry.md for the data model.
export interface TelemetryConfig {
  enabled: boolean;
  installId: string;
  endpoint: string;
  noticeAckedAt: string | null;
  lastMachineReportAt: string | null;
  lastMachineReportVersion: string;
  lastDailyFlushAt: string | null;
  schemaVersion: 1;
}

export interface TelemetryLastError {
  status: number;
  message: string;
  at: number;
}

export interface TelemetryStatus {
  pendingCount: number;
  sentCount: number;
  dedupedAppends: number;
  evictedCount: number;
  disabledForProcess: boolean;
  consecutiveFailures: number;
  backoffUntil: number;
  profileBuildCount: number;
  lastError: TelemetryLastError | null;
  lastFlushAt: number | null;
  lastFlushReason: string | null;
}

export interface TelemetrySetConfigResult {
  ok: boolean;
  config: TelemetryConfig;
  status: TelemetryStatus;
}

export interface TelemetryRecentRecord {
  recordId: string;
  channel: 'event' | 'log' | 'error';
  wire: Record<string, unknown>;
}

export interface TelemetryFlushResult {
  sent: string[];
  failed: string[];
  reason: string;
}

export type ScheduleFirePolicy = 'manual' | 'when-available';

export interface ScheduleConfig {
  /** Legacy on/off — kept for backwards compat with v0.4 queue.json. New
   *  installs derive enablement from firePolicy ('manual' === disabled). */
  enabled: boolean;
  /** Minutes to wait after the 5h reset before firing pending jobs.
   *  Currently unused by the fire policies ('when-available', 'manual'). */
  offsetMinutes: number;
  defaultCwd: string;
  /** Auto-fire policy. Default 'when-available'. */
  firePolicy: ScheduleFirePolicy;
  /** When firePolicy='when-available', fire only if binding-window utilization is
   *  strictly below this percent. 0–100. Default 90. */
  utilizationThreshold: number;
  schemaVersion: 1;
}

/** Mirrors JOB_STATUSES (src/main/lib/scheduler/scheduleJobSchema.cjs) — the single
 *  source of truth asserted at read time by queueStore.cjs's shapeJobs. This
 *  file can't require that .cjs module (types-only, erased at build time),
 *  so this union is a manually-kept copy; drift from JOB_STATUSES (and from
 *  the renderer's own mirrors in StatusBadge.tsx/SchedulePanel.tsx) is
 *  caught by src/main/__tests__/scheduleJobStatusDrift.test.cjs. */
export type ScheduleJobStatus = 'pending' | 'running' | 'investigating' | 'completed' | 'skipped' | 'failed' | 'needs_review' | 'quarantined';

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
  /**
   * True when a human cancelled this row. Set only by main in the schedule:state
   * payload, from lib/scheduler/cancelledRow.cjs isCancelledRow — the renderer
   * must read this and never re-derive the rule. Never stored in queue.json.
   */
  cancelled?: boolean;
  macroId?: string | null;
  /** Content id of the AgentSnapshot the first dispatch pinned; a resume re-runs it, never the live persona. */
  agentSnapshotId?: string;
  /** Validator only: dispatch-time { ids, failedIds } per judged PRD; the verdict is cross-checked against it, never a re-run. */
  validatorCriteriaExpected?: Record<string, { ids: string[]; failedIds: string[] }>;
  /** PRD frontmatter artifact-only declaration (PRD 3114). */
  deliverable?: 'artifact' | null;
  artifactPaths?: string[] | null;
  /** PRD frontmatter library voice (in-process only); handed to the job as SM_VOICE_ID. */
  voiceId?: string | null;
  /** PRD frontmatter persona (queue rows carry it; absent = dev-lead). */
  agentType?: string | null;
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
  /** Structured terminal-outcome label set alongside `error` (never replacing
   *  it) so a reader can tell "the gate ran and went red" (failed) apart from
   *  "the gate never got to run" (never_ran) — reaperHelpers.cjs's
   *  resolveReapGateOutcome (PRD 1109). 'passed' means the run's own last
   *  SCHEDULER_VERDICT line said PASS — NOT that the scheduler itself ran
   *  the gate; a clean CLI exit with no verdict line reads 'unknown'. */
  gateOutcome?: 'passed' | 'failed' | 'never_ran' | 'unknown';
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
  /** Wave-authoring decision (scheduler wave-disposition PRD): 'append' (this
   *  row's dependsOn extends the Epic's existing chain) or 'new-head' (an
   *  independent root). Refreshed from the PRD file on every reconcile, like
   *  dependsOn above; null when this row never needed the decision. */
  disposition?: 'append' | 'new-head' | null;
  /** Durable wave identity stamped into PRD frontmatter by createPrd(); buildPlans groups by it. Null on PRDs that predate the stamp. */
  planId?: string | null;
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
  /** Renderer-only: true for a row synthesized from an archived PRD file (no queue row
   *  exists to act on) — see lib/archivedPlanRows. Never present in queue.json. */
  synthetic?: boolean;
  /** Bounded trail of accepted status transitions (scheduleJobTransitions.cjs's
   *  transitionJob), oldest-first, capped at ~20 entries. Lets a status
   *  change be reviewed after the fact instead of only inferred from a
   *  heartbeat count. */
  statusHistory?: ScheduleJobStatusHistoryEntry[];
  /** Opt-in PRD frontmatter flag (PRD 1107): dispatched only when zero other
   *  jobs are running machine-wide, and holds an exclusive lease over the
   *  whole session-slot pool for its run — no other job dispatches while it
   *  is running. For timing-sensitive acceptance criteria (frame time,
   *  performance fences) that need to trust their own numbers. */
  quietMachine?: boolean;
  /** True when a `quietMachine` job was dispatched anyway after waiting past
   *  the configurable quiet-wait interval without the machine going quiet —
   *  tells a reader its measurements ran under contention. */
  quietLeaseDegraded?: boolean;
  /** Process-group survivors childWithLog.cjs's sweepChildProcessGroup found
   *  still alive right before sweeping them (PRD 1110). [] in the normal
   *  case — a non-empty array means the job backgrounded work that outlived
   *  it and had to be reaped; the job's `status` is unaffected. */
  leakedDescendants?: LeakedDescendant[];
  /** Path to a patch file (`<slug>.uncommitted.patch` in the run dir)
   *  salvaging this job's uncommitted worktree/in-place diff before it was
   *  lost — set whenever the commit-guard's worktree or in-place salvage
   *  pass produced one (PRD 1098). */
  salvagePatch?: string | null;
  /** Artifact evidence spawnJob captured for a declared artifact-only PRD
   *  before its job worktree was removed, bound to the capturing run's
   *  `runId`; the stale needs_review rescan reuses it only for that run. */
  artifactEvidence?: {
    runId: string;
    ok: boolean;
    verified: unknown[];
    paths: string[];
    capturedAt: string;
  } | null;
  /** Commit + ref pinning a reaped run's uncommitted checkout work before the checkout was lost (PRD 2892). */
  uncommittedSnapshot?: { sha: string; ref: string };
  /** Why a pending row is not being dispatched this tick (worktree cap, launch circuit breaker). */
  heldReason?: string;
  /** Set when this row's last dispatch never got a model turn (issue #11): the
   *  API's own message, and how many times in a row it has happened. Cleared
   *  by the next run that finalizes. */
  launchFailure?: {
    kind: ScheduleLaunchFailureKind;
    httpStatus: number | null;
    message: string;
    at: string;
    runId: string | null;
    count: number;
    mitigationApplied: boolean;
  };
  /** Closed-set outcome taxonomy stamped at finalize: 'completed',
   *  'impl_failed:exit_N', 'signal_kill', 'signal_kill_with_commit',
   *  'verifier:<verdict>', 'worktree_integration_failed', 'launch_failure:<kind>'. */
  terminalReason?: string;
  /** The newly-dirty paths a terminal run left uncommitted, diffed against
   *  the pre-run baseline — set on EVERY terminal outcome that left dirt
   *  (completed/failed/needs_review alike, not just the exit=0 commit-guard
   *  path), deleted when the run left nothing. Capped at 50 entries;
   *  `leftoverCount` carries the true total and `leftoverPathsTruncated` is
   *  set when the list was cut. Lets the queue row show e.g. "left 4 files
   *  uncommitted" on a bare `failed` row, distinguishing it from one that
   *  left nothing. */
  leftoverPaths?: string[];
  leftoverCount?: number;
  leftoverPathsTruncated?: boolean;
  /** PRD 1128: once resume-first recovery is spent and the job STILL parked
   *  needs_review with 'uncommitted_changes', its recorded leftover paths are
   *  quarantined onto this dedicated `sm-salvage/<slug>` branch (never moving
   *  the checked-out branch) so the shared tree returns to its pre-run
   *  baseline instead of poisoning every later worktree merge for this cwd. */
  quarantinedTo?: string;
  quarantinedCommit?: string;
  quarantinedPaths?: string[];
  /** Stamped by findOverrunningJobs' escalation while status is 'running' —
   *  a running job whose elapsed time exceeds JOB_OVERRUN_FACTOR × its own
   *  PRD's estimateMinutes. Advisory only; re-stamped in place every sweep,
   *  cleared on finish/reap/reset (scheduler.cjs). */
  overrun?: { ratio: number; ranMs: number; estimateMinutes: number; at: string };
}

export interface LeakedDescendant {
  pid: number;
  pcpu: number;
  etimes: number;
  comm: string;
}

export interface ScheduleJobStatusHistoryEntry {
  from: string | null;
  to: string;
  reason: string | null;
  source: string | null;
  at: string;
}

export type SchedulePauseReason = 'rate_limit' | 'auth' | 'network' | 'manual' | 'agent' | 'reset_failure';

export interface SchedulePauseInfo {
  reason: SchedulePauseReason;
  /** When the pause was first set (ISO). */
  since: string;
  /** ISO timestamp at which auto-resume will fire (typically next 5h reset).
   *  null means "indefinite — wait for manual Run now". */
  resumeAt: string | null;
  /** Present when reason is 'agent': who paused and why. */
  by?: { originClaudeSessionId: string | null; cwd: string | null; reason: string | null } | null;
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
  /** PRD frontmatter `dependsOn` — slugs that must complete before this PRD
   *  is eligible. Mirrors ScheduleJob.dependsOn; parsed by parsePrd but
   *  previously dropped by listPrdsInternal before reaching this type, the
   *  same class of bug this field's sibling comment (epicId) warns about. */
  dependsOn?: string[] | null;
  /** PRD frontmatter `disposition` — see ScheduleJob.disposition. */
  disposition?: 'append' | 'new-head' | null;
  /** PRD frontmatter `planId` — see ScheduleJob.planId. */
  planId?: string | null;
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

/** One `pending` job held by an unsatisfied dependency, and which dep. */
export interface ScheduleJobHold {
  slug: string;
  /** The dependency slug holding this row, or null for a non-dependency hold (launch circuit breaker). */
  dep: string | null;
  depStatus: string | null;
  /** Human-readable hold reason when `dep` is null. */
  reason?: string | null;
}

/** Why a headless run never got a model turn (lib/scheduler/launchFailure.cjs, issue #11). */
export type ScheduleLaunchFailureKind =
  | 'model_config_rejected'
  | 'bad_request'
  | 'auth_failed'
  | 'model_not_found'
  | 'api_overloaded'
  | 'api_error';

/** One persona's open launch circuit breaker. Keyed by the PRD `agentType` (or 'default' / 'investigation'). */
export interface ScheduleLaunchBlock {
  kind: ScheduleLaunchFailureKind;
  httpStatus: number | null;
  /** The API's own message, verbatim (bounded). */
  message: string;
  /** Operator-facing explanation + the action that clears it. */
  hint: string;
  since: string;
  lastAt: string;
  /** ISO time of the next half-open probe; null = exhausted (waits for a CLI version change or Retry). */
  until: string | null;
  attempts: number;
  exhausted: boolean;
  claudeVersion: string | null;
  lastSlug: string | null;
  lastRunId: string | null;
  mitigationEnv: Record<string, string> | null;
  mitigationApplied: boolean;
  probing: { slug: string; at: string } | null;
}

/** Degraded-mode env a persona is currently launching with (e.g. thinking disabled for an outdated CLI). */
export interface ScheduleLaunchMitigation {
  kind: ScheduleLaunchFailureKind;
  env: Record<string, string>;
  since: string;
  claudeVersion: string | null;
  hint: string;
}

/** Outcome of the scheduler's last tick — why the batch was (or wasn't) fired.
 *  Every field is computed by tickQueue; nothing here is derived in the UI. */
export interface ScheduleLastTick {
  fired: boolean;
  reason: 'held' | 'slots-exhausted' | 'memory-deferred' | 'already-running' | 'drained' | 'paused' | 'utilization-held' | 'manual-fire-policy' | 'usage-meter-degraded' | 'load-deferred' | string;
  /** Human-readable one-liner for the binding constraint, when there is one. */
  detail?: string;
  deferredCount?: number;
  runningCount?: number;
  count?: number;
  availableMb?: number;
  threshold?: number;
  holders?: { owner: string; at: string }[];
  holds?: ScheduleJobHold[];
  at: string;
}

export interface ScheduleEffectiveConcurrency {
  /** Total slots in the machine-wide sessionSlots pool — the ONLY concurrency
   *  limit. The scheduler no longer carries a private concurrencyCap. */
  cap: number;
  /** Slots free right now (pool total minus held, incl. chat runs). */
  free: number;
  /** 'env' when SM_SESSION_SLOTS pins the pool; 'pool' when the persisted
   *  Home-tab value governs. */
  source: 'env' | 'pool';
}

export interface ScheduleStallEvent {
  message: string;
  total: number;
  byProject: Record<string, Record<string, number>>;
}

export interface ScheduleStateSnapshot {
  config: ScheduleConfig & { supervisor?: SupervisorConfig };
  /** Why the last tick fired (or didn't). Null before the first tick. */
  lastTick?: ScheduleLastTick | null;
  jobs: ScheduleJob[];
  lastRunAt: string | null;
  /** Stamped every time tickQueue reaches the picker at all, whether or not
   *  that pass ends in a launch — distinct from lastRunAt (only stamped on an
   *  actual launch). See classifyQueueHealth's header comment. */
  lastDispatchAttemptAt?: string | null;
  nextReset: string | null;
  /** Set when scheduler self-paused (rate-limit detected). null when running normally. */
  paused: SchedulePauseInfo | null;
  /** Launch circuit breakers currently open, keyed by persona. Empty when every persona can launch. */
  launchBlocks?: Record<string, ScheduleLaunchBlock>;
  /** Degraded-mode launch env in force per persona. Empty when nothing is degraded. */
  launchMitigations?: Record<string, ScheduleLaunchMitigation>;
  /** Latest BINDING-window utilization percent (0–100) cached from billing.fetchUsage. null if unknown. */
  utilization: number | null;
  /** Name/kind of the window `utilization` reads (e.g. 'five_hour', 'weekly_all'). null if unknown. */
  utilizationWindow?: string | null;
  /** Non-null while the when-available gate is holding the queue on utilization: which window, and its reset. */
  utilizationHold?: { window: string | null; percent: number; threshold: number; resetsAt: string | null } | null;
  /** Pro-rated 'pause above' for the binding window of the last known reading (rises from config.utilizationThreshold to 100 as the window nears reset). null with no known reading. */
  effectiveUtilizationThreshold?: number | null;
  /** Poll health — last billing poll result; used to detect stale utilization. */
  pollHealth?: SchedulePollHealth;
  /** Effective concurrency cap and whether it's env-pinned or config-driven. */
  effectiveConcurrency: ScheduleEffectiveConcurrency;
  /**
   * CPU-load launch gate (PRD 1085): why nothing is launching when the box
   * is saturated. Null before the first tick that evaluated it.
   */
  loadGate?: ScheduleLoadGate | null;
}

export interface ScheduleLoadGate {
  /** True when this tick's launches were withheld because of load. */
  gated: boolean;
  /** True when load would have gated but an explicit Run now bypassed it. */
  bypassed: boolean;
  /** 1-minute load average divided by core count. */
  ratio: number;
  /** LOAD_GATE_PER_CORE (or SM_LOAD_GATE_PER_CORE); 0 means disabled. */
  threshold: number;
  loadavg1: number | null;
  cores: number;
  /** Measured machine-wide CPU busy fraction (0..1) over cpuWindowMs, or null with no sample. */
  cpuBusy: number | null;
  /** Machine-wide iowait fraction (0..1) over the same window (not counted as busy), or null with no sample. */
  cpuIowait: number | null;
  /** Length of the CPU sample window in ms, or null with no sample. */
  cpuWindowMs: number | null;
  /** True when loadavg was over threshold but the CPU sample showed it mostly idle, so launches proceed. */
  standDown: boolean;
  /** Time this gate itself held a batch that slots and memory admitted; 0 when not holding */
  heldMs: number;
  /** True on the tick where a long hold reached its limit with the CPU not saturated (or no sample) and one job was let through. A saturated CPU keeps holding instead. */
  yielded: boolean;
  at: string;
}

/** One dependency-chain group blocked on a terminal (failed/skipped) row — computeBlockedChains' shape. */
export interface ScheduleBlockedChain {
  cwd: string;
  blockedBy: string[];
  blocked: number;
}

/** classifyQueueHealth's verdict — the one honest cause behind a stale-looking queue. */
export interface ScheduleQueueHealthVerdict {
  kind: 'paused' | 'launch-blocked' | 'idle' | 'saturated' | 'blocked' | 'stalled' | 'running';
  cwd: string | null;
  pending: number;
  needsReviewCount: number;
  runningCount: number;
  /** Pending rows whose dependsOn chain is fully satisfied right now — always computed, regardless of kind. */
  dispatchable: number;
  blockedChains: ScheduleBlockedChain[];
  /** Present on 'blocked' / 'stalled' — ms since lastDispatchAttemptAt. */
  idleMs?: number;
  /** Present on 'paused'. */
  reason?: string | null;
  /** Present on 'launch-blocked'. */
  agentType?: string;
  block?: ScheduleLaunchBlock;
  /** Present on 'saturated'. */
  totalSlots?: number | null;
}

export interface ScheduleQueueHealthResult {
  /** True when queue.json was unreadable — every other field is absent; render "unknown", never a zero. */
  unknown: boolean;
  reason?: string;
  now?: number;
  verdict?: ScheduleQueueHealthVerdict;
  /** Machine-wide session slot pool — not scoped to the requested cwd. */
  slots?: { inUse: number; total: number; free: number; source: 'env' | 'pool' };
  /** Oldest currently-running job's age in ms, across every project. null when nothing is running. */
  oldestRunningAgeMs?: number | null;
  lastRunAt?: string | null;
  lastDispatchAttemptAt?: string | null;
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
    /** Recorded 1-hour part of cacheCreationTokens. */
    cacheCreation1hTokens?: number;
    /** Part of cacheCreationTokens with no recorded 5-minute / 1-hour split (rollup lines written before v4); priced at the 1-hour rate and marked estimated when above zero. */
    cacheCreationUnknownTokens?: number;
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
    /** Recorded 1-hour part of cacheCreationTokens. */
    cacheCreation1hTokens?: number;
    /** Part of cacheCreationTokens with no recorded 5-minute / 1-hour split (rollup lines written before v4); priced at the 1-hour rate and marked estimated when above zero. */
    cacheCreationUnknownTokens?: number;
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
    /** Recorded 1-hour part of cacheCreationTokens. */
    cacheCreation1hTokens?: number;
    /** Part of cacheCreationTokens with no recorded 5-minute / 1-hour split (rollup lines written before v4); priced at the 1-hour rate and marked estimated when above zero. */
    cacheCreationUnknownTokens?: number;
    costUsd: number;
    estimated?: boolean;
  }>;
  toolsByProject: Record<string, Record<string, number>>;
  generatedAt: number;
  /** Dates included in `days` that are NOT yet finalized (typically just today). */
  provisionalDates: string[];
  /** Dates in range finalized under an older rollup version (counted before once-per-call counting; read high). */
  legacyDates: string[];
}

// ────────────────────────────────────────────── Tasks (main/lib/tasks/taskIpc.cjs)
// Request types mirror the zod schemas of the same name in main/ipcSchemas.cjs.

/** Mirrors ipcSchemas TaskListQuery. since/until are ISO timestamps (inclusive). */
export interface TaskListQuery {
  cwd: string;
  since?: string;
  until?: string;
  pipeline?: string;
  runId?: string;
  step?: string;
  agent?: string;
  status?: string;
  source?: string;
  /** 1..200, default 50. */
  limit?: number;
  offset?: number;
}

/** Mirrors ipcSchemas TaskGetQuery. */
export interface TaskGetQuery {
  cwd: string;
  id: string;
}

/** Mirrors ipcSchemas TaskSwitchQuery. */
export interface TaskSwitchQuery {
  cwd: string;
}

/** Mirrors ipcSchemas TaskSwitchSet. */
export interface TaskSwitchSet {
  cwd: string;
  enabled: boolean;
}

export interface TaskUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [key: string]: unknown;
}

/**
 * One folded ledger summary row (start ⊕ end, or an imported line) as
 * taskLedger.listTasks returns it. Hashes + byte counts only — never text.
 */
export interface TaskSummary {
  v?: number;
  taskId: string;
  /** 'sm' (ran through Session Manager) or 'direct' (imported). */
  source?: 'sm' | 'direct' | string;
  /** Ledger status; 'running' / 'interrupted' are derived when no end line exists. */
  status: 'running' | 'interrupted' | 'ok' | 'error' | 'timeout' | 'caller_gone' | 'rate_limited' | 'spawn_failed' | string;
  cwd?: string;
  runtimeCwd?: string;
  agent?: string;
  model?: string;
  effort?: string;
  missionId?: string | null;
  priority?: string;
  caller?: { pipeline?: string; runId?: string; step?: string; attempt?: number; [key: string]: unknown };
  importId?: string;
  startedAt?: string;
  endedAt?: string;
  timeoutSec?: number;
  slotWaitSec?: number;
  slotWaitMs?: number;
  durationMs?: number;
  exitCode?: number | null;
  usage?: TaskUsage | null;
  modelUsage?: Record<string, unknown> | null;
  costUsd?: number | null;
  cliCostUsd?: number | null;
  numTurns?: number | null;
  quota?: { rateLimited: boolean; resetsAt: string | null };
  error?: string | null;
  promptSha256?: string;
  promptBytes?: number;
  outputSha256?: string;
  outputBytes?: number;
}

/** The Task's body file (tasks/bodies/<taskId>.json); prompt/output capped at 1 MiB each. */
export interface TaskBody {
  v?: number;
  taskId: string;
  startedAt?: string;
  prompt?: string;
  promptTruncated?: boolean;
  output?: string;
  outputTruncated?: boolean;
  stderrTail?: string;
  envelope?: unknown;
}

/**
 * taskLedger.getTask: the summary row plus its body (null when the body
 * file is missing). sha256s/byte counts sit on the summary fields.
 */
export interface TaskDetail extends TaskSummary {
  body: TaskBody | null;
}

export type TaskListResult =
  | { ok: true; tasks: TaskSummary[]; total: number; hasMore: boolean; skippedLines: number }
  | { ok: false; error: string };

export type TaskGetResult =
  | { ok: true; task: TaskDetail | null }
  | { ok: false; error: string };

/** Who made the last change to a project's 'Scripts may run Tasks' switch (taskSwitch.cjs). */
export type TaskSwitchBy =
  | { via: 'ui' }
  | { via: 'agent'; claudeSessionId: string; quote: string; promptAt: string }
  | { via: 'unknown' };

export type TaskGetSwitchResult =
  | { ok: true; enabled: boolean; changedAt?: string | null; by?: TaskSwitchBy | null }
  | { ok: false; error: string };

export type TaskSetSwitchResult =
  | { ok: true; enabled: boolean; changedAt: string }
  | { ok: false; error: string };


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

export interface MemoryAgentTarget {
  name: string;
  scope: 'user' | 'project' | 'local';
}

/** Addressing for memory:* calls. `agent` targets an agent's native memory dir; `cwd` drives native resolution. */
export interface MemoryTarget {
  workspace?: string;
  cwd?: string;
  agent?: MemoryAgentTarget;
}

export interface MemoryAgent {
  name: string;
  origin: 'user' | 'project';
  memoryScope: 'user' | 'project' | 'local' | null;
  agentFile: string;
}

export interface MemoryIndexHealth {
  lines: number;
  bytes: number;
  maxLines: number;
  maxBytes: number;
  overBudget: boolean;
  nearBudget: boolean;
  orphans: string[];
  dangling: string[];
}

export interface MemoryListResult {
  entries: MemoryEntry[];
  workspace: string;
  dir: string;
  autoMemoryEnabled: boolean;
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
  /** Refs whose path was git-renamed to an existing target — not dead. */
  movedRefs: { from: string; to: string }[];
  stale: boolean;
  reasons: string[];
  description: string | null;
  type: string | null;
  originSessionId: string | null;
  outLinks: string[];
  danglingLinks: string[];
}

export type MemoryFixProposal = {
  ok: boolean;
  action: 'update' | 'delete' | 'fold' | 'keep';
  summary: string;
  reason: string;
  content: string;
  fold: { target: string; anchor: string; insert: string } | null;
  error?: string;
};

export interface MemoryStaleResult {
  entries: MemoryStaleEntry[];
  workspace: string;
  error: string | null;
  index?: MemoryIndexHealth;
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

// ────────────────────────────────────────────── Project Pages (single home.html)
export interface ProjectPageMeta {
  id: string;
  title: string;
  topic: string;
  createdAt: string;
  model: string;
}

export interface ProjectVideoMeta {
  id: string;
  title: string;
  kind: 'project-demo' | 'blog-post' | 'feature' | 'episode' | 'tiktok' | 'marketing';
  /** TikTok post copy (caption 1-150 chars, audience 1-200 chars); absent on other kinds and older entries. */
  post?: { caption: string; audience: string };
  /** Frame shape from the document's sm-demo-aspect tag; absent on older entries (treat as '16:9'). */
  aspect?: '16:9' | '9:16';
  /** The `Video target:` text the video was built for (a post path or URL, or a feature name); absent for a Project demo. */
  target?: string;
  style: string;
  lengthS: number;
  createdAt: string;
  character: string | null;
  sources: { claim: string; source: string; ref: string }[];
  report: {
    lufs: number | null;
    truePeakDb: number | null;
    speechS: number | null;
    readingGrade: number | null;
    checks: { id: string; ok: boolean; detail: string }[];
    bytes: number;
  };
  macroVersion: number;
  seedVersion: number;
  model: string;
  effort: string;
}

/** One library folder (knowledge/<id>/ or videos/<id>/); `meta` is null when meta.json is missing/invalid (see `error`). */
export interface ProjectLibraryEntry<M> {
  id: string;
  /** Absolute path of the entry's index.html — load via smfile://. */
  path: string;
  mtimeMs: number;
  meta: M | null;
  error: string | null;
  /** Video entries only: absolute paths of the exported videos/<id>/video.mp4 and poster.png, null when absent. */
  exports?: { mp4: string | null; poster: string | null };
}

/** A video run that ended without a video by design (videos/<id>/outcome.json, no index.html). */
export interface ProjectVideoOutcome {
  id: string;
  outcome: 'season-complete';
  /** The one-line text the run saved. */
  text: string;
  /** ISO time the outcome was recorded. */
  at: string;
}

export interface ProjectPagesGetResult {
  /** Video outcomes, newest first; absent when there are none. */
  outcomes?: ProjectVideoOutcome[];
  /** The project's saved persona (videos/_character), or null when none/invalid. */
  persona?: { name: string } | null;
  /** Knowledge pages, newest first. */
  knowledge: ProjectLibraryEntry<ProjectPageMeta>[];
  /** Videos, newest first. */
  videos: ProjectLibraryEntry<ProjectVideoMeta>[];
  /** Contents of the `overview` knowledge page, or null when there is none. */
  html: string | null;
  /** The overview page's mtime, or null when `html` is null. */
  mtimeMs: number | null;
  /** The newest video's absolute path + mtime, or null when there is none. Load it via smfile:// — never pass its HTML across IPC. */
  demoVideo: { path: string; mtimeMs: number } | null;
}

// ────────────────────────────────────────────── Project Pages: video review step
// Mirrors src/main/lib/project-pages/videoReview.cjs (readReview / listReviews) and
// src/main/lib/project-pages/videoReviewIpc.cjs (project-videos:review-list / review-decide / review-retry).

/** Lifecycle of one Video tool entry's human review step. */
export type VideoReviewStatus = 'building' | 'waiting' | 'approved' | 'changes-requested';

/** dispatch.json — the tool run that is building (or last built) the entry. */
export interface VideoReviewDispatch {
  entryId: string;
  macroId: string;
  /** The Epic that built the entry; approvals run there. */
  epicId: string | null;
  /** The queued PRD slug of the run. */
  slug: string;
  /** e.g. 'review' or 'final'. */
  stage: string;
  inputValues: Record<string, string>;
  extraInstructions: string;
  /** ISO timestamp. */
  dispatchedAt: string;
}

/** material.json — what the tool saved for the human to look at. */
export interface VideoReviewMaterial {
  entryId: string;
  /** Plain text — never render as HTML. */
  text: string;
  /** Review images; `path` is absolute — load via smfile://. */
  images: { name: string; path: string }[];
  /** ISO timestamp. */
  savedAt: string;
}

/** decision.json — the human decision (written only by review-decide). */
export interface VideoReviewDecision {
  entryId: string;
  decision: 'approve' | 'changes';
  /** Present when decision === 'changes'. */
  note?: string;
  /** Local-time stamp ('2026-11-22 13:05 PST'), present when decision === 'approve'. */
  at?: string;
  /** ISO timestamp. */
  decidedAt: string;
}

/** One entry with a review folder, as returned by `projectPages.reviewList`. */
export interface VideoReview {
  entryId: string;
  dispatch: VideoReviewDispatch | null;
  /** null only when the folder holds no records at all. */
  status: VideoReviewStatus | null;
  material: VideoReviewMaterial | null;
  decision: VideoReviewDecision | null;
  /** The queue job of dispatch.slug (jobStatusesBySlug), or null when there is no dispatch or no job row. */
  job: VideoReviewJob | null;
  /** True only for an approved entry whose recorded final-stage run ended failed (retryable()). */
  canRetry: boolean;
}

/** The queue job behind an entry's recorded dispatch; `state` follows stateOf in macroJobStatus.cjs. */
export interface VideoReviewJob {
  slug: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  /** Raw queue status. */
  status: string | null;
  /** One-line failure reason; null unless state === 'failed'. */
  reason: string | null;
}

export interface VideoReviewListPayload {
  cwd: string;
}

export interface VideoReviewDecidePayload {
  cwd: string;
  entryId: string;
  decision: 'approve' | 'changes';
  /** Required (non-blank, at most 2000 chars) when decision === 'changes'. */
  note?: string;
}

export type VideoReviewDecideResult =
  | { ok: true; slug: string; stage: string; decision: VideoReviewDecision }
  | { ok: false; error: string };

export interface VideoReviewRetryPayload {
  cwd: string;
  entryId: string;
}

/** The final-stage dispatch result (macroJobDispatch); writes no decision. */
export type VideoReviewRetryResult =
  | { ok: true; slug: string; epicId: string; entryId?: string | null; stage?: string }
  | { ok: false; error: string; activeSlug?: string };

// ────────────────────────────────────────────── Project Pages: 'Scripts may run Demo Video' switch
// Mirrors src/main/lib/project-pages/videoScriptPress.cjs (getVideoScriptSwitch) and
// src/main/lib/project-pages/videoScriptSwitchIpc.cjs (videos:script-switch-get / script-switch-set).

export interface VideoScriptSwitchGetPayload {
  cwd: string;
}

export interface VideoScriptSwitchSetPayload {
  cwd: string;
  enabled: boolean;
}

/** One project's switch; changedAt/by are null when it was never set. Same attribution shape as TaskSwitchBy. */
export interface VideoScriptSwitchState {
  enabled: boolean;
  changedAt: string | null;
  by: TaskSwitchBy | null;
}

// ────────────────────────────────────────────── Voices screen
// Mirrors src/main/lib/demo-video-kit/voiceLibrary.cjs (listVoices) and
// src/main/lib/project-pages/voicesIpc.cjs (voices:list / preview / approve / unapprove / delete).
// voicesIpc is the ONLY writer of voice approvals and deletions; renderer IPC only.

export type VoiceScope = 'project' | 'machine' | 'builtin';

export interface VoiceLastPreview {
  /** ISO time the newest preview of this voice in this project left the voice lane. */
  at: string | null;
  wallMs: number | null;
  audioSeconds: number | null;
}

export interface VoiceLaneTicket {
  voiceId: string | null;
  label: string | null;
  projectRoot: string | null;
  pid: number;
  since: string;
  /** 0 = currently speaking. */
  position: number;
}

export interface VoiceLibraryEntry {
  id: string;
  label: string;
  voice: Record<string, unknown>;
  engine: string;
  sampleText: string;
  licence: string;
  heavy: boolean;
  pinFiles?: string[];
  scope: VoiceScope;
  /** Absent on built-ins. */
  file?: string;
  /** Built-ins only: whether the Kokoro model is installed. */
  installed?: boolean;
  approved: boolean;
  /** False when approved but the voice changed since approval (the voice is refused until re-approved). */
  pinOk: boolean;
  lastPreview: VoiceLastPreview | null;
  inLane: { lane: string; position: number } | null;
}

export interface VoicesListResult {
  voices: VoiceLibraryEntry[];
  errors: Array<{ file: string; error: string }>;
  /** voiceLane.laneSnapshot(): live tickets per lane ('heavy' | 'light'). */
  lane: Record<string, VoiceLaneTicket[]>;
}

export interface VoicesListPayload {
  cwd: string;
}

export interface VoicesPreviewPayload {
  cwd: string;
  voiceId: string;
  /** 1-300 chars after trimming. */
  text: string;
}

export type VoicesPreviewResult =
  | { ok: true; cached: boolean; wavPath: string; bytes: Uint8Array }
  | { ok: false; error: string };

export interface VoicesVoicePayload {
  cwd: string;
  voiceId: string;
}

export type VoicesApproveResult =
  | { ok: true; voiceId: string; scope: 'project' | 'machine'; pin: string; approvedAt: string }
  | { ok: false; error: string };

export type VoicesUnapproveResult = { ok: true; voiceId: string } | { ok: false; error: string };

export type VoicesDeleteResult =
  | { ok: true; voiceId: string; scope: 'project' | 'machine'; file: string }
  | { ok: false; error: string };

// ────────────────────────────────────────────── Project Pages: markdown link network
// Mirrors the JSDoc typedefs of the same names in src/main/lib/mdNetworkScan.cjs.
// Every path is repo-relative POSIX.

/** 'hub' = the root map doc: root AGENTS.md, else root CLAUDE.md (a root CLAUDE.md beside AGENTS.md is reached from it); 'owner' = a CLAUDE.md / README.md / AGENTS.md one link from it; 'doc' = any other doc. */
export type MdNetworkNodeType = 'hub' | 'owner' | 'doc';

/** One doc reachable by links from the root map doc (root AGENTS.md, else root CLAUDE.md). */
export interface MdNetworkNode {
  /** Same as `path`. */
  id: string;
  path: string;
  /** Links from the root along the shortest path (0 = the root). */
  depth: number;
  type: MdNetworkNodeType;
  /** Edges out of this doc, broken ones included. */
  linksOut: number;
  /** Edges into this doc. */
  linkedFrom: number;
}

/** One per distinct (from, to) pair; a self link, or a link to a present non-doc target (code file, folder), makes no edge. */
export interface MdNetworkEdge {
  from: string;
  /** For a broken edge, the missing (or outside-the-project) resolved target — not a node. */
  to: string;
  broken?: boolean;
}

/** A link whose target does not exist or is outside the project. */
export interface MdNetworkBrokenLink {
  type: 'broken-link';
  /** The linking doc. */
  file: string;
  /** 1-based line of the link in `file`. */
  line: number;
  /** The target as written, `#fragment` / `?query` stripped. */
  target: string;
  /** `target` resolved against `file`'s folder. */
  to: string;
  /** `${file}:${line} → ${target}` */
  where: string;
  detail: string;
  /** The target is not tracked in git but is gitignored or on disk here: the link works only on this machine. */
  localOnly?: boolean;
}

/** Docs that no link path from the root reaches, grouped by top-level folder. */
export interface MdNetworkOrphan {
  type: 'orphan';
  /** The top-level folder with a trailing slash (`./` for root-level docs). */
  where: string;
  count: number;
  paths: string[];
  detail: string;
}

/** Broken links come first (in walk order), then orphan groups (by folder). */
export type MdNetworkFinding = MdNetworkBrokenLink | MdNetworkOrphan;

/**
 * Two docs that share the same text (src/main/lib/mdNetworkScan.cjs via mdDuplicates.cjs
 * findDuplicates): `sharedRuns` distinct 8-word runs in common, up to 3 shared passages in
 * `samples`, `copy` when the shared runs cover at least 90% of the larger doc.
 */
export interface MdDuplicatePair {
  a: string;
  b: string;
  sharedRuns: number;
  samples: string[];
  copy?: boolean;
}

/**
 * A project's markdown link network, mapped from its root AGENTS.md, else root CLAUDE.md, plus a per-doc
 * census of every tracked .md (role, size, git recency, dead/stale refs, code mentions).
 * Orphan findings leave out docs the census puts in a record collection.
 */
export interface MdNetwork {
  ok: true;
  /** The root doc: 'AGENTS.md' when the root has one, else 'CLAUDE.md'. */
  root: string;
  /** Breadth-first from the root. */
  nodes: MdNetworkNode[];
  edges: MdNetworkEdge[];
  findings: MdNetworkFinding[];
  /** Docs read — at most 2000; past that cap, docs no link reaches are dropped first. */
  docs: number;
  /** `edges.length`. */
  links: number;
  /** Top-level folders holding reachable docs, each with a trailing slash, sorted. */
  scopes: string[];
  /** Every tracked .md; docs left unread past the 2000 cap have `lines`/`bytes` null. A failed git call adds a `warnings` entry, never an error. */
  census: MdCensus;
  /** Duplicated text between living docs (never history or record-collection docs), most shared first. A failure is `[]` plus a `census.warnings` entry. Optional only so older fixtures/results without it still type-check; the scan always sets it. */
  duplicates?: MdDuplicatePair[];
}

/** `{ ok: false, error }` when there is nothing to map or the scan failed (not a git repo, no root AGENTS.md or CLAUDE.md, an ephemeral cwd). */
export type MdNetworkResult = MdNetwork | { ok: false; error: string };

// ────────────────────────────────────────────── Project Pages: Review MD network record
// Mirrors the JSDoc typedefs in src/main/lib/mdReviewRecord.cjs (ReviewVerdict,
// ReviewRecord, MdReviewOk | MdReviewErr). Keep in sync by hand.

/** One row of the record's per-doc verdict table. */
export interface MdReviewVerdict {
  doc: string;
  verdict: string;
  owner: string;
}

/** A parsed review record (reviews/docs/<YYYY-MM-DD>-md-network[-N].md); any field the record lacks is null/empty. */
export interface MdReviewRecord {
  date: string | null;
  mode: string | null;
  modeKind: 'Full review' | 'Drift check' | null;
  scope: string | null;
  session: string | null;
  baseCommit: string | null;
  owner: string | null;
  map: string | null;
  driftCheckCommand: string | null;
  findingsCounts: Record<string, number>;
  censusSummary: string | null;
  verdicts: MdReviewVerdict[];
  decisions: string[];
  followUpPrds: string[];
  nextReviewDue: string | null;
  nextReviewNote: string | null;
}

/** The newest review record (null when none) plus, per requested Epic id, its validation record paths (repo-relative). */
export interface MdReviewOk {
  ok: true;
  record: MdReviewRecord | null;
  recordPath: string | null;
  validation: Record<string, string[]>;
}

/** `{ ok: false, error }` for an ephemeral cwd or an unresolvable project root. */
export type MdReviewResult = MdReviewOk | { ok: false; error: string };

// ────────────────────────────────────────────── Project Pages: markdown doc census
// Mirrors the JSDoc typedefs in src/main/lib/mdDocCensus.cjs.
// Every path is repo-relative POSIX; folder strings end with '/'.

/** How agents meet a doc: 'map' = the root map doc (root AGENTS.md, else root CLAUDE.md), a root CLAUDE.md beside AGENTS.md, and their @-imports; 'scoped' = another CLAUDE.md / AGENTS.md / CLAUDE.local.md; 'agent' = .claude/, skills/, plugin agents/commands; 'record' = in a record collection and unreachable; 'doc' = anything else. */
export type MdDocRole = 'map' | 'scoped' | 'agent' | 'record' | 'doc';

export interface MdDoc { path: string; role: MdDocRole; depth: number | null; lines: number | null; bytes: number | null; lastCommitMs: number | null; commits: number; linkedFrom: number; codeRefs: number; codeRefFiles: string[]; deadRefs: string[]; ambiguousRefs: string[]; changedSince: { path: string; ms: number }[]; collection: string | null; }

/** A folder of machine-written, write-once, unlinked docs (e.g. validation records). */
export interface MdRecordCollection { folder: string; docs: number; linked: number; lastCommitMs: number | null; source: 'heuristic' | 'override'; }

export interface MdCensus { docs: MdDoc[]; collections: MdRecordCollection[]; counts: { tracked: number; network: number; records: number; unlinked: number; byRole: Record<MdDocRole, number> }; gitWindow: { commits: number; oldestMs: number | null }; warnings: string[]; }

// ────────────────────────────────────────────── Competitor matrix
// Mirrors CompetitiveMatrixSchema in src/main/lib/project-pages/competitiveMatrix.cjs — keep field-for-field.

export type MatrixSupportStatus = 'yes' | 'partial' | 'no' | 'unknown';
export type MatrixSentimentSignal = 'loved' | 'requested' | 'mixed' | 'complained' | 'none';
export type MatrixPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'none';
export type MatrixSourceKind = 'announcement' | 'blog' | 'docs' | 'changelog' | 'forum' | 'review' | 'social' | 'repo';

/** My product — always id 'self'. */
export interface MatrixProduct {
  id: 'self';
  name: string;
  summary: string;
}

export interface MatrixCompetitor {
  id: string;
  name: string;
  url?: string;
  category: string;
  chosenBy: 'user' | 'auto';
  why: string;
}

export interface MatrixGroup {
  id: string;
  title: string;
  description: string;
}

export interface MatrixSupportCell {
  status: MatrixSupportStatus;
  note: string;
  sourceIds: string[];
}

export interface MatrixSentiment {
  signal: MatrixSentimentSignal;
  summary: string;
  sourceIds: string[];
}

export interface MatrixRecommendation {
  priority: MatrixPriority;
  rationale: string;
  sessionGoal: string;
}

export interface MatrixFeature {
  id: string;
  groupId: string;
  title: string;
  description: string;
  sentiment: MatrixSentiment;
  /** Keyed by 'self' plus every competitor id — exactly those keys. */
  support: Record<string, MatrixSupportCell>;
  recommendation: MatrixRecommendation;
  firstSeenAt: string;
  updatedAt: string;
}

export interface MatrixSource {
  id: string;
  url: string;
  title: string;
  publisher: string;
  publishedAt: string | null;
  retrievedAt: string;
  kind: MatrixSourceKind;
}

export interface MatrixRun {
  at: string;
  model: string;
  competitors: string[];
  added: string[];
  changed: string[];
  notes: string;
}

export interface CompetitiveMatrix {
  schemaVersion: 1;
  product: MatrixProduct;
  competitors: MatrixCompetitor[];
  groups: MatrixGroup[];
  features: MatrixFeature[];
  sources: MatrixSource[];
  runs: MatrixRun[];
  updatedAt: string;
}

/** `matrix` is null when none is saved (error null) or the file is invalid (error set); `ok:false` when the cwd has no project root. */
export type CompetitorMatrixResult =
  | { ok: true; matrix: CompetitiveMatrix | null; error: string | null }
  | { ok: false; error: string };

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

/** One line of a unified-diff hunk. `oldNo`/`newNo` are null on the side the line doesn't exist. */
export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  truncated: boolean;
  tooLarge?: boolean;
}

/** One reviewable slice of an Epic's changes: the session's own worktree work, or one landed PRD. */
export interface EpicChangeSection {
  kind: 'session' | 'prd';
  key: string;
  label: string;
  slug?: string;
  base: string | null;
  head: string | null;
  live: boolean;
  files: DiffFile[];
  error?: string;
}

export type EpicChanges =
  | { ok: true; epicId: string; status: string; sections: EpicChangeSection[]; truncated: boolean }
  | { ok: false; reason: string };

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

/** One entry of ~/.claude/plugins/installed_plugins.json joined with user-scope enabledPlugins. */
export interface InstalledPlugin {
  key: string;
  name: string;
  marketplace: string;
  version: string | null;
  scope: string | null;
  installPath: string | null;
  enabled: boolean;
}

export interface PluginInstallProgressEvent {
  slug: string;
  line: string;
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
  /** Who wrote the prompt: a local human, an injected external source, or an Epic proposal from another project. */
  origin?: 'human' | 'external' | 'inbound-proposal';
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
  tag?: 'feature' | 'bug' | 'discussion' | 'build' | 'project-home-builder' | 'art' | 'portfolio';
}

export type ChatCreatePrdResult =
  | {
      ok: true;
      nn: number;
      filename: string;
      prdPath: string | null;
      epicId: string | null;
      /** Always false — this call only writes the PRD file; the queue row is derived by the next scheduler reconcile pass, never created here. */
      enqueued: false;
      note: string;
    }
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
  /** The tool_use input's command/description/pattern/file_path, whichever applies —
   *  empty string when the tool took none of those. */
  detail?: string;
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
  /** Epic's claudeSessionId + project cwd, resolved by main so the renderer can deliver before the Epic's project is loaded. */
  sessionId?: string;
  cwd?: string;
  /** Set by main's enqueueExternalPrompt on every push; the renderer must echo it back via `reportExternalSendResult`. */
  requestId?: string;
}

export type ChatExternalSendDisposition = 'sent' | 'queued' | 'refused';
export type ChatExternalSendRefusalReason = 'terminal-attached' | 'completed' | 'unknown-target' | 'empty-prompt';
/** What the renderer did with a `ChatExternalSendEvent`, reported back to main. */
export interface ChatExternalSendResult {
  requestId: string;
  disposition: ChatExternalSendDisposition;
  reason?: ChatExternalSendRefusalReason;
}

/** What the renderer did with a `chat:external-new-session` that carried a requestId (POST /admin/macros/run), reported back to main. */
export interface ChatExternalNewSessionResult {
  requestId: string;
  ok: boolean;
  /** The minted Epic's id when `ok`. */
  epicId?: string;
  error?: string;
  /** Project Home entry id of the background build queued for a scripted job press (Demo Video). */
  entryId?: string;
  /** That build's slug. */
  slug?: string;
  /** That build's stage; null when it has none. */
  stage?: 'review' | 'final' | null;
}

export type CreateProjectFolderResult =
  | { ok: true; path: string }
  | { ok: false; code: 'invalid-name' | 'invalid-parent' | 'exists' | 'io'; error: string; path?: string };

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
  /** 'repair-needed' once the relay rejected the device token; the device must be re-paired. */
  linkState?: 'ok' | 'repair-needed';
  e2eActive: boolean;
  /** True once the user has confirmed the SAS on the desktop. */
  e2eAuthenticated: boolean;
  /** Explicit E2E session state for UI rendering. */
  e2eState: 'idle' | 'pending_sas' | 'authenticated' | 'failed';
  /** 6-digit Short Authentication String pending user confirmation, or null. */
  pendingSas: string | null;
  /** Every connected client's E2E state (no key material). */
  clients: WebRemoteClientStatus[];
  devices: WebRemoteDevice[];
}

export interface WebRemoteClientStatus {
  key: string;
  state: 'idle' | 'pending_sas' | 'authenticated' | 'failed';
  pendingSas: string | null;
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

/** Tool names a paired service may be scoped to (servicePairings.cjs SERVICE_TOOL_NAMES). */
export type WebRemoteServiceTool =
  | 'feedback_list_projects'
  | 'feedback_open_session'
  | 'macro_list'
  | 'macro_run'
  | 'epic_get'
  | 'events_read'
  | 'project_create';

/** A paired service as the renderer sees it (its pinned key is never returned). */
export interface WebRemoteService {
  serviceId: string;
  name: string;
  homeCwd: string;
  scope: WebRemoteServiceTool[];
  /** Owner-approved projects folder project_create creates into; null without that tool. */
  projectRoot: string | null;
  relayClientId: string | null;
  pairedAt: number;
  lastSeenAt: number;
  /** How the pairing was approved: owner window (default) or the loopback admin API. */
  pairedVia?: 'window' | 'local';
}

export interface WebRemotePendingService {
  pairingId: string;
  name: string;
  homeCwd: string;
  scope: WebRemoteServiceTool[];
  projectRoot: string | null;
  createdAt: number;
  expiresAt: number;
  pairedVia?: 'window' | 'local';
}

/** A relay client no local service owns. */
export interface WebRemoteRelayOrphan {
  clientId: string;
  clientName: string;
  issuedAt: string | number | null;
}

export interface WebRemoteServicesListResult {
  ok: true;
  services: WebRemoteService[];
  pending: WebRemotePendingService[];
  relayOrphans: WebRemoteRelayOrphan[];
  /** Set when the relay client list could not be read (relayOrphans is then []). */
  relayError?: string;
}

/** Mirrors zod webRemoteServicePairStart. */
export interface WebRemoteServicePairStartInput {
  name: string;
  homeCwd: string;
  scope: WebRemoteServiceTool[];
  /** Required (an existing folder in the home folder) when scope includes project_create. */
  projectRoot?: string;
}

export type WebRemoteServicePairStartResult =
  | { ok: true; code: string; pairingId: string; codeExpiresAt: number; deviceId: string }
  | { ok: false; error: 'relay_unsupported' | 'device_token_invalid' | 'rate_limited' | 'no_paired_device' | (string & {}) };

export type WebRemoteServiceConfirmSasResult =
  | { ok: true; service: WebRemoteService }
  | { ok: false; error: string };

/** webRemote.cjs servicePairCancel: `cancelled` = a pending pairing was dropped; `dropped` = waiting clients torn down. */
export type WebRemoteServicePairCancelResult =
  | { ok: true; cancelled: boolean; dropped: number }
  | { ok: false; error: string };

export type WebRemoteServiceRevokeResult =
  | { ok: true; relayRevoked: boolean }
  | { ok: false; error: string };

export interface WebRemoteAuditTailResult {
  ok: boolean;
  lines?: string[];
  error?: string;
}

export interface SessionManagerAPI {
  app: {
    version: () => Promise<string>;
    /** Published-`latest` probe (cached 6h, opt-out SM_UPDATE_CHECK=0). Never rejects; offline → latest null. */
    homeDir: () => Promise<string>;
    cwd: () => Promise<string>;
    engageRulesPath: () => Promise<string | null>;
    pickDirectory: () => Promise<string | null>;
    /** Create `<parentDir>/<name>` for a new project; main validates the name. */
    createProjectFolder: (parentDir: string, name: string) => Promise<CreateProjectFolderResult>;
    gitBranch: (cwd: string) => Promise<string | null>;
    /** Default: request a drain-first restart. `force: true` restarts immediately, killing running jobs. */
    rebootApp: (opts?: { force?: boolean }) => void;
    testFireHook: (args: TestFireHookArgs) => Promise<TestFireHookResult>;
    /** F7 — true under SM_E2E=1; renderer uses this to suppress wizard auto-trigger. */
    isE2E: () => Promise<boolean>;
    /** `--simple` CLI flag → stripped single-terminal layout in `cwd`. */
    launchMode: () => Promise<{ simple: boolean; cwd: string }>;
    /** Boot diagnostic — resolved claude binary path + whether it was found
     *  on disk (false means spawn will rely on PATH and may ENOENT). */
    claudeBinStatus: () => Promise<{ resolved: string; foundOnDisk: boolean }>;
    /** Fresh prerequisite probe (git, claude CLI, auth, Git Bash on Windows). */
    prereqs: () => Promise<PrereqItem[]>;
    /** Opens the OS terminal running the item's official install command (looked up main-side by id). */
    prereqsRunFix: (id: string) => Promise<{ ok: true; opener: string } | { ok: false; error: string }>;
    /** Boot diagnostic — assertCwdInsideHome(os.homedir()) result. ok=false
     *  on macOS symlinked-/Users mismatch and blocks all session spawns. */
    homeSelfCheck: () => Promise<{ ok: boolean; error?: string; realCwd?: string }>;
    /** First-boot seeder outcomes, read live from each seeder's own marker
     *  file: 'done' (succeeded), 'pending' (not yet run), 'failed' (an attempt failed; retries next launch),
     *  'exhausted' (gave up after MAX_ATTEMPTS — manual fix needed). */
    seedStatus: () => Promise<SeedStatus>;
    /** "Can this project actually delegate?" — the 4 preconditions for
     *  scheduler_create_prd being in an agent's tool list at all. */
    delegationReadiness: (cwd: string) => Promise<DelegationReadiness>;
    installPrdWriteGuard: (cwd: string) => Promise<InstallGuardResult>;
    installDestructiveGitGuard: (cwd: string) => Promise<InstallGuardResult>;
    installInlineImplementationGuard: (cwd: string) => Promise<InstallGuardResult>;
    installSelfScheduleGuard: (cwd: string) => Promise<InstallGuardResult>;
    onNewSession: (handler: () => void) => () => void;
    onRebootSession: (handler: () => void) => () => void;
    onOpenFreeHour: (handler: () => void) => () => void;
    /** Fired when POST /admin/projects/create makes a new project; `cwd` is its folder. */
    onProjectCreated: (handler: (payload: { cwd: string }) => void) => () => void;
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
  transcripts: {
    subscribe: (payload: { tabId: string; cwd: string; sessionUuid: string }) => Promise<SubscribeResult>;
    /** Release the sub back to the LRU cache (view-switch). Does not destroy the watcher. */
    unsubscribe: (tabId: string) => Promise<{ ok: boolean }>;
    /** Permanently destroy the sub (genuine tab close). */
    closeTab: (tabId: string) => Promise<{ ok: boolean }>;
    buffer: (tabId: string) => Promise<TranscriptEvent[]>;
    /** Paged read over the subscribed transcript's line-offset index — [startLine, endLine] inclusive, 0-based.
     *  Reads only the requested byte range from disk; never materializes the whole file. */
    page: (tabId: string, startLine: number, endLine: number) => Promise<{ events: (TranscriptEvent & { lineNumber: number })[]; totalLines: number }>;
    /** Full untruncated single-line read via a classifier byte reference (expand-to-full path). */
    readRef: (ref: TranscriptEventRef) => Promise<{ ok: boolean; text?: string; error?: string }>;
    pathFor: (cwd: string, sessionUuid: string) => Promise<string>;
    /** Does the claude JSONL transcript for this session exist? Remote-readable. */
    exists: (cwd: string, sessionUuid: string) => Promise<boolean>;
    /** Batched token-usage totals, one map entry per requested sessionId. A
     *  session with no transcript file yet (or one over the main-process size
     *  cap) maps to null. `lastContext` = input + cache-read + cache-creation
     *  tokens of the newest model call (null when there is none); `calls` =
     *  number of model calls, each message.id counted once. */
    usageFor: (cwd: string, sessionIds: string[]) => Promise<Record<string, { inputTokens: number; outputTokens: number; lastContext: number | null; calls: number } | null>>;
    /** Fires once per main-process flush with the ORDERED batch of events that
     *  flush produced (never one call per event) — see transcripts.cjs's
     *  doFlush / MAX_EVENTS_PER_BATCH. */
    onEvent: (tabId: string, handler: (events: TranscriptEvent[]) => void) => () => void;
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
    /** Desktop-only: the web remote is denied it (apiSurface remote: deny) — it spawns the server. */
    checkServer: (req: McpCheckRequest) => Promise<McpCheckResult>;
  };
  /** Non-Claude agent CLIs (main-side registry + adapters). Desktop-only: not exposed to the web remote. */
  agentCli: {
    /** One row per non-Claude CLI; cached 60 s in main unless `refresh`. Never rejects. */
    detect: (payload?: { refresh?: boolean }) => Promise<AgentCliDetectRow[]>;
    /** The exact shell line (no trailing CR) the Epic Terminal pane types to launch/resume this Epic's CLI. */
    terminalCommand: (payload: { cwd: string; claudeSessionId: string }) => Promise<AgentCliTerminalCommandResult>;
  };
  /** Shipped context-pack catalog (New Session picker). Never rejects. */
  packs: {
    list: () => Promise<PacksListResult>;
    /** Pack CLI args for this Epic's Terminal `claude` line; `[]` for agent-CLI/no-pack Epics or any error. */
    terminalArgs: (payload: { cwd: string; claudeSessionId: string }) => Promise<PacksTerminalArgsResult>;
  };
  agents: {
    listPersonas: () => Promise<AgentPersona[]>;
    savePersona: (payload: AgentPersonaSaveInput) => Promise<{ ok: boolean; path: string }>;
    deletePersona: (payload: { name: string }) => Promise<{ ok: boolean }>;
    /** Replaces the installed persona with the bundled one (backing the old file up). */
    takeBundledPersona: (p: { name: string }) => Promise<{ backupPath: string; seedVersion: number }>;
    /** Hides the upgrade notice for this bundled version. */
    dismissPersonaUpgrade: (p: { name: string; bundledVersion: number }) => Promise<{ ok: true }>;
    /** Drops the overlay of the OPEN project at `projectCwd` (an `overrideDetails[].cwd`). */
    removeOverride: (payload: { name: string; projectCwd: string }) => Promise<{ ok: boolean }>;
    /** Raw persona `.md` text for the New Epic AIM composer (epicIntake.ts's `agentBody`),
     *  resolved with project-overlay-then-global precedence for `cwd` — unlike
     *  `listPersonas` above, which only reads the global directory. Null when neither
     *  location has the file. */
    getPersonaBody: (payload: { cwd: string; name: string }) => Promise<{ path: string; text: string; provenance?: Record<string, 'overlay' | 'global'>; bodySource?: 'overlay' | 'global' } | null>;
    /** "What will this Epic actually run as?" — persona alias, overlay-aware
     *  provenance, and evidence-based concrete model id (scheduler run log or
     *  session transcript). Never throws on the main side; a dangling
     *  agentType or missing evidence degrades individual fields to null. Pair
     *  with the renderer's `useEffectiveSettings.ts` scope-chain reader for
     *  the effortLevel/effortSource half — this call only covers the parts
     *  that need main-process filesystem access. */
    resolveModelInfo: (payload: { cwd: string; agentType?: string }) => Promise<{
      agentType: string;
      modelAlias: string | null;
      modelSource: 'persona' | 'persona-overlay' | 'inherit' | 'fallback';
      /** Per-frontmatter-key origin of the merged persona (overlay vs global). */
      personaProvenance?: Record<string, 'overlay' | 'global'>;
      resolvedModelId: string | null;
      resolvedFrom: 'scheduler-run' | 'transcript' | null;
      /** Env-var path only: would cleanChildEnv strip CLAUDE_EFFORT. Persona effort travels on argv regardless. */
      effortEnvReachable: boolean;
      /** Persona `effort:` level (null = pass no --effort) and where it came from. */
      personaEffort: string | null;
      personaEffortSource: 'persona' | 'persona-overlay' | 'inherit' | null;
    }>;
    /** The launch-time authority for an Epic-backed session's `--model`: the SAME
     *  resolver (`agentModelResolve.cjs`'s `resolveEpicModel`) chatRunner.cjs's Chat
     *  path calls in-process, reached here so Terminal (`EpicTerminalPane.tsx`, no
     *  fs access) agrees with Chat by calling the identical function. Overlay-aware
     *  (project `.claude/agents/<name>.md` wins over global), never throws — a
     *  dangling agentType or absent/`inherit` model falls back to `'sonnet'`. */
    resolveEpicModel: (payload: { cwd: string; claudeSessionId: string }) => Promise<string>;
    /** Effort twin of `resolveEpicModel` (`agentEffortResolve.cjs`): the persona `effort:` level
     *  Terminal must launch with, or `effort: null` = append NO `--effort` flag (inherit / absent /
     *  dangling persona). Chat resolves the same value in-process. Never throws. */
    resolveEpicEffort: (payload: { cwd: string; claudeSessionId: string }) => Promise<{
      effort: string | null;
      source: 'persona' | 'persona-overlay' | 'inherit' | null;
    }>;
    /** Gear armory read model (`agentArmory.cjs`): every equippable tool/skill/MCP/pack with badges. Never throws; source failures land in `errors`. */
    armory: (payload: { cwd?: string }) => Promise<Armory>;
    /** Fires after any save/delete/removeOverride — subscribers should re-fetch listPersonas(). */
    onChanged: (handler: () => void) => () => void;
  };
  macros: {
    list: () => Promise<Macro[]>;
    save: (payload: MacroSaveInput) => Promise<Macro>;
    delete: (payload: { id: string }) => Promise<{ ok: boolean }>;
    /** Add/remove one project cwd. A macro shown in every project (`'*'`) cannot be narrowed: `{ ok: false, error: 'macro is shown in every project' }`. */
    setProject: (payload: { id: string; cwd: string; enabled: boolean }) => Promise<{ ok: true; macro: Macro } | { ok: false; error: string }>;
    /** This project only gives up the macro (same library call as the macro_delete MCP route); deleted when it was the last project. */
    removeFromProject: (payload: { id: string; cwd: string }) => Promise<{ ok: true; deleted: boolean; macro: Macro } | { ok: false; error: string }>;
    /** Dispatch a built-in macro's background build as a scheduler job. */
    dispatchJob: (payload: MacroJobDispatchInput) => Promise<MacroJobDispatchResult>;
    /** Status of this project's macro background builds. */
    jobStatus: (payload: { cwd: string }) => Promise<MacroJobStatus[]>;
    /** Fires after any save/delete/setProject — re-fetch list(). */
    onChanged: (handler: () => void) => () => void;
  };
  needsYou: {
    /** Open items only, across every app. */
    list: () => Promise<{ ok: true; items: NeedsYouItem[] }>;
    /** Answer one open item with one of its options; `ok: false` + error in words when no such open item/option. */
    answer: (payload: { app: string; id: string; answer: string }) => Promise<{ ok: true; item: NeedsYouItem } | { ok: false; error: string }>;
    /** IPC 'scheduler:confirm-tool': answer a tool-risk 'confirm' item (app 'tool-risk') by tool + sha256 args digest. Approve resumes the asking job's same session with a single-use clearance; Deny parks it (confirmation_denied). Applied on the scheduler's next tick. */
    confirmTool: (payload: { tool: string; argsDigest: string; approved: boolean }) => Promise<{ ok: true; item: NeedsYouItem } | { ok: false; error: string }>;
    /** Fires after any post/withdraw/answer — re-fetch list(). */
    onChanged: (handler: () => void) => () => void;
  };
  appPreview: {
    /** The Epic's package.json scripts (dir = worktree when it has one) plus a suggested dev script. */
    scripts: (payload: { cwd: string; epicId: string }) => Promise<AppPreviewScriptsResult>;
    /** Spawns the Epic's dev script on a free port after the user confirmed it; desktop only. */
    start: (payload: { cwd: string; epicId: string; script: string }) => Promise<AppPreviewStartResult>;
    /** Stops the Epic's preview process, if any. */
    stop: (payload: { epicId: string }) => Promise<{ ok: true }>;
    /** Every tracked preview, one per Epic. */
    list: () => Promise<AppPreviewState[]>;
    /** Fires on every preview state change with the new state. */
    onChanged(handler: (state: AppPreviewState) => void): () => void;
  };
  models: {
    /** Live model/effort catalog (`modelCatalog.cjs`'s `resolveModelCatalog`). Never rejects from
     *  the resolver itself — a failed probe degrades down cache → floor and sets `degraded`.
     *  `cwd` only affects `availableModels` (settings-scope allowlist); `force` bypasses the cache. */
    catalog: (payload: { cwd?: string; force?: boolean }) => Promise<{
      aliases: string[];
      models: string[];
      effortLevels: string[];
      settingsEffortLevels: string[];
      availableModels: string[] | null;
      claudeVersion: string | null;
      probedAt: string | null;
      sources: {
        aliases: 'probe' | 'cache' | 'floor';
        models: 'binary' | 'cache' | 'floor';
        effortLevels: 'probe' | 'cache' | 'floor';
      };
      degraded: boolean;
    }>;
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
  claudeConfig: {
    read: (payload: ClaudeConfigReadInput) => Promise<{ path: string; data: Record<string, unknown> }>;
    /** Sets one key path; omit `value` to delete it. Broadcasts `config:changed`. */
    patch: (payload: ClaudeConfigPatchInput) => Promise<{ ok: true; path: string; data: Record<string, unknown> }>;
  };
  /** Tool-risk marks (System/Project) — validated by main's toolRiskMarks.cjs. */
  toolRisk: {
    read: (payload: ToolRiskReadInput) => Promise<ToolRiskReadResult>;
    write: (payload: ToolRiskWriteInput) => Promise<ToolRiskWriteResult>;
  };
  config: {
    readJson: (path: string) => Promise<ReadJsonResult>;
    readText: (path: string, opts?: ReadTextOptions) => Promise<ReadTextResult>;
    /** `writer` declares the owning surface for the single-writer law — required
     *  when `path` is inside a project's session-manager-operations/ root. */
    writeJson: (path: string, data: unknown, writer?: OpsWriter) => Promise<WriteResult>;
    /** `opts.importedBy` names the root instruction file that @-imports `path`; main
     *  accepts an imported file only while that root still imports it. */
    writeText: (path: string, text: string, writer?: OpsWriter, opts?: { importedBy?: string }) => Promise<WriteResult>;
    listDir: (path: string, opts?: { filesOnly?: boolean; dirsOnly?: boolean; includeHidden?: boolean }) => Promise<ListDirResult>;
    /** Whether config:write-text would accept this path (same decision, plus a W_OK
     *  probe); `opts.importedBy` is passed through exactly as for writeText. A refusal
     *  carries the reason the UI explains. */
    canWrite: (path: string, opts?: { importedBy?: string }) => Promise<ConfigWriteAccess>;
    exists: (path: string) => Promise<boolean>;
    watch: (paths: string[], opts?: { depth?: 0 | 1 | 2 }) => void;
    unwatch: (paths: string[], opts?: { depth?: 0 | 1 | 2 }) => void;
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
    /** Read persisted TTS toggle (voice.json `ttsEnabled`). */
    getTtsEnabled: () => Promise<boolean>;
    /** Persist TTS toggle. */
    setTtsEnabled: (enabled: boolean) => Promise<{ ok: boolean; ttsEnabled: boolean }>;
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
  customerFeedback: {
    /** `images` are raw data URLs; main prepares (validates/downscales) them before sending. */
    submit: (p: {
      title: string;
      body: string;
      tag: CustomerFeedbackTag;
      images?: { dataUrl: string }[];
    }) => Promise<
      { ok: true; item: CustomerFeedbackItem; warning?: string } | { ok: false; error: string }
    >;
    list: () => Promise<CustomerFeedbackItem[]>;
    refreshStatus: () => Promise<
      { ok: true; updated: number; unsupported?: true } | { ok: false; error: string }
    >;
    /** Omit `ids` to mark everything seen. Resolves to the updated items. */
    markSeen: (p: { ids?: string[] }) => Promise<CustomerFeedbackItem[]>;
    ownerInfo: () => Promise<CustomerFeedbackOwnerInfo>;
    inboxPull: () => Promise<
      { ok: true; fetched: number; pages: number } | { ok: false; error: string }
    >;
    inboxList: (p: { includeHidden?: boolean }) => Promise<
      { ok: true; items: CustomerFeedbackInboxItem[] } | { ok: false; error: string }
    >;
    inboxSetStatus: (p: { id: string; status: CustomerFeedbackStatus; note?: string }) => Promise<
      { ok: true; item: CustomerFeedbackInboxItem | null } | { ok: false; error: string }
    >;
    inboxLinkEpic: (p: { id: string; epicId: string }) => Promise<
      { ok: true } | { ok: false; error: string }
    >;
    /** A cached inbox screenshot as a data URL; `index` is 0-based. */
    inboxImage(p: { id: string; index: number }): Promise<
      { ok: true; dataUrl: string } | { ok: false; error: string }
    >;
  };
  /** File Explorer reads of a project's Artifacts store and unmerged Epic worktrees (lib/epic/artifactIpc.cjs). Read-only. */
  artifacts: {
    /** Ledger entries of every owner, newest first, each joined with its Epic's title (null for Tasks / unknown). */
    list: (p: { cwd: string }) => Promise<ArtifactsListResult>;
    /** Active Epics of `cwd` with an on-disk, git-registered worktree. */
    worktrees: (p: { cwd: string }) => Promise<ArtifactsWorktreesResult>;
  };
  /** Website-feedback widgets + inbox (siteFeedbackIpc.cjs), one method per channel. */
  siteFeedback: {
    widgetCreate: (p: SiteFeedbackWidgetCreateInput) => Promise<
      SiteFeedbackResult<{ boxId: string; fingerprint: string; snippet: string }>
    >;
    /** Relay unreadable → ok with `relayError` and widgets in state 'unknown'. */
    widgetList: (p?: SiteFeedbackWidgetListInput) => Promise<
      SiteFeedbackResult<{ widgets: SiteFeedbackWidget[]; relayError?: SiteFeedbackFailure }>
    >;
    widgetUpdate: (p: SiteFeedbackWidgetUpdateInput) => Promise<
      SiteFeedbackResult<{ widget: SiteFeedbackWidgetPatched }>
    >;
    widgetDelete: (p: SiteFeedbackWidgetBoxInput) => Promise<SiteFeedbackResult<{ boxId: string }>>;
    widgetSnippet: (p: SiteFeedbackWidgetBoxInput) => Promise<SiteFeedbackResult<SiteFeedbackSnippet>>;
    inboxList: (p: SiteFeedbackInboxListInput) => Promise<
      SiteFeedbackResult<{ items: SiteFeedbackInboxItem[] }>
    >;
    inboxGet: (p: SiteFeedbackInboxGetInput) => Promise<SiteFeedbackResult<{ item: SiteFeedbackItemDetail }>>;
    /** A PNG data URL — never log it. */
    inboxImage: (p: SiteFeedbackInboxImageInput) => Promise<
      SiteFeedbackResult<{ hostId: string; which: SiteFeedbackImageKind; dataUrl: string }>
    >;
    inboxSetStatus: (p: SiteFeedbackInboxSetStatusInput) => Promise<
      SiteFeedbackResult<{ meta: SiteFeedbackItemMeta }>
    >;
    inboxLinkEpic: (p: SiteFeedbackInboxLinkEpicInput) => Promise<
      SiteFeedbackResult<{ meta: SiteFeedbackItemMeta }>
    >;
    /** Deletes one stored item (report, images, meta); not_found when it was already gone. */
    inboxRemove: (p: SiteFeedbackInboxGetInput) => Promise<SiteFeedbackResult<{ hostId: string }>>;
    drainNow: () => Promise<SiteFeedbackResult<SiteFeedbackDrainResult>>;
  };
  telemetry: {
    getConfig: () => Promise<TelemetryConfig>;
    setConfig: (cfg: TelemetryConfig) => Promise<TelemetrySetConfigResult>;
    status: () => Promise<TelemetryStatus>;
    configPath: () => Promise<string>;
    recentRecords: () => Promise<TelemetryRecentRecord[]>;
    flushNow: () => Promise<TelemetryFlushResult>;
  };
  diagnostics: {
    /** Rejects unless the main process has SM_HEAP_SNAPSHOT=1 set. */
    takeHeapSnapshot: () => Promise<{ filePath: string; bytes: number | null; ms: number }>;
  };
  files: {
    list: (path: string, showHidden?: boolean) => Promise<FilesListResult>;
    read: (path: string) => Promise<FilesReadResult>;
    write: (path: string, content: string) => Promise<FilesWriteResult>;
    create: (parentPath: string, name: string, kind: 'file' | 'folder') => Promise<FilesCreateResult>;
    rename: (path: string, newName: string) => Promise<FilesRenameResult>;
    delete: (path: string) => Promise<FilesDeleteResult>;
    duplicate: (path: string) => Promise<FilesDuplicateResult>;
    saveBinary: (path: string, base64: string, writer?: OpsWriter) => Promise<{ ok: boolean; error?: string }>;
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
    /** This usage week's validated-PRDs-per-usage efficiency, per project (loopEfficiency.cjs). */
    loopEfficiency: () => Promise<LoopEfficiencyResult>;
    /** Validator quality per project: first-pass + refuted rates, fix waves, escapes, weekly top miss (validationQuality.cjs). */
    validationQuality: () => Promise<{ ok: true; projects: ValidationQualityProject[] } | { ok: false; error: string }>;
    /** Fires (throttled to 1/5 s) when main appends days to the rollup. Returns unsubscribe. */
    onUpdated: (handler: () => void) => () => void;
  };
  /** Scheduler Tasks section (taskIpc.cjs). setSwitch is desktop-only (remote 'deny'). */
  tasks: {
    list: (q: TaskListQuery) => Promise<TaskListResult>;
    get: (q: TaskGetQuery) => Promise<TaskGetResult>;
    getSwitch: (q: TaskSwitchQuery) => Promise<TaskGetSwitchResult>;
    setSwitch: (q: TaskSwitchSet) => Promise<TaskSetSwitchResult>;
  };
  schedule: {
    state: () => Promise<ScheduleStateSnapshot>;
    /** Machine-wide claude -p slot pool (sessionSlots.cjs): total/inUse/holders + [min,max]/default/envOverride. */
    sessionSlots: () => Promise<{
      total: number; inUse: number; holders: { owner: string; at: string }[];
      min: number; max: number; default: number; envOverride: boolean;
    }>;
    /** Resolved base dir of managed Epic/job worktrees (SM_WORKTREE_ROOT, else the persistent per-user state dir). */
    worktreeBase: () => Promise<string>;
    /** Set the slot pool's user cap (Home tab), [0, 10]; 0 pauses new launches. Ignored if SM_SESSION_SLOTS is set. */
    setSessionSlots: (cap: number) => Promise<{
      total: number; inUse: number; holders: { owner: string; at: string }[];
      min: number; max: number; default: number; envOverride: boolean;
    }>;
    setConfig: (partial: Partial<ScheduleConfig & { supervisor?: Partial<SupervisorConfig> }>) => Promise<{ ok: boolean; config: ScheduleConfig }>;
    /** `cwd`, when given, narrows the match to that project's job row — two
     *  different projects can independently produce the identical slug. */
    resetJob: (slug: string, cwd?: string) => Promise<{ ok: boolean; error?: string }>;
    runNow: () => Promise<{ ok: boolean }>;
    forceTick: () => Promise<ActionOutcome>;
    pause: () => Promise<{ ok: boolean }>;
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
    /** Omit `cwd` for the machine-wide list; pass a project cwd to scope it. */
    listPrds: (cwd?: string) => Promise<PrdListItem[]>;
    health: () => Promise<ScheduleHealthSnapshot>;
    /** Queue-health header verdict — reuses classifyQueueHealth so this can
     *  never disagree with the starvation watchdog. `cwd` null/omitted =
     *  machine-wide scope. */
    queueHealth: (cwd?: string | null) => Promise<ScheduleQueueHealthResult>;
    onState: (handler: (snapshot: ScheduleStateSnapshot) => void) => () => void;
    /** Heartbeat-driven stall alert: queue holds jobs but 0 running / 0 pending / not paused for a full poll interval. Fires at most once per stall episode. */
    onStall: (handler: (event: ScheduleStallEvent) => void) => () => void;
    /** Bundle D — scan all PRDs for unbounded loops + missing frontmatter. */
    lintQueue: () => Promise<LintQueueResult>;
    /** Bundle D — move PRDs to prds-archived/<ISO>/. Never deletes. */
    archivePrds: (slugs: string[]) => Promise<ArchivePrdResult>;
    /** Bundle D — bulk retag parallelGroup and/or estimateMinutes. */
    retagPrds: (items: RetagPrdItem[]) => Promise<RetagPrdResult>;
    /** Stamps a 'quarantined' PRD (no createdVia provenance) as legacy-adopted via the update-prd API, then reconciles it to 'pending'. */
    adoptPrd: (slug: string) => Promise<ActionOutcome>;
    /** Change a PRD's wave disposition (promote to a new head, or attach behind another chain's terminal PRD(s)) — refuses a running/completed row or a dependsOn cycle. */
    setPrdDisposition: (args: {
      slug: string;
      cwd?: string;
      disposition: 'append' | 'new-head';
      dependsOn?: string[];
    }) => Promise<ActionOutcome>;
    /** Return the last N completed/failed jobs from queue.json (newest first). */
    getHistory: (limit?: number) => Promise<ScheduleHistoryResult>;
  };
  supervisor: {
    /** Debug-only: run a supervisor tick immediately. Used by e2e tests. */
    tickNow: () => Promise<{ ok: boolean }>;
    /** Return last 50 supervisor log entries, descending by ts. */
    getLog: () => Promise<SupervisorLogEntry[]>;
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
    /** Installed plugins (installed_plugins.json) with user-scope enabled flag; key = name@marketplace. */
    list: () => Promise<InstalledPlugin[]>;
    /** Writes ~/.claude/settings.json enabledPlugins[key] via claudeConfig.patch. */
    setEnabled: (payload: { key: string; enabled: boolean }) => Promise<{ ok: boolean; error?: string }>;
    /** Runs `claude plugin uninstall <slug>@<marketplaceName>` in the hidden pty. */
    uninstall: (payload: { slug: string; marketplaceName: string }) => Promise<PluginInstallResult>;
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
    /** Write side — copies arbitrary text (e.g. a recorded flow export) to the OS clipboard. */
    writeText: (text: string) => Promise<{ ok: boolean; error?: string }>;
  };
  memory: {
    /** List markdown memory entries for the given workspace (defaults to 'default'). */
    list: (target?: MemoryTarget) => Promise<MemoryListResult>;
    /** Read the contents of one memory entry. */
    read: (name: string, target?: MemoryTarget) => Promise<MemoryReadResult>;
    /** Atomic write of a memory entry (max 1 MiB). */
    write: (name: string, content: string, target?: MemoryTarget) => Promise<MemoryMutationResult>;
    /** Delete a memory entry. */
    delete: (name: string, target?: MemoryTarget) => Promise<MemoryMutationResult>;
    /** Create a new memory entry with starter frontmatter + body. */
    create: (name: string, description?: string, target?: MemoryTarget) => Promise<MemoryMutationResult>;
    /** Aggregate workspace memories into semantic clusters. `refresh:true` fires a cost-gated `claude -p` pass; otherwise returns the cache only. */
    aggregate: (workspace: string, refresh?: boolean, cwd?: string) => Promise<MemoryAggregateResult>;
    /** Deterministic, zero-LLM-cost staleness report. `cwd` (optional) scopes the dead-repo-ref check. */
    stale: (target?: MemoryTarget) => Promise<MemoryStaleResult>;
    /** Agents (user + project) with their `memory:` frontmatter scope. */
    agents: (cwd?: string) => Promise<{ agents: MemoryAgent[] }>;
    /** Stamp a memory as verified (refreshes its freshness). */
    verify: (name: string, target?: MemoryTarget) => Promise<{ ok: boolean; error: string | null }>;
    /** Move a memory into the archive. */
    archive: (name: string, target?: MemoryTarget) => Promise<{ ok: boolean; error: string | null }>;
    /** Restore an archived memory. */
    restore: (name: string, target?: MemoryTarget) => Promise<{ ok: boolean; error: string | null }>;
    /** Names of archived memories. */
    listArchived: (target?: MemoryTarget) => Promise<{ names: string[]; error: string | null }>;
    /** Gated `claude -p` question over the memory folder. */
    ask: (input: { question: string; target?: MemoryTarget; contextName?: string }) =>
      Promise<{ ok: boolean; answer: string; citations: string[]; error?: string }>;
    /** Gated `claude -p` triage of a memory against the md network: update, delete, fold into a CLAUDE.md, or keep; requires `target.cwd`. */
    proposeFix: (input: { name: string; target?: MemoryTarget }) =>
      Promise<MemoryFixProposal>;
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
    /** Read the project-pages library (knowledge/<id>/ pages and videos/<id>/ videos, each with its meta) as a `ProjectPagesGetResult`; empty lists if nothing exists yet. Never fires an LLM call. */
    get: (cwd: string) => Promise<ProjectPagesGetResult>;
    /** Map the project's markdown link network from its root CLAUDE.md (read-only, bounded, no LLM) for the Tools pane. Scans on every call — no watcher, no cache. `ok:false` (with `error`) for a cwd `get` answers with empty lists (tmpdir / linked worktree), a folder that is not a git repo, or no root CLAUDE.md; rejects on an invalid cwd, like `get`. */
    mdNetwork: (payload: { cwd: string }) => Promise<MdNetworkResult>;
    /** Read the newest Review MD network record (reviews/docs/) and each given Epic id's validation record paths (session-manager-operations/plan-records/<id>/*.md, then legacy reviews/validation/<id>/*.md history). Read-only, no watcher, no cache, no LLM. `ok:false` for an ephemeral cwd; rejects on an invalid cwd or a bad Epic id. */
    mdReview: (payload: { cwd: string; epicIds?: string[] }) => Promise<MdReviewResult>;
    /** Read the saved Competitor matrix (project-pages/matrix/matrix.json) — read-only; writes go through project_matrix_write. */
    matrix: (payload: { cwd: string }) => Promise<CompetitorMatrixResult>;
    /** Start pushing `onChanged` events for this cwd's output dir. Refcounted per cwd; `ok:false` (reason 'ephemeral'|'invalid-cwd') means no live updates are possible, not an error. */
    watch: (cwd: string) => Promise<{ ok: boolean; reason?: 'ephemeral' | 'invalid-cwd' }>;
    /** Stop pushing `onChanged` events for this cwd — must be paired 1:1 with a prior `watch` call. */
    unwatch: (cwd: string) => Promise<{ ok: boolean }>;
    /** Rewrite one library entry's meta.json title. Rejects on a bad id, missing entry or invalid meta. */
    rename: (cwd: string, kind: 'knowledge' | 'video', id: string, title: string) => Promise<{ ok: true; title: string }>;
    /** Remove exactly one library entry folder. Rejects on a bad id or missing entry. */
    delete: (cwd: string, kind: 'knowledge' | 'video', id: string) => Promise<{ ok: true }>;
    /** List every Video tool entry with a review folder, newest record first. Read-only; rejects on an invalid cwd. */
    reviewList: (payload: VideoReviewListPayload) => Promise<VideoReview[]>;
    /** The human review decision for a 'waiting' entry: 'approve' queues the final run in the building Epic, 'changes' re-runs the review stage with the note. Desktop only (never via the phone relay); one in-flight decide per entry. */
    reviewDecide: (payload: VideoReviewDecidePayload) => Promise<VideoReviewDecideResult>;
    /** Re-dispatch the final stage of an approved entry whose final run failed (canRetry), reusing the recorded approval and inputs. Desktop only (never via the phone relay); one in-flight decide/retry per entry. */
    reviewRetry: (payload: VideoReviewRetryPayload) => Promise<VideoReviewRetryResult>;
    /** Read this project's 'Scripts may run Demo Video' switch; off with null changedAt/by when never set. Rejects on an invalid cwd. */
    scriptSwitchGet: (payload: VideoScriptSwitchGetPayload) => Promise<VideoScriptSwitchState>;
    /** A human click: turn the switch on/off, recorded as by { via: 'ui' } plus one audit event. Desktop only. Rejects on a bad payload. */
    scriptSwitchSet: (payload: VideoScriptSwitchSetPayload) => Promise<VideoScriptSwitchState>;
    /** Fires whenever a watched cwd's knowledge/videos library is added/changed/removed, carrying the freshly read library result. */
    onChanged: (handler: (payload: { cwd: string } & ProjectPagesGetResult) => void) => () => void;
  };
  voices: {
    /** Every library voice the project can use (project, machine, built-in) with approval state, last-preview stats and the live voice lane. Read-only. */
    list: (payload: VoicesListPayload) => Promise<VoicesListResult>;
    /** Speak `text` in one voice (cached clip, else waits in the voice lane). Desktop only. */
    preview: (payload: VoicesPreviewPayload) => Promise<VoicesPreviewResult>;
    /** Approve a project or machine voice at its current pin; refuses built-ins. Desktop only — the only approval writer. */
    approve: (payload: VoicesVoicePayload) => Promise<VoicesApproveResult>;
    /** Remove a voice's approval. Desktop only. */
    unapprove: (payload: VoicesVoicePayload) => Promise<VoicesUnapproveResult>;
    /** Delete the effective project or machine voice file; refuses an approved voice and a built-in. Desktop only. */
    delete: (payload: VoicesVoicePayload) => Promise<VoicesDeleteResult>;
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
  epicDelegationStats: {
    /** Derived-at-read-time "did this Epic delegate?" counters: prdsQueued (live PRD files under
     *  this Epic's own scheduler/epics/<id>/prds/ dir) and inlineEdits (Write/Edit/NotebookEdit
     *  tool calls against src/scripts/plugins/bin in the Epic's own claude session transcript).
     *  Read-only, no new writer — reads zero on any missing/unreadable state, never throws. */
    get: (cwd: string, epicId: string, claudeSessionId?: string | null) => Promise<{ prdsQueued: number; inlineEdits: number }>;
  };
  epicChanges: {
    /** Read-only diff of an Epic's changes, sectioned by session pin and per-PRD landed commit.
     *  Never throws for a missing Epic/worktree — resolves `{ ok: false, reason }`. */
    get: (args: { cwd: string; epicId: string }) => Promise<EpicChanges>;
  };
  auditLog: {
    /** Append one Epic-lifecycle audit event to ~/.claude/session-manager/audit-log.jsonl.
     *  Kind allowlist is enforced main-side (ipcSchemas.cjs) — this channel is
     *  append-only, no read/list IPC exists. */
    append: (
      kind: 'epic_create' | 'epic_approve' | 'epic_complete' | 'epic_delete' | 'epic_resume' | 'epic_duplicate' | 'epic_draft_update',
      fields: { cwd: string; epicId: string; source: string },
    ) => Promise<{ ok: boolean }>;
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
  loginItem: {
    status: () => Promise<LoginItemStatus>;
    setEnabled: (
      enabled: boolean,
    ) => Promise<{ ok: true; status: LoginItemStatus } | { ok: false; error: string }>;
  };
  updater: {
    status: () => Promise<AutoUpdaterStatus>;
    check: () => Promise<AutoUpdaterStatus>;
    install: (force?: boolean) => Promise<{ ok: boolean; error?: string }>;
    cancelDeferred: () => Promise<AutoUpdaterStatus>;
    setEnabled: (enabled: boolean) => Promise<AutoUpdaterStatus>;
    onStatus: (handler: (status: AutoUpdaterStatus) => void) => () => void;
  };
  opsRetention: {
    get: () => Promise<OpsRetentionSettings>;
    set: (patch: OpsRetentionPatch) => Promise<OpsRetentionSettings>;
    preview: () => Promise<OpsRetentionPreview>;
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
     *  E2E session as authenticated and unblocks MUTATE-tier commands. Pass the
     *  client's `key` when several clients are pending (else `ambiguous_pending_sas`). */
    confirmSas: (clientKey?: string) => Promise<WebRemoteMutationResult>;
    /** Paired + pending services (no keys or tokens) plus relay orphans. */
    servicesList: () => Promise<WebRemoteServicesListResult>;
    /** One-time relay client code (8 chars, 5 minutes) + a pending pairing. */
    servicePairStart: (input: WebRemoteServicePairStartInput) => Promise<WebRemoteServicePairStartResult>;
    /** Confirm a pending service's 6-digit SAS. */
    serviceConfirmSas: (pairingId: string, sas: string) => Promise<WebRemoteServiceConfirmSasResult>;
    /** Cancel a pending pairing and drop its waiting service client. */
    servicePairCancel: (pairingId: string) => Promise<WebRemoteServicePairCancelResult>;
    /** Revoke a paired service locally and at the relay (relay failure still revokes locally). */
    serviceRevoke: (serviceId: string) => Promise<WebRemoteServiceRevokeResult>;
    /** Revoke an orphaned relay client. */
    relayClientRevoke: (clientId: string) => Promise<WebRemoteMutationResult>;
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
    /** Reports what the renderer did with an external send (echoing its requestId) back to main. */
    reportExternalSendResult: (result: ChatExternalSendResult) => Promise<void>;
    /** Reports the minted epicId (or an error) for an external new-session that carried a requestId back to main. */
    reportExternalNewSessionResult: (result: ChatExternalNewSessionResult) => Promise<void>;
    /** Fires when a paired phone asks main to start a new Session (payload pre-validated in main). */
    onExternalNewSession: (
      handler: (e: {
        cwd: string;
        agentName: string;
        tag: AgentPersonaTag;
        title: string;
        prompt: string;
        macroId?: string;
        /** An outside app's own id for the Epic to create. */
        externalRef?: string;
        /** Set when main awaits the result; echo it back via `reportExternalNewSessionResult`. */
        requestId?: string;
        via?: 'script';
        /** Set by main only for via 'script' (epic/scriptStartedBy.cjs); never on a human press. */
        startedBy?: {
          kind: 'script';
          route: string;
          caller?: { pipeline?: string; runId?: string; step?: string; attempt?: number };
          [k: string]: unknown;
        };
        effort?: string;
        /** Scripted job press: build a review cut first. */
        reviewStage?: boolean;
      }) => void,
    ) => () => void;
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
    /** Main requests approve-and-start of a verified inbound proposal. */
    onInboundAutoApprove: (handler: (e: { cwd: string; epicId: string }) => void) => () => void;
    /** Fires when the main process appends an event to a PromptSession's
     *  chain on disk (currently only the scheduler's response-event append
     *  from notifyOriginatingTab) — lets an already-hydrated Epic pick it up
     *  live instead of waiting for a restart. */
    onEventAppended: (handler: (e: PromptSessionEventAppendedPayload) => void) => () => void;
    /** Main-side read-merge-write of a cwd's active-index.json
     *  (lib/epic/activeIndexMerge.cjs) — persistActiveIndex sends only its own
     *  in-memory contribution for the cwd; disk stays main's truth, merged
     *  inside the same lock epicMint.cjs's ensureEpic serializes through. */
    /** Read-tier (remote-safe) Sessions reads, fenced to a registered project's
     *  prompt-sessions ops dir (main/promptSessionsIpc.cjs). Reject on a cwd
     *  that is not a registered project root. */
    loadActiveIndex: (payload: { cwd: string }) => Promise<{ exists: boolean; data: unknown; error?: string }>;
    listArchived: (payload: { cwd: string }) => Promise<{ ok: boolean; ids: string[]; error?: string }>;
    /** This project's earlier Claude Code sessions no Epic owns yet, newest first (restore-as-new-Epic picker). */
    listRestorable: (payload: { cwd: string }) => Promise<PromptSessionsListRestorableResult>;
    /** Interactive (non-headless) restorable sessions across every known project, newest first.
     *  Resolves `{ ok: false, error }` on a refused `limit` or a lister failure — never rejects. */
    listRestorableRecent: (opts?: { limit?: number }) => Promise<PromptSessionsListRestorableRecentResult | { ok: false; error: string }>;
    readArchived: (payload: { cwd: string; epicId: string }) => Promise<{ exists: boolean; data: unknown; error?: string }>;
    readSessionTranscript: (payload: { cwd: string; sessionId: string }) => Promise<{ exists: boolean; text: string; error?: string }>;
    writeArchive: (payload: { cwd: string; epicId: string; archive: Record<string, unknown> }) => Promise<{ ok: true }>;
    mergeActiveIndex: (payload: PromptSessionsMergeActiveIndexPayload) => Promise<PromptSessionsMergeActiveIndexResult>;
    /** Mints a brand-new 'proposed' Epic through main's own ensureEpic()
     *  (lib/epic/promptSessionsCreateEpic.cjs) instead of the renderer
     *  hand-constructing the PromptSession record itself. Unused today —
     *  additive step 1 of a two-PRD chain; a later PRD routes
     *  createPromptSession through this. */
    create: (payload: PromptSessionsCreateEpicPayload) => Promise<PromptSessionsCreateEpicResult>;
    /** Creates this Epic's isolated `git worktree` checkout
     *  (lib/epic/epicWorktreeMint.cjs) — resolves to the `worktree` field shape on
     *  success, or null on any failure (never rejects). */
    createWorktree: (payload: PromptSessionsCreateWorktreePayload) => Promise<PromptSessionsCreateWorktreeResult | null>;
    /** Folds an Epic's isolated git worktree branch back into its owning
     *  project's main tree (lib/epic/epicWorktreeMerge.cjs) — the ONLY point
     *  where PRD 1033's per-Epic isolation resolves back into the shared
     *  tree. Never rejects. */
    mergeToMain: (payload: PromptSessionsMergeToMainPayload) => Promise<PromptSessionsMergeToMainResult>;
    /** Reads the per-project "disable Epic worktree isolation" UI toggle. */
    getWorktreeDisabled: (payload: PromptSessionsGetWorktreeDisabledPayload) => Promise<PromptSessionsGetWorktreeDisabledResult>;
    /** Writes the per-project "disable Epic worktree isolation" UI toggle. */
    setWorktreeDisabled: (payload: PromptSessionsSetWorktreeDisabledPayload) => Promise<PromptSessionsSetWorktreeDisabledResult>;
    /** Archives the raw Claude JSONL to a gzip sidecar main-side; pointer, or null when absent/empty. */
    archiveTranscript: (payload: { cwd: string; epicId: string; claudeSessionId: string }) => Promise<{ path: string; bytes: number; gzBytes: number; sha256: string } | null>;
    /** Reopens a completed Epic in place (same id + claudeSessionId); never mints an Epic. */
    reopen: (payload: PromptSessionsReopenPayload) => Promise<PromptSessionsReopenResult>;
    /** Re-snapshots the Epic's persona and re-stamps its agentSnapshotId — the only way a live
     *  persona edit reaches an existing Epic (lib/epic/epicAgentRefresh.cjs). Audited; same id = no-op. */
    refreshAgentSnapshot: (payload: EpicRefreshAgentSnapshotPayload) => Promise<EpicRefreshAgentSnapshotResult>;
    /** epic:purge — deletes a completed Epic's transcripts, run logs, history rows, PRDs, events and
     *  JSON, leaving a content-free tombstone + one audit record (lib/epic/epicPurge.cjs). Human-only:
     *  the Purge button (typed-id confirm) is its only caller. `dryRun: true` deletes and writes
     *  nothing and returns what a purge would remove (the confirm shows its count). */
    purge: (payload: EpicPurgePayload) => Promise<EpicPurgeResult>;
  };
}

export interface PromptSessionsReopenPayload { cwd: string; epicId: string }
export interface EpicRefreshAgentSnapshotPayload { cwd: string; epicId: string }
export interface EpicPurgePayload { cwd: string; epicId: string; dryRun?: boolean }
export type EpicPurgeArtifactKind =
  | 'cli-transcript' | 'run-log' | 'history-rows' | 'prd-sources' | 'plan-records'
  | 'event-log' | 'agent-snapshot' | 'archived-transcript' | 'epic-json' | 'index-row'
export interface EpicPurgeArtifact { kind: EpicPurgeArtifactKind; path: string }
export type EpicPurgeResult =
  | {
      ok: true
      /** true = nothing was touched; `removed` is then []. */
      dryRun: boolean
      artifacts: EpicPurgeArtifact[]
      counts: Record<EpicPurgeArtifactKind, number>
      total: number
      removed: string[]
    }
  | { ok: false; code: 'not_human' | 'invalid_epic_id' | 'invalid_cwd' | 'epic_running' | string; error: string };
export type EpicRefreshAgentSnapshotResult =
  | { ok: true; changed: boolean; from: string | null; to: string; session: PromptSession }
  | { ok: false; code: string; message: string };

export type PromptSessionsReopenResult =
  | { ok: true; session: PromptSession; events: PromptSessionEvent[]; alreadyOpen: boolean }
  | { ok: false; code: 'not_found' | 'transcript_missing' | 'invalid_session_id' | 'restore_failed' | 'write_failed'; message: string };

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
  tag?: 'feature' | 'bug' | 'discussion' | 'build' | 'project-home-builder' | 'art' | 'portfolio';
  agentType?: string;
  /** Per-Epic model/effort overrides (New Session card); omitted = the persona's own. */
  model?: string;
  effort?: string;
  /** Absent = develop loop on; false = started without it, fixed for the life of the session. */
  developLoop?: boolean;
  source?: {
    producer: 'new-epic-ui' | 'scheduler-dispatch';
    prdSlug?: string;
    runId?: string;
    sourceTabId?: string;
    /** The macro that launched this Epic. */
    macroId?: string;
    /** An outside app's own id for this Epic. */
    externalRef?: string;
  };
  /** Full first-prompt body + its labeled sections (epicIntake.ts's
   *  composeEpicIntake) — carried alongside goalText so the Epic's first
   *  turn can render a structured AIM briefing card. */
  openingPrompt?: string;
  sections?: Array<{
    kind: 'actor' | 'persona-body' | 'injection' | 'input' | 'mission' | 'goal' | 'reference';
    label: string;
    text: string;
    source?: string;
    /** Which part of its AIM slot this entry is; absent on Epics minted before AIM sections. */
    part?: 'persona' | 'grounding' | 'injection' | 'reference' | 'job-type' | 'goal';
  }>;
  /** Adopt an existing CLI session of this project instead of minting one. */
  restoreSessionId?: string;
  /** Agent CLI driving this Epic; absent = Claude Code. Non-Claude forces developLoop false and refuses restore. */
  agentCli?: 'claude' | 'codex' | 'gemini' | 'antigravity' | 'cursor' | 'opencode';
  /** Model for a non-Claude CLI; absent = that CLI's default. */
  agentCliModel?: string;
  /** Selected context pack ids (packs.list ids); absent = none. Loaded by the CLI, never in openingPrompt. */
  packs?: string[];
}

export interface PromptSessionsCreateEpicResult {
  epicId: string;
  session: PromptSession;
}

// ─────────────────────────────────── PromptSessions list-restorable (main-side lib/epic/restorableSessions.cjs)
/** One earlier Claude Code session of this project that no Epic owns yet. */
export interface RestorableSession {
  sessionId: string;
  /** Last `custom-title` row, else last `summary` row. */
  title: string | null;
  /** First real user prompt in the transcript head. */
  firstPrompt: string;
  lastPrompt: string | null;
  gitBranch: string | null;
  /** First recorded entrypoint is `sdk-*` (a `claude -p` / SDK run). */
  headless: boolean;
  mtimeMs: number;
  sizeBytes: number;
  /** Written in the last 120 s, so it may still be open in a terminal. */
  recentlyActive: boolean;
}

export interface PromptSessionsListRestorableResult {
  /** Newest first by mtime. */
  sessions: RestorableSession[];
  /** Transcripts left out because an Epic already owns them. */
  hiddenClaimed: number;
  /** Transcript heads read by this call. */
  scanned: number;
  /** The walk stopped with candidates left. */
  truncated: boolean;
}

// ─────────────────────────────────── PromptSessions list-restorable-recent (restorableSessions.cjs listRecentRestorableSessions)
/** A RestorableSession from any known project, tagged with the project it belongs to. */
export type RecentRestorableSession = RestorableSession & {
  /** Project root the transcript belongs to. */
  cwd: string;
};

export interface PromptSessionsListRestorableRecentResult {
  /** Newest first by mtime, across projects. */
  sessions: RecentRestorableSession[];
  /** Projects whose transcripts were read by this call. */
  projectsRead: number;
  /** Some project's walk, or the project list, stopped with candidates left. */
  truncated: boolean;
}

// ─────────────────────────────────── PromptSessions create-worktree (main-side createEpicWorktree)
export interface PromptSessionsCreateWorktreePayload {
  cwd: string;
  epicId: string;
}

export interface PromptSessionsCreateWorktreeResult {
  dir: string;
  branch: string;
  baseCwd: string;
  status: 'active' | 'needs_merge_resolution' | 'merged' | 'disabled';
  carriedPaths?: string[];
}

// ─────────────────────────────────── PromptSessions merge-to-main (main-side integrateEpicBranch)
export interface PromptSessionsMergeToMainPayload {
  cwd: string;
  epicId: string;
  branch: string;
  dir: string;
  carriedPaths?: string[];
}

export interface PromptSessionsMergeToMainResult {
  ok: boolean;
  status: 'merged' | 'needs_merge_resolution';
  integrated?: boolean;
  reason?: string;
}

// ─────────────────────────────────── PromptSessions per-project worktree-isolation toggle
export interface PromptSessionsGetWorktreeDisabledPayload {
  cwd: string;
}

export interface PromptSessionsGetWorktreeDisabledResult {
  disabled: boolean;
}

export interface PromptSessionsSetWorktreeDisabledPayload {
  cwd: string;
  disabled: boolean;
}

export interface PromptSessionsSetWorktreeDisabledResult {
  disabled: boolean;
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
    /** 'job-not-queued' = a macro's background build could not be queued for this Epic (macroJobIpc.cjs);
     *  'build-done' / 'build-failed' = a macro's background-build PRD finished (scheduler.cjs notifyOriginatingTab). */
    notice?: 'job-not-queued' | 'build-done' | 'build-failed' | 'artifact-ready';
    /** The saved Project Home entry a 'build-done' notice names, when its meta.json was readable. */
    buildOutput?: { kind: 'video' | 'knowledge'; id: string; title: string };
    /** 'artifact-ready' rows (lib/epic/artifactNotice.cjs); `path` is relative to the project cwd. */
    artifacts?: Array<{ title: string; kind: string; path: string; size: number }>;
    /** 'artifact-ready' only — artifacts beyond the listed rows. */
    moreCount?: number;
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

interface LoopEfficiencyRow {
  cwd: string;
  project: string;
  runs: number;
  wastedRuns: number;
  verified: number;
  refuted: number;
  executorUsd: number;
  usdPerVerified: number | null;
}
interface ValidationQualityEscape {
  fixPrd: string;
  escapedPrd: string;
  verifiedBy: string | null;
  missKind: string;
  reason: string;
  at: string;
}
interface ValidationQualityProject {
  cwd: string;
  project: string;
  firstPass: { pct: number | null; prds: string[] };
  refuted: { pct: number | null; prds: string[] };
  fixWaves: { perPlan: number | null; plans: { plan: string; fixWaves: string[] }[] };
  escapes: ValidationQualityEscape[];
  week: {
    fromMs: number;
    toMs: number;
    topMiss: null | { missKind: string; count: number; prds: string[]; reasons: string[]; proposal: string };
    /** REFUTED verdicts recorded before checked JSON verdicts — no miss kind, kept out of topMiss. */
    unclassified: { count: number; prds: string[]; reasons: string[] };
  };
}
interface LoopEfficiencyResult {
  fromMs: number;
  toMs: number;
  rows: LoopEfficiencyRow[];
  totals: { runs: number; wastedRuns: number; verified: number; refuted: number; executorUsd: number; wastedRunRate: number };
  weeklyUtilizationPct: number | null;
  verifiedPerUsagePct: number | null;
}
