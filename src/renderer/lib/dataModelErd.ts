/**
 * dataModelErd.ts — the one source of truth for "what does Session Manager
 * actually persist, and how do the pieces relate."
 *
 * This is a hand-maintained MIRROR of real on-disk/in-memory shapes, not a
 * runtime scanner — it can drift from the code. Every `store.path` and
 * `store.definedIn` below names a real file that was read before this entry
 * was written; every field is taken verbatim from that file's own type
 * (mostly src/preload/api.d.ts, src/renderer/state/promptSessions.ts,
 * src/renderer/lib/knownProjectAggregate.ts, src/renderer/lib/tagLibrary.ts,
 * src/main/lib/opsOwnership.cjs). If a persisted shape changes, this file
 * must change in the same PR — see code-map.md.
 *
 * Kept as plain data (no React, no DOM) so the diagram, the table view, and
 * the integrity test in __tests__/dataModelErd.test.ts all read one model,
 * and `layoutErd` stays a pure function unit-testable without a browser.
 */

export type ErdGroupId =
  | 'project'
  | 'epic'
  | 'scheduler'
  | 'agents'
  | 'memory'
  | 'transcript'
  | 'brief'
  | 'config'

export interface ErdGroup {
  id: ErdGroupId
  label: string
  realm: 'machine' | 'project' | 'both'
  blurb: string
  tone: { chip: string; border: string; dot: string }
}

export interface ErdField {
  name: string
  type: string
  key?: 'pk' | 'fk'
  ref?: string
  optional?: boolean
  note?: string
}

export interface ErdEntity {
  id: string
  name: string
  aka?: string
  group: ErdGroupId
  store: {
    path: string
    format: 'json' | 'jsonl' | 'markdown' | 'directory' | 'in-memory' | 'code'
    writer?: string
    definedIn: string
  }
  summary: string
  fields: ErdField[]
  notes?: string[]
}

export type ErdCardinality = '1-1' | '1-N' | 'N-1' | 'N-N'

export interface ErdRelation {
  from: string
  to: string
  cardinality: ErdCardinality
  via?: string
  label: string
  optional?: boolean
}

export interface ErdBox {
  id: string
  group: ErdGroupId
  x: number
  y: number
  w: number
  h: number
}

export interface ErdEdge {
  relation: ErdRelation
  d: string
  mx: number
  my: number
}

export interface ErdLayout {
  boxes: ErdBox[]
  edges: ErdEdge[]
  width: number
  height: number
}

// ─── Groups ─────────────────────────────────────────────────────────────

export const ERD_GROUPS: ErdGroup[] = [
  {
    id: 'project',
    label: 'Project & Tab',
    realm: 'machine',
    blurb: 'A PROJECT is a cwd; a TAB is one open project.',
    tone: { chip: 'bg-bg-elev text-fg-dim', border: 'border-line', dot: 'bg-fg-faint' },
  },
  {
    id: 'epic',
    label: 'Epic (PromptSession)',
    realm: 'project',
    blurb: 'The central aggregate root — one unit of work, one claude session.',
    tone: { chip: 'bg-accent-muted text-accent-dark', border: 'border-accent', dot: 'bg-accent' },
  },
  {
    id: 'scheduler',
    label: 'Scheduler',
    realm: 'project',
    blurb: 'PRDs + the headless jobs that execute them.',
    tone: { chip: 'bg-butter/30 text-honey-dark', border: 'border-honey', dot: 'bg-honey' },
  },
  {
    id: 'agents',
    label: 'Agents & Taxonomy',
    realm: 'machine',
    blurb: 'The ACTOR and MISSION halves of AIM.',
    tone: { chip: 'bg-sage/20 text-sage-dark', border: 'border-sage', dot: 'bg-sage' },
  },
  {
    id: 'memory',
    label: 'Memory',
    realm: 'machine',
    blurb: 'Workspace, cross-project, and per-agent memory.',
    tone: { chip: 'bg-hive-teal/20 text-hive-teal', border: 'border-hive-teal', dot: 'bg-hive-teal' },
  },
  {
    id: 'transcript',
    label: 'Transcript & Usage',
    realm: 'machine',
    blurb: "The Claude CLI's own JSONL, classified events, and billing.",
    tone: { chip: 'bg-bg-hi text-fg-dim', border: 'border-rule', dot: 'bg-fg-dim' },
  },
  {
    id: 'brief',
    label: 'Project Home & Publishing',
    realm: 'project',
    blurb: 'The synthesized Brief, generated pages, and bilko.run publish state.',
    tone: { chip: 'bg-accent-muted/60 text-accent-dark', border: 'border-accent-muted', dot: 'bg-accent-muted' },
  },
  {
    id: 'config',
    label: 'Machine Config',
    realm: 'machine',
    blurb: 'Settings, layout, and the single-writer ownership map.',
    tone: { chip: 'bg-line text-fg-faint', border: 'border-rule', dot: 'bg-fg-faint' },
  },
]

export function erdGroup(id: ErdGroupId): ErdGroup {
  const found = ERD_GROUPS.find((g) => g.id === id)
  if (!found) throw new Error(`unknown ErdGroupId: ${id}`)
  return found
}

// ─── Entities ───────────────────────────────────────────────────────────
//
// store.definedIn values name real .cjs/.ts modules as plain descriptive
// text (not import statements) — written with a trailing space before the
// closing quote so a literal-string integrity grep for import syntax never
// mistakes this prose for code.

export const ERD_ENTITIES: ErdEntity[] = [
  {
    id: 'project',
    name: 'Project',
    aka: 'cwd — Main Project',
    group: 'project',
    store: {
      path: 'identity only, no record of its own — folded at read time from ~/.claude/projects/<encoded>',
      format: 'in-memory',
      definedIn: 'src/renderer/lib/knownProjectAggregate.ts (aggregateProjectsByCwd) ',
    },
    summary:
      'A folder whose cwd never resolved from transcript content is DROPPED, never guessed — the naive decode once reported 2044 phantom projects.',
    fields: [
      { name: 'cwd', type: 'string', key: 'pk', note: "resolved working directory — the project's identity" },
      { name: 'name', type: 'string', note: "display name: the cwd's last path segment" },
      { name: 'encoded', type: 'string', note: 'representative transcript folder (most recently active)' },
      { name: 'encodedIds', type: 'string[]', note: 'every ~/.claude/projects/<encoded> folder that resolved to this cwd' },
      { name: 'sessionCount', type: 'number' },
      { name: 'sizeBytes', type: 'number' },
      { name: 'lastSession', type: 'number' },
    ],
  },
  {
    id: 'tab',
    name: 'PersistedTab',
    aka: 'TAB',
    group: 'project',
    store: {
      path: '~/.config/session-manager/tabs.json',
      format: 'json',
      definedIn: 'src/main/sessionsStore.cjs ',
    },
    summary: 'One TAB per project — extra sessions within a project are Epics, not tabs.',
    fields: [
      { name: 'id', type: 'string', key: 'pk' },
      { name: 'sessionId', type: 'string' },
      { name: 'cwd', type: 'string', key: 'fk', ref: 'project.cwd' },
      { name: 'label', type: 'string' },
      { name: 'presetId', type: 'string | null' },
    ],
  },
  {
    id: 'epic',
    name: 'PromptSession',
    aka: 'EPIC',
    group: 'epic',
    store: {
      path: '<cwd>/session-manager-operations/prompt-sessions/active-index.json -> sessions[id]',
      format: 'json',
      writer: 'epics',
      definedIn: 'src/main/lib/epicMint.cjs (ensureEpic) + src/renderer/state/promptSessions.ts ',
    },
    summary: 'The central aggregate root — created in exactly ONE place, a human pressing New Epic.',
    fields: [
      { name: 'id', type: 'string', key: 'pk' },
      { name: 'cwd', type: 'string', key: 'fk', ref: 'project.cwd' },
      { name: 'goalText', type: 'string', note: 'the original top-level prompt text that started this goal' },
      { name: 'claudeSessionId', type: 'string', note: 'independently minted — never shared with any tab.sessionId' },
      { name: 'status', type: "'proposed' | 'active' | 'completed'" },
      { name: 'createdAt', type: 'string' },
      { name: 'completedAt', type: 'string | null' },
      { name: 'resumedFromId', type: 'string', optional: true, key: 'fk', ref: 'epic.id' },
      { name: 'tag', type: 'TicketTag', optional: true, key: 'fk', ref: 'tag.tag' },
      { name: 'openingPrompt', type: 'string | null', optional: true },
      { name: 'source', type: 'EpicSource', optional: true, note: '{ producer, prdSlug?, runId?, sourceTabId?, fromCwd?, fromEpicId? }' },
      { name: 'agentType', type: 'string', optional: true, key: 'fk', ref: 'agentPersona.name' },
      { name: 'sections', type: 'EpicIntakeSection[]', optional: true },
      {
        name: 'worktree',
        type: '{ dir, branch, baseCwd, status, conflictReason? }',
        optional: true,
        note: "own git worktree on branch 'sm-epic/<id>' when Active",
      },
    ],
    notes: [
      'SINGLE-CREATOR LAW, fail-closed in epicMint.cjs — the New Epic IPC handler and crossProjectFeedback.cjs are the only mint authorities.',
      'Every Epic is born proposed; nothing is created directly as active.',
      'EPIC : claude-session is 1:1 — Chat and Terminal are two VIEWS over one session.',
      "Title + objective are fixed for the life of the session — iterate in follow-up messages, don't repurpose.",
    ],
  },
  {
    id: 'epicEvent',
    name: 'PromptSessionEvent',
    group: 'epic',
    store: {
      path: '<cwd>/session-manager-operations/prompt-sessions/active-index.json -> events[]',
      format: 'json',
      writer: 'epics',
      definedIn: 'src/renderer/state/promptSessions.ts + src/main/lib/activeIndexMerge.cjs ',
    },
    summary: "One step in an Epic's Prompt → PRD → Response → ... → Closed chain.",
    fields: [
      { name: 'id', type: 'string', key: 'pk' },
      { name: 'promptSessionId', type: 'string', key: 'fk', ref: 'epic.id' },
      { name: 'kind', type: "'prompt' | 'prd_created' | 'response' | 'closed'" },
      { name: 'causedByEventId', type: 'string | null', key: 'fk', ref: 'epicEvent.id', note: "must be the session's current tail event — a chain, not a tree" },
      { name: 'at', type: 'string' },
      { name: 'prdSlug', type: 'string', optional: true, key: 'fk', ref: 'prd.slug' },
      { name: 'text', type: 'string', optional: true },
      { name: 'outcome', type: "'completed' | 'failed' | 'needs_review'", optional: true },
      { name: 'validation', type: "'unvalidated' | 'validating' | 'verified' | 'refuted'", optional: true },
    ],
  },
  {
    id: 'epicTranscriptTurn',
    name: 'PromptSessionTranscriptTurn',
    group: 'epic',
    store: {
      path: '<cwd>/session-manager-operations/prompt-sessions/transcripts/<epicId>.jsonl',
      format: 'jsonl',
      writer: 'epics',
      definedIn: 'src/main/promptSessionTranscript.cjs ',
    },
    summary: "The durable per-Epic transcript store, kept alongside the CLI's own JSONL as a fallback source of turns.",
    fields: [
      { name: 'v', type: '1' },
      { name: 'epicId', type: 'string', key: 'fk', ref: 'epic.id' },
      { name: 'eventId', type: 'string | null', key: 'fk', ref: 'epicEvent.id' },
      { name: 'role', type: "'user' | 'assistant'" },
      { name: 'at', type: 'string' },
      { name: 'text', type: 'string' },
    ],
  },
  {
    id: 'epicArchive',
    name: 'PromptSessionArchive',
    group: 'epic',
    store: {
      path: '<cwd>/session-manager-operations/prompt-sessions/<epicId>.json',
      format: 'json',
      writer: 'epics',
      definedIn: 'src/renderer/state/promptSessions.ts (promptSessionArchivePath) ',
    },
    summary: 'On-disk archive written once at completion — freezes the Epic, its events, and its transcript.',
    fields: [
      { name: 'session', type: 'PromptSession' },
      { name: 'events', type: 'PromptSessionEvent[]' },
      { name: 'transcript', type: 'string' },
      { name: 'archivedAt', type: 'string' },
      { name: 'durableTurns', type: 'Array<{ role, text, at }>', optional: true },
    ],
  },
  {
    id: 'prd',
    name: 'PRD',
    group: 'scheduler',
    store: {
      path: '<cwd>/session-manager-operations/scheduler/epics/<epicId>/prds/<slug>.md',
      format: 'markdown',
      writer: 'scheduler',
      definedIn: 'src/main/lib/prdLocations.cjs + scheduler_create_prd MCP tool ',
    },
    summary: 'PRD authoring is API-only via the scheduler_create_prd MCP tool — a PRD joins an EXISTING Epic and never conjures one.',
    fields: [
      { name: 'slug', type: 'string', key: 'pk', note: '<nn>-<kebab-title>.md filename stem' },
      { name: 'title', type: 'string' },
      { name: 'cwd', type: 'string', key: 'fk', ref: 'project.cwd' },
      { name: 'epicId', type: 'string | null', key: 'fk', ref: 'epic.id', note: "derived from the PRD's DIRECTORY — fact on disk" },
      { name: 'sourcePromptId', type: 'string', optional: true, key: 'fk', ref: 'epic.id', note: 'frontmatter intent — can disagree with epicId' },
      { name: 'sourceTabId', type: 'string', optional: true },
      { name: 'estimateMinutes', type: 'number' },
      { name: 'tag', type: "'feature' | 'bug' | 'discussion' | 'build' | 'project-home-builder' | 'bilko-host-publisher'", optional: true, key: 'fk', ref: 'tag.tag' },
      { name: 'dependsOn', type: 'string[]', optional: true, key: 'fk', ref: 'prd.slug', note: 'the SOLE ordering primitive' },
      { name: 'goal', type: 'string' },
      { name: 'acceptanceCriteria', type: 'string[]' },
      { name: 'implementationNotes', type: 'string' },
      { name: 'outOfScope', type: 'string[]', optional: true },
      { name: 'createdVia', type: 'string', optional: true },
      { name: 'issuedAt', type: 'string', optional: true },
    ],
    notes: [
      'Flat scheduler/prds/ is RETIRED — auto-consolidated into prds-archived/ on every reconcile() pass.',
      'epicId is derived from the DIRECTORY (fact on disk) while sourcePromptId is frontmatter intent and can disagree.',
    ],
  },
  {
    id: 'scheduleJob',
    name: 'ScheduleJob',
    group: 'scheduler',
    store: {
      path: '<cwd>/session-manager-operations/scheduler/state/queue.json -> jobs[]',
      format: 'json',
      writer: 'scheduler',
      definedIn: 'src/main/lib/queueStore.cjs + src/main/lib/scheduleJobSchema.cjs ',
    },
    summary: 'dependsOn is the SOLE ordering primitive — parallelGroup is a display hint, never a barrier.',
    fields: [
      { name: 'slug', type: 'string', key: 'pk', note: 'shared identity with the PRD it executes' },
      { name: 'title', type: 'string' },
      { name: 'cwd', type: 'string | null', key: 'fk', ref: 'project.cwd' },
      { name: 'parallelGroup', type: 'number' },
      { name: 'estimateMinutes', type: 'number | null' },
      { name: 'bodyPreview', type: 'string' },
      { name: 'status', type: "'pending' | 'running' | 'investigating' | 'completed' | 'failed' | 'needs_review' | 'quarantined'" },
      { name: 'runId', type: 'string | null', key: 'fk', ref: 'runLog.runId' },
      { name: 'startedAt', type: 'string | null' },
      { name: 'finishedAt', type: 'string | null' },
      { name: 'exitCode', type: 'number | null' },
      { name: 'error', type: 'string | null' },
      { name: 'sessionId', type: 'string', optional: true },
      { name: 'runtime', type: 'ScheduleJobRuntime', optional: true, note: '{ pid, runId, startedAt, sessionId?, cwd? }' },
      { name: 'verifierVerdict', type: 'string', optional: true },
      { name: 'dependsOn', type: 'string[]', optional: true, key: 'fk', ref: 'prd.slug' },
      { name: 'originSessionId', type: 'string | null', optional: true, key: 'fk', ref: 'epic.id' },
      { name: 'sourceTabId', type: 'string | null', optional: true },
      { name: 'sourcePromptId', type: 'string | null', optional: true, key: 'fk', ref: 'epic.id' },
      { name: 'epicId', type: 'string | null', optional: true, key: 'fk', ref: 'epic.id', note: 'authoritative — derived from the PRD directory' },
      { name: 'statusHistory', type: 'ScheduleJobStatusHistoryEntry[]', optional: true },
    ],
    notes: [
      'Every launch must take a slot from lib/sessionSlots.cjs — the single machine-wide concurrency limit.',
      '--model is always pinned on every claude -p call site.',
      'A job in needs_review is a QUESTION routed back to the authoring Epic and never creates work on its own.',
    ],
  },
  {
    id: 'scheduleJobStatusHistory',
    name: 'ScheduleJobStatusHistoryEntry',
    group: 'scheduler',
    store: {
      path: '<cwd>/session-manager-operations/scheduler/state/queue.json -> jobs[].statusHistory[]',
      format: 'json',
      writer: 'scheduler',
      definedIn: 'src/main/lib/scheduleJobTransitions.cjs ',
    },
    summary: 'Bounded trail (~20 entries) of accepted status transitions for one ScheduleJob.',
    fields: [
      { name: 'from', type: 'string | null' },
      { name: 'to', type: 'string' },
      { name: 'reason', type: 'string | null' },
      { name: 'source', type: 'string | null' },
      { name: 'at', type: 'string' },
    ],
  },
  {
    id: 'scheduleHistoryEntry',
    name: 'Schedule history entry',
    group: 'scheduler',
    store: {
      path: '<cwd>/session-manager-operations/scheduler/state/history.jsonl',
      format: 'jsonl',
      writer: 'scheduler',
      definedIn: 'src/main/lib/queueStore.cjs ',
    },
    summary: 'Terminal jobs aged out of queue.json land here, one JSON object per line.',
    fields: [
      { name: 'slug', type: 'string', key: 'fk', ref: 'prd.slug' },
      { name: 'status', type: 'ScheduleJobStatus' },
      { name: 'finishedAt', type: 'string | null' },
      { name: 'epicId', type: 'string | null', optional: true, key: 'fk', ref: 'epic.id' },
      { name: 'runId', type: 'string | null', optional: true, key: 'fk', ref: 'runLog.runId' },
    ],
  },
  {
    id: 'scheduleConfig',
    name: 'ScheduleConfig',
    group: 'scheduler',
    store: {
      path: '<cwd>/session-manager-operations/scheduler/state/queue.json -> config',
      format: 'json',
      writer: 'scheduler',
      definedIn: 'src/main/lib/schedulerConfig.cjs ',
    },
    summary: 'Per-project auto-fire policy and utilization gate.',
    fields: [
      { name: 'enabled', type: 'boolean', note: 'legacy on/off, kept for v0.4 backwards compat' },
      { name: 'offsetMinutes', type: 'number' },
      { name: 'defaultCwd', type: 'string', key: 'fk', ref: 'project.cwd' },
      { name: 'firePolicy', type: "'manual' | 'on-reset' | 'when-available'" },
      { name: 'utilizationThreshold', type: 'number' },
      { name: 'schemaVersion', type: '1' },
    ],
  },
  {
    id: 'runLog',
    name: 'Run log',
    group: 'scheduler',
    store: {
      path: '~/.claude/session-manager/scheduled-plans/runs/<runId>/',
      format: 'directory',
      definedIn: 'src/main/scheduler.cjs (RUNS_DIR) ',
    },
    summary: "One directory per headless claude -p invocation — stdout/stderr/exit capture for a ScheduleJob's run.",
    fields: [{ name: 'runId', type: 'string', key: 'pk' }],
  },
  {
    id: 'agentPersona',
    name: 'AgentPersona',
    aka: 'ACTOR — also an ACTION when scoped',
    group: 'agents',
    store: {
      path: '~/.claude/agents/<name>.md',
      format: 'markdown',
      definedIn: 'src/main/agentLibrary.cjs + src/main/lib/agentPersonaSchema.cjs ',
    },
    summary: 'One global persona — an ACTION is this same persona given a project scope, not a fourth concept.',
    fields: [
      { name: 'name', type: 'string', key: 'pk' },
      { name: 'description', type: 'string | null' },
      { name: 'tools', type: 'string[]' },
      { name: 'model', type: 'string | null', note: 'wins over the Settings default for this Epic' },
      { name: 'color', type: 'string | null' },
      { name: 'tags', type: 'AgentPersonaTag[]', key: 'fk', ref: 'tag.tag' },
      { name: 'projects', type: 'string[]', key: 'fk', ref: 'project.cwd', note: "'*' means every project" },
      { name: 'action', type: 'string | null' },
      { name: 'actionLabel', type: 'string | null' },
      { name: 'title', type: 'string | null', optional: true },
      { name: 'path', type: 'string' },
      { name: 'body', type: 'string' },
      { name: 'overridingProjects', type: 'string[]' },
    ],
  },
  {
    id: 'tag',
    name: 'Tag',
    aka: 'MISSION — EpicTag',
    group: 'agents',
    store: {
      path: 'src/renderer/lib/tagLibrary.ts (TAG_LIBRARY)',
      format: 'code',
      definedIn: 'src/renderer/lib/tagLibrary.ts + src/renderer/lib/agentTagDefs.ts ',
    },
    summary: 'The closed 5-taxonomy union — Epic creation is agentType (who) + tag (what), two independent selections.',
    fields: [
      { name: 'tag', type: "'feature' | 'bug' | 'discussion' | 'build' | 'project-home-builder' | 'bilko-host-publisher'", key: 'pk' },
      { name: 'label', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'developEagerness', type: "'expected-default' | 'available-not-assumed'" },
      { name: 'developsVia', type: 'string' },
    ],
  },
  {
    id: 'memoryEntry',
    name: 'MemoryEntry',
    group: 'memory',
    store: {
      path: '~/.claude/projects/<encodedCwd>/memory/<name>.md',
      format: 'markdown',
      definedIn: 'src/main/memoryTool.cjs ',
    },
    summary: 'One workspace memory file, semantically organized by topic.',
    fields: [
      { name: 'name', type: 'string', key: 'pk' },
      { name: 'path', type: 'string' },
      { name: 'mtimeMs', type: 'number' },
      { name: 'bytes', type: 'number' },
      { name: 'workspace', type: 'string', key: 'fk', ref: 'project.cwd', note: 'carried on MemoryListResult, denormalized here — the directory this entry lives under' },
    ],
  },
  {
    id: 'memoryCluster',
    name: 'MemoryCluster',
    group: 'memory',
    store: {
      path: '~/.claude/session-manager/memory-clusters/<encodedCwd>.json',
      format: 'json',
      definedIn: 'src/main/memoryAggregate.cjs ',
    },
    summary: 'Derived grouping of related MemoryEntry files, computed and cached per workspace.',
    fields: [
      { name: 'id', type: 'string', key: 'pk' },
      { name: 'name', type: 'string' },
      { name: 'summary', type: 'string' },
      { name: 'memberSlugs', type: 'string[]', key: 'fk', ref: 'memoryEntry.name' },
      { name: 'links', type: 'MemoryClusterLink[]', note: '{ from, to, label? }' },
    ],
  },
  {
    id: 'agentMemoryEntry',
    name: 'AgentMemoryEntry',
    group: 'memory',
    store: {
      path: '~/.claude/session-manager/agent-memory/<agentId>/',
      format: 'directory',
      definedIn: 'src/renderer/state/agentMemory.ts ',
    },
    summary: 'Per-subagent memory, keyed by agent name rather than workspace cwd.',
    fields: [
      { name: 'id', type: 'string', key: 'pk' },
      { name: 'body', type: 'string' },
      { name: 'category', type: "'command' | 'preference' | 'pattern' | 'failure' | 'workflow' | null" },
      { name: 'createdAt', type: 'number' },
      { name: 'updatedAt', type: 'number' },
      { name: 'bytes', type: 'number' },
      { name: 'agentId', type: 'string', key: 'fk', ref: 'agentPersona.name', note: 'carried on AgentMemoryListResult, denormalized here — the directory this entry lives under' },
    ],
  },
  {
    id: 'claudeTranscript',
    name: 'Claude transcript',
    group: 'transcript',
    store: {
      path: '~/.claude/projects/<encodedCwd>/<sessionUuid>.jsonl',
      format: 'jsonl',
      definedIn: 'written by the Claude Code CLI; tailed by src/main/transcripts.cjs ',
    },
    summary: 'The CLI\'s own append-only transcript — Session Manager only tails and classifies it, never writes it.',
    fields: [
      { name: 'sessionUuid', type: 'string', key: 'pk' },
      { name: 'encodedCwd', type: 'string', key: 'fk', ref: 'project.cwd' },
    ],
  },
  {
    id: 'transcriptEvent',
    name: 'TranscriptEvent',
    group: 'transcript',
    store: {
      path: 'in-memory ring buffer, broadcast as transcript:event:<tabId>',
      format: 'in-memory',
      definedIn: 'src/main/transcripts.cjs -> src/renderer/state/live.ts ',
    },
    summary: 'Classified, bounded-preview view over one raw transcript line — never the source of truth.',
    fields: [
      { name: 'kind', type: 'TranscriptEventKind' },
      { name: 'data', type: 'unknown' },
      { name: 'raw', type: 'unknown' },
      { name: 'previewText', type: 'string' },
      { name: 'ref', type: 'TranscriptEventRef | null', note: '{ filePath, byteOffset, byteLength }' },
      { name: 'tabId', type: 'string', key: 'fk', ref: 'tab.id' },
    ],
  },
  {
    id: 'historyRollupDay',
    name: 'History rollup day',
    group: 'transcript',
    store: {
      path: '~/.claude/session-manager/history-rollup.jsonl',
      format: 'jsonl',
      definedIn: 'src/main/lib/historyRollup.cjs ',
    },
    summary: 'One finalized day-per-project analytics row (History tab is analytics/cost/charts only).',
    fields: [
      { name: 'date', type: 'string', key: 'pk' },
      { name: 'projectCwd', type: 'string', key: 'fk', ref: 'project.cwd' },
      { name: 'promptCount', type: 'number' },
      { name: 'inputTokens', type: 'number' },
      { name: 'outputTokens', type: 'number' },
      { name: 'estimatedCostUsd', type: 'number' },
    ],
  },
  {
    id: 'billingUsage',
    name: 'UsageSnapshot',
    group: 'transcript',
    store: {
      path: '~/.claude/session-manager/billing-cache.json',
      format: 'json',
      definedIn: 'src/main/usage.cjs (CACHE_PATH) ',
    },
    summary: "Cached rolling-window utilization percentages from the account's billing API.",
    fields: [
      { name: 'five_hour', type: 'UsageWindow | null' },
      { name: 'seven_day', type: 'UsageWindow | null' },
      { name: 'seven_day_sonnet', type: 'UsageWindow | null' },
      { name: 'seven_day_opus', type: 'UsageWindow | null' },
      { name: 'seven_day_oauth_apps', type: 'UsageWindow | null' },
      { name: 'extra_usage', type: '{ is_enabled, monthly_limit, used_credits, utilization, currency } | null' },
    ],
  },
  {
    id: 'projectBrief',
    name: 'ProjectBrief',
    group: 'brief',
    store: {
      path: '<cwd>/session-manager-operations/project-brief/brief.json',
      format: 'json',
      writer: 'project-home',
      definedIn: 'src/main/projectBrief.cjs ',
    },
    summary: 'The synthesized project Brief — generated, with a hand-edit escape hatch.',
    fields: [
      { name: 'version', type: 'number' },
      { name: 'synthesizedAt', type: 'string' },
      { name: 'editedAt', type: 'string | null' },
      { name: 'model', type: 'string' },
      { name: 'purpose', type: 'string' },
      { name: 'what', type: 'string[]' },
      { name: 'areas', type: 'ProjectBriefArea[]', note: '{ name, files, note, epic, heat }' },
      { name: 'scope', type: 'ProjectBriefScopeEntry[]', note: '{ when, kind, text, src }' },
      { name: 'conventions', type: 'string[]' },
      { name: 'pins', type: '{ what: boolean; conventions: boolean }' },
      { name: 'pinned', type: '{ what: string[] | null; conventions: string[] | null }' },
    ],
  },
  {
    id: 'projectPages',
    name: 'ProjectPagesOutput',
    group: 'brief',
    store: {
      path: '<cwd>/session-manager-operations/project-pages/ (output/, picks.json, summary.json)',
      format: 'directory',
      definedIn: 'project-home-builder agent (Write-tool output)',
    },
    summary: 'Deliberately NOT owned in OWNERS — agent-authored artifact, no concurrent-write hazard.',
    fields: [
      { name: 'home', type: 'string' },
      { name: 'marketing', type: 'string', optional: true },
      { name: 'feature', type: 'string', optional: true },
      { name: 'architecture', type: 'string', optional: true },
      { name: 'brief', type: 'string', optional: true },
      { name: 'generatedAt', type: 'string | null' },
      { name: 'isDefault', type: 'boolean' },
    ],
  },
  {
    id: 'bilkoPublishState',
    name: 'BilkoHostPublishState',
    group: 'brief',
    store: {
      path: '<cwd>/session-manager-operations/bilko-host/publish-state.json',
      format: 'json',
      writer: 'bilko-host',
      definedIn: 'src/renderer/lib/bilkoHost.ts + bilko-host MCP ',
    },
    summary: 'The bilko.run relay is intentionally still live — never delete or decommission it.',
    fields: [
      { name: 'status', type: "'not-published' | 'bundle-ready' | 'publishing' | 'published' | 'publish-failed'" },
      { name: 'slug', type: 'string' },
      { name: 'url', type: 'string', optional: true },
      { name: 'lastAttemptAt', type: 'string', optional: true },
      { name: 'lastError', type: 'string', optional: true },
    ],
  },
  {
    id: 'settingsScope',
    name: 'Settings (scoped)',
    group: 'config',
    store: {
      path: '~/.claude/settings.json + <cwd>/.claude/settings.json + <cwd>/.claude/settings.local.json',
      format: 'json',
      definedIn: 'src/main/config.cjs + src/renderer/state/config.ts + src/renderer/lib/mergeScopes.ts ',
    },
    summary: 'Substrate, not per-Epic curation — model is the one field carved out per-Epic (persona wins over Settings).',
    fields: [
      { name: 'scope', type: "'system' | 'project' | 'local'", key: 'pk' },
      { name: 'cwd', type: 'string', optional: true, key: 'fk', ref: 'project.cwd' },
      { name: 'model', type: 'string', optional: true },
    ],
  },
  {
    id: 'layoutEnvelope',
    name: 'LayoutEnvelope',
    group: 'config',
    store: {
      path: '~/.claude/session-manager/workbench-layout.json',
      format: 'json',
      definedIn: 'src/main/layoutStore.cjs + src/renderer/state/layout.ts ',
    },
    summary: 'Persisted dockview panel layout, pruned against the live panel registry on hydrate.',
    fields: [
      { name: 'version', type: 'number' },
      { name: 'panels', type: 'string[]', key: 'fk', ref: 'tab.id' },
      { name: 'dockview', type: 'Record<string, unknown>', note: 'opaque SerializedDockview blob' },
    ],
  },
  {
    id: 'opsNamespace',
    name: 'Ops namespace ownership',
    aka: 'the SINGLE-WRITER LAW',
    group: 'config',
    store: {
      path: 'src/main/lib/opsOwnership.cjs (OWNERS)',
      format: 'code',
      definedIn: 'src/main/lib/opsOwnership.cjs (assertOpsWrite) ',
    },
    summary: 'Fail-closed — a new top-level ops folder must land in OWNERS (or the deliberately-unowned list) in the same PR that creates it.',
    fields: [
      { name: 'namespace', type: 'string', key: 'pk', note: "e.g. 'prompt-sessions', 'scheduler', 'project-brief', 'bilko-host'" },
      { name: 'writer', type: 'string', note: "e.g. 'epics', 'scheduler', 'project-home', 'bilko-host'" },
    ],
  },
]

export function erdEntity(id: string): ErdEntity {
  const found = ERD_ENTITIES.find((e) => e.id === id)
  if (!found) throw new Error(`unknown ErdEntity id: ${id}`)
  return found
}

// ─── Relations ──────────────────────────────────────────────────────────

export const ERD_RELATIONS: ErdRelation[] = [
  { from: 'tab', to: 'project', cardinality: 'N-1', label: 'belongs to' },
  { from: 'epic', to: 'project', cardinality: 'N-1', label: 'belongs to' },
  { from: 'epic', to: 'tag', cardinality: 'N-1', label: 'mission', optional: true },
  { from: 'epic', to: 'agentPersona', cardinality: 'N-1', label: 'actor', optional: true },
  { from: 'epic', to: 'epic', cardinality: 'N-1', label: 'resumed from', optional: true },
  { from: 'epic', to: 'claudeTranscript', cardinality: '1-1', label: '1:1 session' },
  { from: 'epicEvent', to: 'epic', cardinality: 'N-1', label: 'belongs to' },
  { from: 'epicEvent', to: 'epicEvent', cardinality: 'N-1', label: 'caused by', optional: true },
  { from: 'epicEvent', to: 'prd', cardinality: 'N-1', label: 'about', optional: true },
  { from: 'epicTranscriptTurn', to: 'epic', cardinality: 'N-1', label: 'belongs to' },
  { from: 'epicTranscriptTurn', to: 'epicEvent', cardinality: 'N-1', label: 'labeled by', optional: true },
  { from: 'epicArchive', to: 'epic', cardinality: '1-1', label: 'freezes' },
  { from: 'prd', to: 'epic', cardinality: 'N-1', label: 'joins (directory fact)' },
  { from: 'prd', to: 'epic', cardinality: 'N-1', via: 'sourcePromptId', label: 'authored from (frontmatter intent)', optional: true },
  { from: 'prd', to: 'project', cardinality: 'N-1', label: 'belongs to' },
  { from: 'prd', to: 'tag', cardinality: 'N-1', label: 'mission', optional: true },
  { from: 'scheduleJob', to: 'prd', cardinality: '1-1', label: 'executes' },
  { from: 'scheduleJob', to: 'prd', cardinality: 'N-N', via: 'dependsOn', label: 'depends on', optional: true },
  { from: 'scheduleJob', to: 'epic', cardinality: 'N-1', label: 'belongs to', optional: true },
  { from: 'scheduleJob', to: 'runLog', cardinality: 'N-1', label: 'ran as', optional: true },
  { from: 'scheduleJob', to: 'scheduleJob', cardinality: 'N-N', via: 'dependsOn', label: 'depends on (self)', optional: true },
  { from: 'scheduleJobStatusHistory', to: 'scheduleJob', cardinality: 'N-1', label: 'transitions of' },
  { from: 'scheduleHistoryEntry', to: 'prd', cardinality: 'N-1', label: 'archives' },
  { from: 'scheduleHistoryEntry', to: 'epic', cardinality: 'N-1', label: 'belongs to', optional: true },
  { from: 'scheduleHistoryEntry', to: 'runLog', cardinality: 'N-1', label: 'ran as', optional: true },
  { from: 'scheduleConfig', to: 'project', cardinality: '1-1', label: 'configures' },
  { from: 'agentPersona', to: 'tag', cardinality: 'N-N', label: 'tagged with' },
  { from: 'agentPersona', to: 'project', cardinality: 'N-N', label: 'action button in' },
  { from: 'memoryEntry', to: 'project', cardinality: 'N-1', label: 'workspace' },
  { from: 'memoryCluster', to: 'memoryEntry', cardinality: '1-N', label: 'clusters' },
  { from: 'agentMemoryEntry', to: 'agentPersona', cardinality: 'N-1', label: 'belongs to' },
  { from: 'transcriptEvent', to: 'tab', cardinality: 'N-1', label: 'classified for' },
  { from: 'transcriptEvent', to: 'claudeTranscript', cardinality: 'N-1', label: 'classified from' },
  { from: 'claudeTranscript', to: 'project', cardinality: 'N-1', label: 'belongs to' },
  { from: 'historyRollupDay', to: 'project', cardinality: 'N-N', label: 'aggregates' },
  { from: 'billingUsage', to: 'scheduleConfig', cardinality: '1-N', label: 'gates when-available firing' },
  { from: 'projectBrief', to: 'project', cardinality: '1-1', label: 'describes' },
  { from: 'projectBrief', to: 'epic', cardinality: 'N-1', via: 'areas[].epic', label: 'traces to', optional: true },
  { from: 'projectPages', to: 'project', cardinality: '1-1', label: 'generated for' },
  { from: 'bilkoPublishState', to: 'project', cardinality: '1-1', label: 'publishes' },
  { from: 'settingsScope', to: 'project', cardinality: 'N-1', label: 'scoped to', optional: true },
  { from: 'layoutEnvelope', to: 'tab', cardinality: '1-N', label: 'panels for' },
  { from: 'opsNamespace', to: 'epic', cardinality: '1-N', label: 'governs writes' },
  { from: 'opsNamespace', to: 'prd', cardinality: '1-N', label: 'governs writes' },
  { from: 'opsNamespace', to: 'projectBrief', cardinality: '1-N', label: 'governs writes' },
]

export function relationsFor(entityId: string): ErdRelation[] {
  return ERD_RELATIONS.filter((r) => r.from === entityId || r.to === entityId)
}

export function neighborsOf(entityId: string): string[] {
  const ids = new Set<string>()
  for (const r of relationsFor(entityId)) {
    const other = r.from === entityId ? r.to : r.from
    if (other !== entityId) ids.add(other)
  }
  return [...ids]
}

export function cardinalityGlyph(cardinality: ErdCardinality): string {
  switch (cardinality) {
    case '1-1':
      return '1—1'
    case '1-N':
      return '1—N'
    case 'N-1':
      return 'N—1'
    case 'N-N':
      return 'N—N'
  }
}

// ─── Layout ─────────────────────────────────────────────────────────────

export const ERD_BOX_WIDTH = 220
export const ERD_BOX_MAX_ROWS = 7

const HEADER_H = 44
const ROW_H = 16
const BOX_PAD = 10
const COLUMN_GAP = 96
const ROW_GAP = 28
const MARGIN = 24

function boxHeight(fieldCount: number): number {
  const rows = Math.min(fieldCount, ERD_BOX_MAX_ROWS) + (fieldCount > ERD_BOX_MAX_ROWS ? 1 : 0)
  return HEADER_H + rows * ROW_H + BOX_PAD
}

function selfLoopPath(box: ErdBox): { d: string; mx: number; my: number } {
  const startX = box.x + box.w
  const startY = box.y + box.h * 0.35
  const endY = box.y + box.h * 0.65
  const loopX = startX + 48
  const d = `M ${startX} ${startY} C ${loopX} ${startY}, ${loopX} ${endY}, ${startX} ${endY}`
  return { d, mx: loopX, my: (startY + endY) / 2 }
}

/**
 * layoutErd — PURE, deterministic. One column per non-empty group (in
 * ERD_GROUPS order), entities stacked in ERD_ENTITIES order within their
 * column. Relations whose endpoints aren't both in `entities` are skipped.
 */
export function layoutErd(entities: ErdEntity[] = ERD_ENTITIES, relations: ErdRelation[] = ERD_RELATIONS): ErdLayout {
  const columns: ErdGroupId[] = ERD_GROUPS.map((g) => g.id).filter((gid) =>
    entities.some((e) => e.group === gid),
  )

  const boxes: ErdBox[] = []
  const boxById = new Map<string, ErdBox>()

  columns.forEach((gid, colIndex) => {
    const x = MARGIN + colIndex * (ERD_BOX_WIDTH + COLUMN_GAP)
    let y = MARGIN
    for (const entity of entities) {
      if (entity.group !== gid) continue
      const h = boxHeight(entity.fields.length)
      const box: ErdBox = { id: entity.id, group: gid, x, y, w: ERD_BOX_WIDTH, h }
      boxes.push(box)
      boxById.set(entity.id, box)
      y += h + ROW_GAP
    }
  })

  const entityIds = new Set(entities.map((e) => e.id))
  const edges: ErdEdge[] = []

  for (const relation of relations) {
    if (!entityIds.has(relation.from) || !entityIds.has(relation.to)) continue
    const fromBox = boxById.get(relation.from)
    const toBox = boxById.get(relation.to)
    if (!fromBox || !toBox) continue

    if (relation.from === relation.to) {
      const loop = selfLoopPath(fromBox)
      edges.push({ relation, ...loop })
      continue
    }

    const fromLeft = fromBox.x < toBox.x
    const sx = fromLeft ? fromBox.x + fromBox.w : fromBox.x
    const sy = fromBox.y + fromBox.h / 2
    const ex = fromLeft ? toBox.x : toBox.x + toBox.w
    const ey = toBox.y + toBox.h / 2
    const bend = Math.max(40, Math.abs(ex - sx) / 2)
    const c1x = sx + (fromLeft ? bend : -bend)
    const c2x = ex + (fromLeft ? -bend : bend)
    const d = `M ${sx} ${sy} C ${c1x} ${sy}, ${c2x} ${ey}, ${ex} ${ey}`
    edges.push({ relation, d, mx: (sx + ex) / 2, my: (sy + ey) / 2 })
  }

  const maxX = boxes.reduce((m, b) => Math.max(m, b.x + b.w), 0)
  const maxY = boxes.reduce((m, b) => Math.max(m, b.y + b.h), 0)

  return {
    boxes,
    edges,
    width: maxX + MARGIN,
    height: maxY + MARGIN,
  }
}
