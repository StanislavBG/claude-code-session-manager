import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Panel } from '../ui/Panel'
import { ListDetail } from '../ui/ListDetail'
import { MarkdownEditor } from '../ui/MarkdownEditor'
import { SaveBar } from '../ui/SaveBar'
import { EmptyState } from '../ui/EmptyState'
import { ScopeSwitcher } from '../ui/ScopeSwitcher'
import { ProvenanceBadge } from '../ui/ProvenanceBadge'
import { useConfig } from '../../state/config'
import { useActiveTab } from '../../lib/useActiveTab'
import { useHomeDir } from '../../lib/useHomeDir'
import { useLiveTab, type LiveTab } from '../../state/live'
import type { Scope } from '../../lib/scopes'
import { AgentsLibrary } from './Library'
import {
  parseAgentFile,
  serializeAgentFile,
  type AgentFrontmatter,
} from '../../lib/agentFrontmatter'
import { CANONICAL_TOOLS, isCanonicalTool } from '../../data/canonicalTools'
import { toast } from '../../state/toast'

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
  const [mode, setMode] = useState<'configured' | 'live' | 'library'>('configured')
  const [filter, setFilter] = useState('')

  const dir = useMemo(() => (home ? agentsDir(home, cwd, scope) : null), [home, cwd, scope])

  useEffect(() => {
    if (!dir) {
      setAgents([])
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const r = await window.api.config.listDir(dir, { filesOnly: true })
        if (cancelled) return
        const next: AgentDef[] = r.entries
          .filter((e) => e.name.endsWith('.md'))
          .map((e) => ({ scope, name: e.name.replace(/\.md$/, ''), path: e.path }))
          .sort((a, b) => a.name.localeCompare(b.name))
        setAgents(next)
        if (!next.find((a) => a.path === selectedPath)) {
          setSelectedPath(next[0]?.path ?? null)
        }
      } catch (e) {
        console.error('[Subagents] listDir failed:', dir, e)
        if (!cancelled) {
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

  if (!home) return <EmptyState title="loading…" />
  const file = selectedPath ? files[selectedPath] : null
  const selectedAgent = selectedPath ? agents.find((a) => a.path === selectedPath) ?? null : null

  return (
    <Panel
      toolbar={
        <>
          <div className="inline-flex rounded border border-line overflow-hidden">
            {(['configured', 'live', 'library'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-2.5 py-1 text-xs ${
                  mode === m ? 'bg-bg-hi text-fg' : 'bg-bg-elev text-fg-dim hover:text-fg hover:bg-bg-hi'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          {mode === 'configured' && (
            <>
              <div className="ml-2">
                <ScopeSwitcher scopes={['user', 'project']} active={scope} onChange={setScope} />
              </div>
              <span className="ml-3 text-fg-faint">{agents.length} agents</span>
              {selectedAgent && (
                <ProvenanceBadge
                  scope={selectedAgent.scope}
                  input={{ type: 'subagent', name: selectedAgent.name }}
                  className="ml-3"
                />
              )}
            </>
          )}
          <div className="flex-1" />
          {/* This tab only MONITORS sub-agents; the launcher lives in
              Dispatch → Hives. Surface a direct jump so the two aren't
              orphaned from each other. */}
          {onLaunchHive && (
            <button
              onClick={onLaunchHive}
              title="Open Dispatch → Hives to launch a pre-baked swarm"
              className="px-2.5 py-1 text-xs text-accent border border-accent/40 rounded hover:bg-accent/10 transition-colors"
            >
              Launch a hive →
            </button>
          )}
        </>
      }
      footer={
        mode === 'configured' && selectedPath && file ? (
          <SaveBar
            dirty={file.dirty}
            busy={file.busy}
            parseError={saveError}
            lastSavedAt={file.lastSavedAt}
            onSave={async () => {
              setSaveError(null)
              const r = await saveText(selectedPath)
              if (!r.ok) setSaveError(r.error ?? 'save failed')
            }}
            onRevert={() => {
              setSaveError(null)
              revert(selectedPath)
            }}
          />
        ) : null
      }
    >
      {mode === 'library' ? (
        <AgentsLibrary />
      ) : mode === 'configured' ? (
        scope === 'project' && !cwd ? (
          <EmptyState title="no active project" />
        ) : (
          <ListDetail
            sidebar={
              <div className="py-2">
                <div className="px-2 pb-1">
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="filter…"
                    className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
                  />
                </div>
                {agents.length === 0 ? (
                  <div className="px-3 py-1 text-xs text-fg-faint italic">no agents defined</div>
                ) : (
                  agents.filter((a) => !filter || a.name.toLowerCase().includes(filter.toLowerCase())).map((a) => (
                    <button
                      key={a.path}
                      onClick={() => setSelectedPath(a.path)}
                      className={`w-full text-left px-3 py-1 text-xs flex items-center justify-between gap-2 ${
                        selectedPath === a.path
                          ? 'bg-bg-hi text-fg'
                          : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
                      }`}
                    >
                      <span className="truncate">{a.name}</span>
                      <ProvenanceBadge
                        interactive={false}
                        scope={a.scope}
                        input={{ type: 'subagent', name: a.name }}
                      />
                    </button>
                  ))
                )}
              </div>
            }
            detail={
              selectedPath && file ? (
                <AgentEditor
                  path={selectedPath}
                  text={file.draftRaw}
                  onChange={(v) => {
                    setSaveError(null)
                    setDraft(selectedPath, v)
                  }}
                />
              ) : (
                <EmptyState title="select an agent" />
              )
            }
          />
        )
      ) : !activeTab ? (
        <EmptyState title="no active session" hint="open a terminal tab to watch live subagents" />
      ) : (
        <LiveAgentsPanel tabId={activeTab.id} live={live} />
      )}
    </Panel>
  )
}

function LiveAgentsPanel({
  tabId,
  live,
}: {
  tabId: string
  live: LiveTab | undefined
}) {
  if (!live) return <EmptyState title={`waiting for transcript (tab ${tabId.slice(0, 8)})`} />
  if (live.agents.length === 0)
    return <EmptyState title="no subagent spawns observed yet" hint="this updates in real-time" />
  return (
    <div className="p-4 space-y-2 max-w-3xl">
      {live.agents.map((a, i) => (
        <div key={i} className="border border-line rounded p-3 bg-bg-elev">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-fg">
              {a.subagentType ?? 'general-purpose'}
            </span>
            <span className="text-xs text-fg-faint">
              {new Date(a.at).toLocaleTimeString()}
            </span>
          </div>
          {a.description && (
            <div className="text-xs text-fg-dim">{a.description}</div>
          )}
        </div>
      ))}
    </div>
  )
}

function AgentEditor({
  path,
  text,
  onChange,
}: {
  path: string
  text: string
  onChange: (next: string) => void
}) {
  // Round-trip invariant: parse → render → serialize must produce a byte-identical
  // file when the user makes no edits. Unrecognized frontmatter keys are
  // preserved verbatim by `agentFrontmatter`'s extras band.
  const { frontmatter, body } = useMemo(() => parseAgentFile(text), [text])

  const update = (next: AgentFrontmatter) => {
    onChange(serializeAgentFile(next, body))
  }
  const updateBody = (nextBody: string) => {
    onChange(serializeAgentFile(frontmatter, nextBody))
  }
  const set = <K extends keyof AgentFrontmatter>(key: K, value: AgentFrontmatter[K] | undefined) => {
    const next = { ...frontmatter }
    if (value === undefined || value === '') delete next[key]
    else next[key] = value
    update(next)
  }

  const toolsArr = Array.isArray(frontmatter.tools)
    ? frontmatter.tools
    : typeof frontmatter.tools === 'string'
      ? frontmatter.tools.split(',').map((s) => s.trim()).filter(Boolean)
      : []
  const skillsArr = frontmatter.skills ?? []

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-3 border-b border-line space-y-2 overflow-auto max-h-[40%]">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <FmField label="name">
            <input
              value={frontmatter.name ?? ''}
              onChange={(e) => set('name', e.target.value || undefined)}
              className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg font-mono"
              placeholder="lowercase-with-hyphens"
            />
          </FmField>
          <FmField label="model">
            <select
              value={frontmatter.model ?? 'inherit'}
              onChange={(e) => set('model', e.target.value === 'inherit' ? undefined : e.target.value)}
              className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </FmField>
          <FmField label="description" full>
            <input
              value={frontmatter.description ?? ''}
              onChange={(e) => set('description', e.target.value || undefined)}
              className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
              placeholder="when this subagent should be invoked"
            />
          </FmField>
          <FmField label="effort">
            <select
              value={frontmatter.effort ?? ''}
              onChange={(e) => set('effort', (e.target.value || undefined) as AgentFrontmatter['effort'])}
              className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
            >
              {EFFORT_OPTIONS.map((m) => (
                <option key={m} value={m}>{m || '(inherit)'}</option>
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
                <option key={m} value={m}>{m || '(none)'}</option>
              ))}
            </select>
          </FmField>
          <FmField label="tools" full>
            <ToolsPicker
              value={toolsArr}
              onChange={(arr) => set('tools', arr.length ? arr : undefined)}
            />
          </FmField>
          <FmField label="skills" full>
            <SkillsPicker
              value={skillsArr}
              onChange={(arr) => set('skills', arr.length ? arr : undefined)}
            />
          </FmField>
          <FmField label="isolation">
            <select
              value={frontmatter.isolation ?? ''}
              onChange={(e) => set('isolation', (e.target.value || undefined) as AgentFrontmatter['isolation'])}
              className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
            >
              <option value="">(none)</option>
              <option value="worktree">worktree</option>
            </select>
          </FmField>
          <FmField label="memory">
            <select
              value={typeof frontmatter.memory === 'string' ? frontmatter.memory : ''}
              onChange={(e) => set('memory', (e.target.value || undefined) as AgentFrontmatter['memory'])}
              className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
            >
              {MEMORY_OPTIONS.map((m) => (
                <option key={m} value={m}>{m || '(off)'}</option>
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
                <option key={m} value={m}>{m || '(default)'}</option>
              ))}
            </select>
          </FmField>
          <FmField label="maxTurns">
            <input
              type="number"
              value={frontmatter.maxTurns ?? ''}
              onChange={(e) => set('maxTurns', e.target.value ? Number(e.target.value) : undefined)}
              className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg font-mono"
              placeholder="(unlimited)"
            />
          </FmField>
          <FmField label="background">
            <label className="flex items-center gap-2 text-xs text-fg">
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
        </div>
        {(frontmatter.mcpServers || frontmatter.hooks) && (
          <div className="text-xs text-fg-faint pt-1">
            {frontmatter.mcpServers ? <span>mcpServers preserved · </span> : null}
            {frontmatter.hooks ? <span>hooks preserved · </span> : null}
            edit raw frontmatter in the body below if needed
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0">
        <MarkdownEditor path={path} value={body} onChange={updateBody} />
      </div>
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
