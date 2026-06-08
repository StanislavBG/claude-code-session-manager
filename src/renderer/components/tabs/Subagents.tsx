import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { MarkdownEditor } from '../ui/MarkdownEditor'
import { EmptyState } from '../ui/EmptyState'
import { ScopeSwitcher } from '../ui/ScopeSwitcher'
import { ProvenanceBadge } from '../ui/ProvenanceBadge'
import { useConfig } from '../../state/config'
import { useActiveTab } from '../../lib/useActiveTab'
import { useHomeDir } from '../../lib/useHomeDir'
import { useLiveTab, type LiveTab, type AgentSpawnEntry } from '../../state/live'
import type { Scope } from '../../lib/scopes'
import {
  parseAgentFile,
  serializeAgentFile,
  type AgentFrontmatter,
} from '../../lib/agentFrontmatter'
import { CANONICAL_TOOLS, isCanonicalTool } from '../../data/canonicalTools'
import { CATALOG_AGENTS, type CatalogAgent } from '../../data/catalog'
import { toast } from '../../state/toast'
import {
  HiveSubTabs,
  LaunchView,
  HiveCell,
  StatusPill,
  ToolChip,
  paletteAt,
} from './subagents/hive-primitives'

const MODEL_OPTIONS = ['inherit', 'opus', 'sonnet', 'haiku'] as const
const EFFORT_OPTIONS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const COLOR_OPTIONS = ['', 'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'] as const
const PERM_MODE_OPTIONS = ['', 'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan'] as const
const MEMORY_OPTIONS = ['', 'user', 'project', 'local'] as const

interface AgentDef {
  scope: Scope
  name: string
  path: string
}

function agentsDir(home: string, cwd: string | null, scope: Scope): string | null {
  if (scope === 'user') return `${home}/.claude/agents`
  if (!cwd) return null
  return `${cwd}/.claude/agents`
}

export function Subagents({ onLaunchHive }: { onLaunchHive?: () => void } = {}) {
  const home = useHomeDir()
  const activeTab = useActiveTab()
  const cwd = activeTab?.cwd ?? null
  const [scope, setScope] = useState<Scope>('user')
  const [agents, setAgents] = useState<AgentDef[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [mode, setMode] = useState<'launch' | 'live' | 'configured' | 'library'>('launch')
  const [filter, setFilter] = useState('')
  const [newAgentOpen, setNewAgentOpen] = useState(false)
  const [newAgentName, setNewAgentName] = useState('')

  const dir = useMemo(() => (home ? agentsDir(home, cwd, scope) : null), [home, cwd, scope])

  const loadAgents = async (d: string, currentSel: string | null, currentScope: Scope) => {
    try {
      const r = await window.api.config.listDir(d, { filesOnly: true })
      const next: AgentDef[] = r.entries
        .filter((e) => e.name.endsWith('.md'))
        .map((e) => ({ scope: currentScope, name: e.name.replace(/\.md$/, ''), path: e.path }))
        .sort((a, b) => a.name.localeCompare(b.name))
      setAgents(next)
      if (!next.find((a) => a.path === currentSel)) {
        setSelectedPath(next[0]?.path ?? null)
      }
      return next
    } catch (e) {
      console.error('[Subagents] listDir failed:', d, e)
      setAgents([])
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`Could not list subagents: ${msg}`)
      return []
    }
  }

  useEffect(() => {
    if (!dir) {
      setAgents([])
      return
    }
    let cancelled = false
    const currentScope = scope
    const currentSel = selectedPath
    ;(async () => {
      try {
        const r = await window.api.config.listDir(dir, { filesOnly: true })
        if (cancelled) return
        const next: AgentDef[] = r.entries
          .filter((e) => e.name.endsWith('.md'))
          .map((e) => ({ scope: currentScope, name: e.name.replace(/\.md$/, ''), path: e.path }))
          .sort((a, b) => a.name.localeCompare(b.name))
        setAgents(next)
        if (!next.find((a) => a.path === currentSel)) {
          setSelectedPath(next[0]?.path ?? null)
        }
      } catch (e) {
        if (!cancelled) {
          console.error('[Subagents] listDir failed:', dir, e)
          setAgents([])
          const msg = e instanceof Error ? e.message : String(e)
          toast.error(`Could not list subagents: ${msg}`)
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir])

  const files = useConfig((s) => s.files)
  const loadText = useConfig((s) => s.loadText)
  const setDraft = useConfig((s) => s.setDraft)
  const saveText = useConfig((s) => s.saveText)
  const revert = useConfig((s) => s.revert)
  const watchFile = useConfig((s) => s.watchFile)
  const unwatchFile = useConfig((s) => s.unwatchFile)

  useEffect(() => {
    if (!selectedPath) return
    if (!files[selectedPath]) loadText(selectedPath)
    watchFile(selectedPath)
    return () => unwatchFile(selectedPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath])

  // Live mode: subscribe to transcripts for active tab. Gating the input to
  // `useLiveTab` preserves the prior behavior of only subscribing when the
  // user is actually looking at the live panel.
  const live = useLiveTab(mode === 'live' ? activeTab : null)

  const [saveError, setSaveError] = useState<string | null>(null)

  const filteredAgents = useMemo(
    () =>
      filter.trim()
        ? agents.filter((a) => a.name.toLowerCase().includes(filter.toLowerCase()))
        : agents,
    [agents, filter],
  )

  if (!home) return <EmptyState title="loading…" />
  const file = selectedPath ? files[selectedPath] : null
  const selectedAgent = selectedPath ? agents.find((a) => a.path === selectedPath) ?? null : null

  const handleNewAgent = async () => {
    if (!dir || !newAgentName.trim()) return
    const slug = newAgentName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    if (!slug) return
    const path = `${dir}/${slug}.md`
    const template = `---\nname: ${slug}\ndescription: \ntools:\n---\n`
    const r = await window.api.config.writeText(path, template)
    if (!r.ok) {
      setSaveError(r.error ?? 'create failed')
      return
    }
    setNewAgentOpen(false)
    setNewAgentName('')
    const next = await loadAgents(dir, path, scope)
    const created = next.find((a) => a.path === path)
    if (created) setSelectedPath(created.path)
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Editorial header + sub-tab bar ── */}
      <div className="shrink-0 px-9 pt-7 pb-5 border-b border-line bg-bg">
        <div className="text-xs font-bold tracking-[0.8px] uppercase text-fg-faint mb-1">
          Workspace · Subagents
        </div>
        <div className="flex items-baseline gap-4 flex-wrap mb-5">
          <h1 className="m-0 font-serif text-4xl font-semibold leading-none tracking-tight text-fg shrink-0">
            The hive
          </h1>
          <p className="m-0 flex-1 text-[14.5px] text-fg-dim leading-relaxed max-w-xl">
            Fire a bundle of focused subagents at a task. Each works in its own context and hands back one digest — your main session never drowns in their output.
          </p>
        </div>
        <HiveSubTabs value={mode} onChange={setMode} />
      </div>

      {/* ── Content area — each sub-view manages its own overflow ── */}
      <div className="flex-1 min-h-0">
        {/* Launch — scrollable, sticky right panel */}
        {mode === 'launch' && (
          <div className="h-full overflow-auto">
            <LaunchView
              onLaunchHive={onLaunchHive}
              onSwitchToLive={() => setMode('live')}
            />
          </div>
        )}

        {/* Library */}
        {mode === 'library' && (
          <div className="h-full overflow-auto">
            <AgentsLibraryHive />
          </div>
        )}

        {/* Configured — two-pane roster + editor */}
        {mode === 'configured' && (
          <div className="h-full flex flex-col">
            {/* Scope toolbar */}
            <div className="shrink-0 px-4 py-2.5 border-b border-line bg-bg flex items-center gap-3">
              <ScopeSwitcher scopes={['user', 'project']} active={scope} onChange={setScope} />
              <span className="text-xs text-fg-faint">
                {agents.length} agent{agents.length !== 1 ? 's' : ''}
              </span>
              {selectedAgent && (
                <ProvenanceBadge
                  scope={selectedAgent.scope}
                  input={{ type: 'subagent', name: selectedAgent.name }}
                  className="ml-auto"
                />
              )}
            </div>

            {scope === 'project' && !cwd ? (
              <EmptyState title="no active project" />
            ) : (
              <div
                className="flex-1 min-h-0 grid"
                style={{ gridTemplateColumns: '240px minmax(0,1fr)' }}
              >
                {/* Roster */}
                <div className="border-r border-line bg-bg-elev flex flex-col">
                  <div className="p-3 border-b border-rule">
                    <input
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="filter agents…"
                      className="w-full bg-bg border border-line rounded-lg px-2.5 py-1.5 text-xs text-fg"
                    />
                  </div>
                  <div className="flex-1 overflow-auto p-1.5">
                    {agents.length === 0 && (
                      <div className="px-3 py-2 text-xs text-fg-faint italic">no agents defined</div>
                    )}
                    {filteredAgents.length === 0 && agents.length > 0 && (
                      <div className="px-3 py-2 text-xs text-fg-faint italic">no matches</div>
                    )}
                    {filteredAgents.map((a) => {
                      const idx = agents.findIndex((ag) => ag.path === a.path)
                      const pal = paletteAt(idx >= 0 ? idx : 0)
                      const active = selectedPath === a.path
                      return (
                        <button
                          key={a.path}
                          onClick={() => setSelectedPath(a.path)}
                          className={`w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-[9px] mb-0.5 text-[13px] font-mono transition-colors ${
                            active
                              ? 'bg-bg-hi ring-1 ring-line font-semibold text-fg shadow-sm'
                              : 'font-medium text-fg-dim hover:text-fg hover:bg-bg-hi'
                          }`}
                        >
                          <span className={`shrink-0 ${pal.text}`}>
                            <HiveCell size={13} />
                          </span>
                          <span className="truncate">{a.name}</span>
                        </button>
                      )
                    })}
                  </div>

                  {/* New agent */}
                  {newAgentOpen ? (
                    <div className="shrink-0 border-t border-rule p-3 flex flex-col gap-2">
                      <input
                        autoFocus
                        value={newAgentName}
                        onChange={(e) => setNewAgentName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleNewAgent()
                          if (e.key === 'Escape') {
                            setNewAgentOpen(false)
                            setNewAgentName('')
                          }
                        }}
                        placeholder="agent-name"
                        className="w-full bg-bg border border-line rounded-lg px-2.5 py-1.5 text-xs font-mono text-fg"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => void handleNewAgent()}
                          className="flex-1 py-1 text-xs font-semibold bg-accent text-white rounded-lg"
                        >
                          Create
                        </button>
                        <button
                          onClick={() => {
                            setNewAgentOpen(false)
                            setNewAgentName('')
                          }}
                          className="flex-1 py-1 text-xs text-fg-dim border border-line rounded-lg"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setNewAgentOpen(true)}
                      className="shrink-0 border-t border-rule px-4 py-2.5 flex items-center gap-2 text-[13px] font-semibold text-accent hover:bg-bg-hi text-left"
                    >
                      <span className="text-base leading-none">+</span> New agent
                    </button>
                  )}
                </div>

                {/* Editor: keyed on path so all local state (deleteConfirm, showAdvanced) resets on agent switch */}
                {selectedPath && file ? (
                  <AgentEditorHive
                    key={selectedPath}
                    path={selectedPath}
                    text={file.draftRaw}
                    paletteIndex={agents.findIndex((a) => a.path === selectedPath)}
                    dirty={file.dirty}
                    busy={file.busy}
                    saveError={saveError}
                    lastSavedAt={file.lastSavedAt}
                    onChange={(v) => {
                      setSaveError(null)
                      setDraft(selectedPath, v)
                    }}
                    onSave={async () => {
                      setSaveError(null)
                      const r = await saveText(selectedPath)
                      if (!r.ok) setSaveError(r.error ?? 'save failed')
                    }}
                    onRevert={() => {
                      setSaveError(null)
                      revert(selectedPath)
                    }}
                    onDelete={async () => {
                      const r = await window.api.files.delete(selectedPath)
                      if (!r.ok) {
                        setSaveError(r.error ?? 'delete failed')
                        return
                      }
                      setSelectedPath(null)
                      if (dir) await loadAgents(dir, null, scope)
                    }}
                  />
                ) : (
                  <EmptyState title="select an agent" />
                )}
              </div>
            )}
          </div>
        )}

        {/* Live */}
        {mode === 'live' && (
          <div className="h-full overflow-auto">
            {!activeTab ? (
              <EmptyState title="no active session" hint="open a terminal tab to watch live subagents" />
            ) : (
              <LiveAgentsPanel tabId={activeTab.id} live={live} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  return `${m}m ${String(rs).padStart(2, '0')}s`
}

function AgentMonitorRow({ agent, now }: { agent: AgentSpawnEntry; now: number }) {
  const isRunning = agent.lastActivityAt === agent.at
  const elapsedMs = isRunning ? now - agent.at : agent.lastActivityAt - agent.at
  const state: 'running' | 'done' = isRunning ? 'running' : 'done'

  return (
    <div
      className={`rounded-xl border p-4 transition-shadow ${
        isRunning
          ? 'border-accent/50 bg-bg-hi ring-1 ring-accent/20'
          : 'border-line bg-bg-hi'
      }`}
    >
      <div className="flex items-center gap-2.5">
        <span className={`shrink-0 ${isRunning ? 'text-accent' : 'text-sage'}`}>
          <HiveCell size={15} />
        </span>
        <span className="font-mono text-[13.5px] font-semibold text-fg truncate">
          {agent.subagentType ?? 'general-purpose'}
        </span>
        <span className="ml-auto shrink-0">
          <StatusPill state={state} />
        </span>
      </div>

      {agent.description && (
        <div className="mt-2 text-[12.5px] text-fg-dim leading-[1.45] ml-6 line-clamp-2">
          {agent.description}
        </div>
      )}

      <div className="flex items-center gap-3 mt-3 font-mono text-[11px] text-fg-faint ml-6">
        <span>
          {isRunning ? 'working… ' : ''}
          {formatElapsed(elapsedMs)}
        </span>
        <span>
          started{' '}
          {new Date(agent.at).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
        </span>
      </div>
    </div>
  )
}

function ResultsDigest({ completedAgents }: { completedAgents: AgentSpawnEntry[] }) {
  return (
    <div className="rounded-2xl border border-line bg-bg-hi overflow-hidden">
      <div className="px-4 py-3.5 border-b border-rule flex items-center gap-2.5">
        <span className="font-serif text-[17px] font-semibold text-fg">Results digest</span>
        {completedAgents.length > 0 && (
          <span className="ml-auto font-mono text-[12px] text-fg-faint">
            {completedAgents.length} so far
          </span>
        )}
      </div>

      {completedAgents.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <div className="text-sm text-fg-dim">Digests appear as agents finish.</div>
          <div className="mt-1 text-xs text-fg-faint leading-relaxed max-w-[220px] mx-auto">
            Agent output reaches your main session as a single summary.
          </div>
        </div>
      ) : (
        <div className="py-1.5">
          {completedAgents.map((a, i) => (
            <div
              key={a.id ?? i}
              className={`px-4 py-3 ${i > 0 ? 'border-t border-rule' : ''}`}
            >
              <div className="font-mono text-[11px] text-fg-faint mb-1">
                {a.subagentType ?? 'general-purpose'}
              </div>
              <div className="text-[13px] text-fg leading-[1.45]">
                Finished in {formatElapsed(a.lastActivityAt - a.at)}.
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="px-4 py-3.5 border-t border-rule bg-bg">
        <div className="text-[12px] text-fg-dim leading-[1.5]">
          Intermediate output stays in each agent&apos;s context — only the summary reaches your main session.
        </div>
      </div>
    </div>
  )
}

function LiveAgentsPanel({
  tabId,
  live,
}: {
  tabId: string
  live: LiveTab | undefined
}) {
  const [now, setNow] = useState(() => Date.now())

  const agents = live?.agents ?? []
  const runningCount = agents.filter((a) => a.lastActivityAt === a.at).length

  useEffect(() => {
    if (runningCount === 0) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [runningCount])

  if (!live) return <EmptyState title={`waiting for transcript (tab ${tabId.slice(0, 8)})`} />
  if (live.agents.length === 0)
    return <EmptyState title="no subagent spawns observed yet" hint="this updates in real-time" />

  const doneCount = agents.filter((a) => a.lastActivityAt > a.at).length
  const completedAgents = agents.filter((a) => a.lastActivityAt > a.at)

  return (
    <div className="h-full overflow-auto">
      <div className="grid xl:grid-cols-[minmax(0,1fr)_340px] gap-6 p-6 xl:p-9 items-start">
        {/* Agent monitor rows */}
        <div>
          {/* Banner */}
          <div className="rounded-xl border border-line bg-bg-hi p-4 mb-4 flex items-center gap-2">
            {runningCount > 0 && (
              <span className="w-2 h-2 rounded-full bg-accent animate-pulse shrink-0" />
            )}
            <span className="font-mono text-[12.5px] text-fg font-semibold">
              {doneCount} done · {runningCount} running
            </span>
          </div>

          <div className="flex flex-col gap-3">
            {agents.map((agent, i) => (
              <AgentMonitorRow key={agent.id ?? i} agent={agent} now={now} />
            ))}
          </div>
        </div>

        {/* Results digest (sticky on xl) */}
        <div className="xl:sticky xl:top-6">
          <ResultsDigest completedAgents={completedAgents} />
        </div>
      </div>
    </div>
  )
}

// Tool names shown as toggle chips in the editor (design's canonical list).
const DISPLAY_TOOLS = [
  'Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task',
]
const WRITE_TOOLS = new Set(['Write', 'Edit', 'Bash'])

function AgentEditorHive({
  path,
  text,
  paletteIndex,
  dirty,
  busy,
  saveError,
  lastSavedAt,
  onChange,
  onSave,
  onRevert,
  onDelete,
}: {
  path: string
  text: string
  paletteIndex: number
  dirty: boolean
  busy: boolean
  saveError: string | null
  lastSavedAt: number | null
  onChange: (next: string) => void
  onSave: () => Promise<void>
  onRevert: () => void
  onDelete: () => Promise<void>
}) {
  const { frontmatter, body } = useMemo(() => parseAgentFile(text), [text])
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [customToolDraft, setCustomToolDraft] = useState('')

  const update = (next: AgentFrontmatter) => onChange(serializeAgentFile(next, body))
  const updateBody = (nextBody: string) => onChange(serializeAgentFile(frontmatter, nextBody))
  const set = <K extends keyof AgentFrontmatter>(key: K, value: AgentFrontmatter[K] | undefined) => {
    const next = { ...frontmatter }
    if (value === undefined || value === '') delete next[key]
    else next[key] = value
    update(next)
  }

  const toolsArr: string[] = Array.isArray(frontmatter.tools)
    ? frontmatter.tools
    : typeof frontmatter.tools === 'string'
      ? frontmatter.tools.split(',').map((s) => s.trim()).filter(Boolean)
      : []
  const skillsArr = frontmatter.skills ?? []
  const extraTools = toolsArr.filter((t) => !DISPLAY_TOOLS.includes(t))

  const toggleTool = (t: string) => {
    const next = toolsArr.includes(t)
      ? toolsArr.filter((x) => x !== t)
      : [...toolsArr, t]
    set('tools', next.length ? (next as AgentFrontmatter['tools']) : undefined)
  }

  const pal = paletteAt(paletteIndex >= 0 ? paletteIndex : 0)
  const agentName =
    frontmatter.name ??
    path.split('/').pop()?.replace(/\.md$/, '') ??
    'agent'
  const filePath = path.replace(/^\/home\/[^/]+/, '~')

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-1 overflow-auto px-5 py-5 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2.5">
          <span className={pal.text}>
            <HiveCell size={18} />
          </span>
          <span className="font-serif text-2xl font-semibold text-fg leading-none">{agentName}</span>
          <span className="ml-auto font-mono text-[11px] text-fg-faint truncate">{filePath}</span>
        </div>

        {/* Primary fields grid */}
        <div className="grid grid-cols-2 gap-4">
          <HiveFieldRow label="name">
            <input
              value={frontmatter.name ?? ''}
              onChange={(e) => set('name', e.target.value || undefined)}
              className="w-full bg-bg border border-line rounded-[9px] px-3 py-2 text-sm text-fg font-mono"
              placeholder="lowercase-with-hyphens"
            />
          </HiveFieldRow>
          <HiveFieldRow
            label="model"
            hint="Cheaper model for simple agents; opus for hard reasoning."
          >
            <select
              value={frontmatter.model ?? 'inherit'}
              onChange={(e) =>
                set('model', e.target.value === 'inherit' ? undefined : e.target.value)
              }
              className="w-full bg-bg border border-line rounded-[9px] px-3 py-2 text-sm text-fg"
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </HiveFieldRow>
        </div>

        <HiveFieldRow
          label="description"
          hint="Main Claude reads this to decide when to delegate. Be specific about scope."
        >
          <input
            value={frontmatter.description ?? ''}
            onChange={(e) => set('description', e.target.value || undefined)}
            className="w-full bg-bg border border-line rounded-[9px] px-3 py-2 text-sm text-fg"
            placeholder="when this subagent should be invoked"
          />
        </HiveFieldRow>

        <HiveFieldRow
          label="tools"
          hint={
            toolsArr.length === 0
              ? 'Empty = inherit all tools. Click a tool to whitelist it.'
              : 'A whitelist. Tightening this is the easiest way to make an agent safer.'
          }
        >
          <div className="flex flex-wrap gap-1.5 p-2 border border-line rounded-[9px] bg-bg">
            {DISPLAY_TOOLS.map((t) => {
              const on = toolsArr.includes(t)
              const isWrite = WRITE_TOOLS.has(t)
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleTool(t)}
                  className={`inline-flex items-center gap-1 px-2 py-1 text-[12px] font-mono rounded-[7px] transition-colors cursor-pointer ${
                    on
                      ? isWrite
                        ? 'bg-butter/25 text-fg-dim border border-butter/60'
                        : 'bg-sage/15 text-sage border border-sage/50'
                      : 'bg-transparent text-fg-faint border border-line/60 opacity-70 hover:opacity-100'
                  }`}
                >
                  {on ? '✓' : '+'} {t}
                </button>
              )
            })}
          </div>
          {extraTools.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {extraTools.map((t) => {
                const known = isCanonicalTool(t) || t.startsWith('mcp__')
                return (
                  <span
                    key={t}
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-mono rounded border ${
                      known
                        ? 'border-line bg-bg-elev text-fg'
                        : 'border-yellow-600/50 bg-yellow-950/30 text-yellow-300'
                    }`}
                    title={known ? undefined : 'unrecognized — round-trips verbatim'}
                  >
                    {!known && <span aria-hidden="true">⚠</span>}
                    {t}
                    <button
                      onClick={() => toggleTool(t)}
                      className="text-fg-faint hover:text-red-400"
                      aria-label={`remove ${t}`}
                    >
                      ×
                    </button>
                  </span>
                )
              })}
            </div>
          )}
          {/* Custom tool input — for MCP tools and other non-standard names */}
          <div className="flex gap-1.5 mt-1.5">
            <input
              value={customToolDraft}
              onChange={(e) => setCustomToolDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault()
                  const t = customToolDraft.trim()
                  if (t && !toolsArr.includes(t)) {
                    set('tools', [...toolsArr, t] as AgentFrontmatter['tools'])
                  }
                  setCustomToolDraft('')
                }
              }}
              onBlur={() => {
                const t = customToolDraft.trim()
                if (t && !toolsArr.includes(t)) {
                  set('tools', [...toolsArr, t] as AgentFrontmatter['tools'])
                }
                setCustomToolDraft('')
              }}
              placeholder="add custom tool (e.g. mcp__server__tool)…"
              className="flex-1 text-xs font-mono bg-bg border border-line rounded-lg px-2.5 py-1.5 text-fg placeholder:text-fg-faint"
            />
          </div>
        </HiveFieldRow>

        {/* Advanced settings */}
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1.5 text-xs text-fg-faint hover:text-fg-dim mb-2"
          >
            <span>{showAdvanced ? '▾' : '▸'}</span> More settings
          </button>
          {showAdvanced && (
            <div className="border border-line rounded-[9px] bg-bg-elev p-3 space-y-2">
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                <FmField label="effort">
                  <select
                    value={frontmatter.effort ?? ''}
                    onChange={(e) =>
                      set('effort', (e.target.value || undefined) as AgentFrontmatter['effort'])
                    }
                    className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
                  >
                    {EFFORT_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m || '(inherit)'}
                      </option>
                    ))}
                  </select>
                </FmField>
                <FmField label="color">
                  <select
                    value={frontmatter.color ?? ''}
                    onChange={(e) => set('color', e.target.value || undefined)}
                    className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
                  >
                    {COLOR_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m || '(none)'}
                      </option>
                    ))}
                  </select>
                </FmField>
                <FmField label="isolation">
                  <select
                    value={frontmatter.isolation ?? ''}
                    onChange={(e) =>
                      set(
                        'isolation',
                        (e.target.value || undefined) as AgentFrontmatter['isolation'],
                      )
                    }
                    className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
                  >
                    <option value="">(none)</option>
                    <option value="worktree">worktree</option>
                  </select>
                </FmField>
                <FmField label="memory">
                  <select
                    value={typeof frontmatter.memory === 'string' ? frontmatter.memory : ''}
                    onChange={(e) =>
                      set(
                        'memory',
                        (e.target.value || undefined) as AgentFrontmatter['memory'],
                      )
                    }
                    className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
                  >
                    {MEMORY_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m || '(off)'}
                      </option>
                    ))}
                  </select>
                </FmField>
                <FmField label="permissionMode">
                  <select
                    value={frontmatter.permissionMode ?? ''}
                    onChange={(e) =>
                      set(
                        'permissionMode',
                        (e.target.value || undefined) as AgentFrontmatter['permissionMode'],
                      )
                    }
                    className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
                  >
                    {PERM_MODE_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m || '(default)'}
                      </option>
                    ))}
                  </select>
                </FmField>
                <FmField label="maxTurns">
                  <input
                    type="number"
                    value={frontmatter.maxTurns ?? ''}
                    onChange={(e) =>
                      set('maxTurns', e.target.value ? Number(e.target.value) : undefined)
                    }
                    className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg font-mono"
                    placeholder="(unlimited)"
                  />
                </FmField>
                <FmField label="background" full>
                  <label className="flex items-center gap-2 text-xs text-fg cursor-pointer">
                    <input
                      type="checkbox"
                      checked={frontmatter.background === true}
                      onChange={(e) => set('background', e.target.checked || undefined)}
                    />
                    <span className="text-fg-dim">always run as background task</span>
                  </label>
                </FmField>
                <FmField label="initialPrompt" full>
                  <textarea
                    value={frontmatter.initialPrompt ?? ''}
                    onChange={(e) => set('initialPrompt', e.target.value || undefined)}
                    rows={2}
                    className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg font-mono"
                    placeholder="auto-submitted first turn when run as main agent (--agent)"
                  />
                </FmField>
                <FmField label="skills" full>
                  <SkillsPicker
                    value={skillsArr}
                    onChange={(arr) => set('skills', arr.length ? arr : undefined)}
                  />
                </FmField>
              </div>
              {(frontmatter.mcpServers || frontmatter.hooks) && (
                <div className="text-xs text-fg-faint pt-1">
                  {frontmatter.mcpServers ? <span>mcpServers preserved · </span> : null}
                  {frontmatter.hooks ? <span>hooks preserved · </span> : null}
                  edit raw frontmatter in the body below if needed
                </div>
              )}
            </div>
          )}
        </div>

        {/* System prompt */}
        <HiveFieldRow
          label="system prompt"
          hint="The body of the markdown file — what this agent should and shouldn't do."
        >
          <div className="border border-line rounded-[9px] overflow-hidden min-h-[200px]">
            <MarkdownEditor path={path} value={body} onChange={updateBody} />
          </div>
        </HiveFieldRow>
      </div>

      {/* Action bar */}
      <div className="shrink-0 border-t border-line px-5 py-3 flex items-center gap-2.5 bg-bg">
        {saveError ? (
          <span className="text-xs text-red-500 flex-1 min-w-0 truncate">{saveError}</span>
        ) : lastSavedAt && !dirty ? (
          <span className="text-xs text-fg-faint flex-1">
            saved {Math.round((Date.now() - lastSavedAt) / 1000)}s ago
          </span>
        ) : (
          <div className="flex-1" />
        )}
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={busy || !dirty}
          className="px-4 py-2 bg-accent text-white rounded-[9px] text-[13.5px] font-semibold disabled:opacity-50 cursor-pointer disabled:cursor-default"
        >
          {busy ? '…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onRevert}
          disabled={!dirty}
          className="px-4 py-2 bg-transparent border border-line text-fg-dim rounded-[9px] text-[13.5px] font-medium disabled:opacity-50 cursor-pointer disabled:cursor-default"
        >
          Revert
        </button>
        {deleteConfirm ? (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-fg-faint">Delete this agent?</span>
            <button
              type="button"
              onClick={() => void onDelete()}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-red-600 rounded-[7px]"
            >
              Yes, delete
            </button>
            <button
              type="button"
              onClick={() => setDeleteConfirm(false)}
              className="px-3 py-1.5 text-xs text-fg-dim border border-line rounded-[7px]"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setDeleteConfirm(true)}
            className="ml-auto text-[13px] font-medium text-fg-faint hover:text-red-500 cursor-pointer"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  )
}

function HiveFieldRow({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactNode
  hint?: string
}) {
  return (
    <div>
      <div className="text-[12.5px] font-semibold text-fg-dim mb-1.5">{label}</div>
      {children}
      {hint && (
        <div className="text-[11.5px] text-fg-faint mt-1 leading-[1.4]">{hint}</div>
      )}
    </div>
  )
}

function FmField({
  label,
  children,
  full,
}: {
  label: string
  children: ReactNode
  full?: boolean
}) {
  return (
    <div className={full ? 'col-span-2' : ''}>
      <div className="text-xs text-fg-faint mb-0.5">{label}</div>
      {children}
    </div>
  )
}

/* ─────────────────────────── Library card grid (Hive design) ─────────────── */

type LibraryFilter = 'All' | 'Agents'

function AgentsLibraryHive() {
  const home = useHomeDir()
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [libFilter, setLibFilter] = useState<LibraryFilter>('All')
  void libFilter // all catalog entries are agents; All/Agents show the same content

  const refresh = async () => {
    if (!home) return
    try {
      const r = await window.api.config.listDir(`${home}/.claude/agents`, { filesOnly: true })
      const names = new Set<string>()
      for (const e of r.entries) {
        if (e.name.endsWith('.md')) names.add(e.name.replace(/\.md$/, ''))
      }
      setInstalled(names)
    } catch {
      /* agents dir may not exist yet */
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home])

  const items = useMemo(
    () =>
      CATALOG_AGENTS.filter(
        (a) =>
          !query.trim() ||
          a.name.toLowerCase().includes(query.toLowerCase()) ||
          a.description.toLowerCase().includes(query.toLowerCase()),
      ),
    [query],
  )

  const install = async (a: CatalogAgent) => {
    if (!home) return
    setBusy(a.id)
    setError(null)
    const path = `${home}/.claude/agents/${a.id}.md`
    const r = await window.api.config.writeText(path, a.content)
    setBusy(null)
    if (!r.ok) {
      setError(r.error ?? 'write failed')
      return
    }
    setFlash(`installed ${a.id}`)
    setTimeout(() => setFlash(null), 2500)
    void refresh()
  }

  const FILTER_TABS: LibraryFilter[] = ['All', 'Agents']

  return (
    <div className="p-6">
      {/* Search + filter bar */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search the library…"
          className="flex-1 max-w-[360px] bg-bg border border-line rounded-[9px] px-3 py-2 text-sm text-fg"
        />
        <div className="flex gap-1 bg-bg-elev p-0.5 rounded-[9px] ring-1 ring-line">
          {FILTER_TABS.map((f) => {
            const active = libFilter === f
            return (
              <button
                key={f}
                type="button"
                onClick={() => setLibFilter(f)}
                className={`px-3 py-1 rounded-[7px] text-[12.5px] transition-colors ${
                  active
                    ? 'bg-bg-hi ring-1 ring-line font-semibold text-fg shadow-sm'
                    : 'font-medium text-fg-dim hover:text-fg'
                }`}
              >
                {f}
              </button>
            )
          })}
        </div>
      </div>

      {(flash || error) && (
        <div
          className={`mb-4 px-4 py-2.5 rounded-[9px] text-sm ${
            error
              ? 'text-red-500 bg-red-950/10 border border-red-500/20'
              : 'text-accent bg-bg-elev border border-line'
          }`}
        >
          {error ?? flash}
        </div>
      )}

      {/* Card grid */}
      <div
        className="grid gap-3.5"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}
      >
        {items.map((a, i) => {
          const pal = paletteAt(i)
          const on = installed.has(a.id)
          const tools = a.tools
            ? a.tools.split(',').map((t) => t.trim()).filter(Boolean)
            : []
          return (
            <div
              key={a.id}
              className="bg-bg-hi border border-line rounded-[13px] p-4 flex flex-col"
            >
              {/* Card header */}
              <div className="flex items-center gap-2.5 mb-2">
                <span
                  className={`w-[30px] h-[30px] rounded-[8px] border border-line bg-bg flex items-center justify-center shrink-0 ${pal.text}`}
                >
                  <HiveCell size={15} />
                </span>
                <div className="min-w-0">
                  <div className="font-mono text-[13.5px] font-semibold text-fg truncate">
                    {a.name}
                  </div>
                  <div className="text-[11.5px] text-fg-faint">
                    agent · @official
                  </div>
                </div>
                {on && (
                  <span className="ml-auto text-[11px] font-semibold text-sage shrink-0">
                    installed
                  </span>
                )}
              </div>

              {/* Description */}
              <div className="text-[13px] text-fg-dim leading-[1.45] mb-3 flex-1">
                {a.description}
              </div>

              {/* Tool chips */}
              {tools.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-3">
                  {tools.map((t) => (
                    <ToolChip
                      key={t}
                      tone={WRITE_TOOLS.has(t) ? 'write' : 'readonly'}
                    >
                      {t}
                    </ToolChip>
                  ))}
                </div>
              )}

              {/* Install button */}
              <button
                type="button"
                disabled={busy === a.id}
                onClick={() => void install(a)}
                className="w-full flex items-center justify-center gap-2 border border-line bg-bg rounded-[9px] py-2 px-4 text-[13px] font-semibold text-fg hover:bg-bg-elev transition-colors"
              >
                {busy === a.id ? '…' : on ? '↻ Overwrite' : '+ Install'}
              </button>
            </div>
          )
        })}
      </div>

      {items.length === 0 && (
        <div className="text-center py-12 text-fg-faint text-sm">no matches</div>
      )}
    </div>
  )
}

/* -------------------------------------------------- Tools / Skills pickers */

interface InstalledSkill {
  name: string
  description?: string
}

/**
 * Enumerate installed skills under ~/.claude/skills/ (user scope only).
 * Mirrors `Skills.tsx`'s walker: scan one level for SKILL.md, otherwise drop
 * down one namespace level. Returns name + first frontmatter description line
 * (or undefined if not parseable). Used by the SkillsPicker dropdown.
 */
function useInstalledSkills(): InstalledSkill[] {
  const home = useHomeDir()
  const [skills, setSkills] = useState<InstalledSkill[]>([])
  useEffect(() => {
    if (!home) return
    let cancelled = false
    ;(async () => {
      const out: InstalledSkill[] = []
      const root = `${home}/.claude/skills`
      try {
        const top = await window.api.config.listDir(root, { dirsOnly: true })
        for (const e of top.entries) {
          const direct = await window.api.config.readText(`${e.path}/SKILL.md`)
          if (direct.exists) {
            out.push({ name: e.name, description: extractSkillDescription(direct.text ?? '') })
            continue
          }
          // Namespace dir: scan one level deeper.
          const nested = await window.api.config.listDir(e.path, { dirsOnly: true })
          for (const ne of nested.entries) {
            const n = await window.api.config.readText(`${ne.path}/SKILL.md`)
            if (n.exists) {
              out.push({ name: ne.name, description: extractSkillDescription(n.text ?? '') })
            }
          }
        }
      } catch {
        /* skills dir may not exist yet */
      }
      if (!cancelled) {
        out.sort((a, b) => a.name.localeCompare(b.name))
        setSkills(out)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [home])
  return skills
}

function extractSkillDescription(text: string): string | undefined {
  // Pull the first `description:` line out of the frontmatter band. Cheaper
  // than running parseAgentFile for what is just one field and avoids
  // cross-coupling to agent frontmatter quirks.
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return undefined
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^description:\s*(.+?)\s*$/i)
    if (mm) {
      let v = mm[1]
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      return v
    }
  }
  return undefined
}

function ToolsPicker({
  value,
  onChange,
}: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const remove = (name: string) => onChange(value.filter((v) => v !== name))
  const add = (name: string) => {
    const trimmed = name.trim()
    if (!trimmed || value.includes(trimmed)) return
    onChange([...value, trimmed])
  }
  const available = CANONICAL_TOOLS.filter((t) => !value.includes(t))

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1 min-h-[26px] bg-bg border border-line rounded px-1.5 py-1">
        {value.length === 0 && (
          <span className="text-fg-faint text-xs italic pl-1">(empty = inherit all tools)</span>
        )}
        {value.map((t) => {
          const known = isCanonicalTool(t) || t.startsWith('mcp__')
          return (
            <span
              key={t}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-mono rounded border ${
                known
                  ? 'border-line bg-bg-elev text-fg'
                  : 'border-yellow-600/50 bg-yellow-950/30 text-yellow-300'
              }`}
              title={known ? undefined : 'unrecognized — round-trips verbatim but Claude Code may ignore'}
            >
              {!known && <span aria-hidden="true">⚠</span>}
              {t}
              <button
                onClick={() => remove(t)}
                className="text-fg-faint hover:text-red-400"
                aria-label={`remove ${t}`}
              >
                ×
              </button>
            </span>
          )
        })}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              if (draft.trim()) {
                add(draft)
                setDraft('')
              }
            } else if (e.key === 'Backspace' && !draft && value.length > 0) {
              remove(value[value.length - 1])
            }
          }}
          onBlur={() => {
            if (draft.trim()) {
              add(draft)
              setDraft('')
            }
          }}
          placeholder={value.length === 0 ? '' : 'add tool…'}
          className="flex-1 min-w-[6rem] bg-transparent text-xs text-fg outline-none font-mono"
        />
      </div>
      {available.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {available.map((t) => (
            <button
              key={t}
              onClick={() => add(t)}
              className="px-1.5 py-0.5 text-[10px] font-mono rounded border border-line text-fg-faint hover:text-fg hover:bg-bg-hi"
            >
              + {t}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SkillsPicker({
  value,
  onChange,
}: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  const installed = useInstalledSkills()
  const installedByName = useMemo(() => {
    const m = new Map<string, InstalledSkill>()
    for (const s of installed) m.set(s.name, s)
    return m
  }, [installed])
  const [draft, setDraft] = useState('')
  const remove = (name: string) => onChange(value.filter((v) => v !== name))
  const add = (name: string) => {
    const trimmed = name.trim()
    if (!trimmed || value.includes(trimmed)) return
    onChange([...value, trimmed])
  }
  const available = installed.filter((s) => !value.includes(s.name))

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1 min-h-[26px] bg-bg border border-line rounded px-1.5 py-1">
        {value.length === 0 && (
          <span className="text-fg-faint text-xs italic pl-1">(no skills preloaded)</span>
        )}
        {value.map((name) => {
          const meta = installedByName.get(name)
          const known = !!meta
          return (
            <span
              key={name}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-mono rounded border ${
                known
                  ? 'border-line bg-bg-elev text-fg'
                  : 'border-yellow-600/50 bg-yellow-950/30 text-yellow-300'
              }`}
              title={known ? meta?.description : 'not installed under ~/.claude/skills — round-trips verbatim'}
            >
              {!known && <span aria-hidden="true">⚠</span>}
              {name}
              <button
                onClick={() => remove(name)}
                className="text-fg-faint hover:text-red-400"
                aria-label={`remove ${name}`}
              >
                ×
              </button>
            </span>
          )
        })}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              if (draft.trim()) {
                add(draft)
                setDraft('')
              }
            } else if (e.key === 'Backspace' && !draft && value.length > 0) {
              remove(value[value.length - 1])
            }
          }}
          onBlur={() => {
            if (draft.trim()) {
              add(draft)
              setDraft('')
            }
          }}
          placeholder={value.length === 0 ? '' : 'add skill…'}
          className="flex-1 min-w-[6rem] bg-transparent text-xs text-fg outline-none font-mono"
        />
      </div>
      {available.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {available.map((s) => (
            <button
              key={s.name}
              onClick={() => add(s.name)}
              title={s.description}
              className="px-1.5 py-0.5 text-[10px] font-mono rounded border border-line text-fg-faint hover:text-fg hover:bg-bg-hi"
            >
              + {s.name}
            </button>
          ))}
        </div>
      )}
      {installed.length === 0 && (
        <div className="text-[10px] text-fg-faint italic">
          no skills installed under ~/.claude/skills — type a name to add a custom reference
        </div>
      )}
    </div>
  )
}
