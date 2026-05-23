import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSessions } from '../../state/sessions'
import { useHomeDir } from '../../lib/useHomeDir'
import { Tooltip } from '../ui/Tooltip'
import { toast } from '../../state/toast'

// Ported from OneWave-AI/ClaudeCodeUnleashed
// (src/renderer/components/common/Toolbelt.tsx). Same UX shape (search +
// 3-tab filter + featured Find-Me-a-Skill action + arrow/Tab keyboard nav)
// adapted to session-manager's Header recipe (h-7 IconButton, bg-bg-elev
// dropdown, lucide-free SVG/emoji glyphs). Loads agents and skills directly
// from `~/.claude/agents/` and `~/.claude/skills/` via the existing
// config.listDir IPC — no new main-process surface.

interface AgentEntry {
  id: string
  description?: string
}

interface SkillEntry {
  id: string
  description?: string
}

type TabKey = 'all' | 'agents' | 'skills'

// Verbatim from Unleashed's Toolbelt.tsx handleFindSkill — DO NOT paraphrase.
const FIND_SKILL_PROMPT = `🔍 **Skill Recommendation Request**

Analyze our current work session and conversation context. Based on what we're working on, recommend the most relevant skills (slash commands) that could help.

**Instructions:**
1. Review our recent conversation and any code/files we've been working with
2. Identify the current task or challenge
3. List up to 5 skills that would be most useful right now
4. For each skill, explain briefly how it would help with our specific current task

Format your response as a numbered list with skill name and use case.`

function extractDescription(text: string): string | undefined {
  // Pull the first `description:` line out of the frontmatter band.
  // Mirrors Subagents.tsx's extractSkillDescription.
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

export function ToolbeltMenu() {
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = useSessions((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null)
  const home = useHomeDir()
  const canSend = !!activeTab && activeTab.status === 'running'

  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<TabKey>('all')
  const [cursor, setCursor] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const loadData = useCallback(async () => {
    if (!home) return
    setLoading(true)
    try {
      // Agents: ~/.claude/agents/*.md (one file per agent, name = filename).
      const agentsRoot = `${home}/.claude/agents`
      const agentList: AgentEntry[] = []
      try {
        const dir = await window.api.config.listDir(agentsRoot, { filesOnly: true })
        for (const e of dir.entries) {
          if (!e.name.endsWith('.md')) continue
          const id = e.name.replace(/\.md$/, '')
          const txt = await window.api.config.readText(e.path)
          agentList.push({ id, description: txt.exists ? extractDescription(txt.text ?? '') : undefined })
        }
      } catch {
        /* agents dir may not exist */
      }

      // Skills: ~/.claude/skills/<id>/SKILL.md, optionally one namespace level deep.
      const skillsRoot = `${home}/.claude/skills`
      const skillList: SkillEntry[] = []
      try {
        const top = await window.api.config.listDir(skillsRoot, { dirsOnly: true })
        for (const e of top.entries) {
          const direct = await window.api.config.readText(`${e.path}/SKILL.md`)
          if (direct.exists) {
            skillList.push({ id: e.name, description: extractDescription(direct.text ?? '') })
            continue
          }
          const nested = await window.api.config.listDir(e.path, { dirsOnly: true })
          for (const ne of nested.entries) {
            const n = await window.api.config.readText(`${ne.path}/SKILL.md`)
            if (n.exists) {
              skillList.push({ id: ne.name, description: extractDescription(n.text ?? '') })
            }
          }
        }
      } catch {
        /* skills dir may not exist */
      }

      agentList.sort((a, b) => a.id.localeCompare(b.id))
      skillList.sort((a, b) => a.id.localeCompare(b.id))
      setAgents(agentList)
      setSkills(skillList)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Toolbelt load failed: ${msg}`)
      setAgents([])
      setSkills([])
    } finally {
      setLoading(false)
    }
  }, [home])

  // (Re)load when opening.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    setTab('all')
    void loadData()
    // Focus the search input shortly after the dropdown mounts.
    const t = window.setTimeout(() => searchRef.current?.focus(), 30)
    return () => window.clearTimeout(t)
  }, [open, loadData])

  // Click-outside + Escape.
  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    const matches = (...fields: (string | undefined)[]) =>
      !q || fields.some((f) => (f ?? '').toLowerCase().includes(q))
    const a = (tab === 'all' || tab === 'agents')
      ? agents.filter((x) => matches(x.id, x.description)).map((x) => ({ kind: 'agent' as const, entry: x }))
      : []
    const s = (tab === 'all' || tab === 'skills')
      ? skills.filter((x) => matches(x.id, x.description)).map((x) => ({ kind: 'skill' as const, entry: x }))
      : []
    return [...a, ...s]
  }, [agents, skills, query, tab])

  useEffect(() => {
    setCursor(0)
  }, [query, tab])

  const totalCount = agents.length + skills.length

  const sendDraft = useCallback((text: string) => {
    if (!activeTabId || !canSend) {
      toast.warn('Open a running session to use Toolbelt items')
      return
    }
    // Draft — no trailing \r. User finishes the sentence and submits.
    window.api.pty.write({ tabId: activeTabId, data: text })
    setOpen(false)
  }, [activeTabId, canSend])

  const pickAgent = useCallback((a: AgentEntry) => {
    sendDraft(`Use the ${a.id} agent to `)
  }, [sendDraft])

  const pickSkill = useCallback((s: SkillEntry) => {
    sendDraft(`/${s.id} `)
  }, [sendDraft])

  const findSkill = useCallback(() => {
    sendDraft(FIND_SKILL_PROMPT)
  }, [sendDraft])

  // Arrow / Tab navigation. Only active while the dropdown is open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor((i) => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        const item = filtered[cursor]
        if (item) {
          e.preventDefault()
          if (item.kind === 'agent') pickAgent(item.entry)
          else pickSkill(item.entry)
        }
      } else if (e.key === 'Tab') {
        e.preventDefault()
        setTab((t) => (t === 'all' ? 'agents' : t === 'agents' ? 'skills' : 'all'))
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, filtered, cursor, pickAgent, pickSkill])

  return (
    <div ref={rootRef} className="relative shrink-0 self-center">
      <Tooltip content="Toolbelt — Agents & Skills">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Toolbelt"
          title="Toolbelt — Agents & Skills"
          className={`relative px-2 self-center h-7 rounded text-sm flex items-center justify-center transition-colors ${
            open ? 'bg-bg-hi text-fg' : 'text-fg-dim hover:text-fg hover:bg-bg-hi/60'
          }`}
          data-testid="toolbelt-trigger"
        >
          <span aria-hidden="true">🛠</span>
          {totalCount > 0 && (
            <span className="ml-1 px-1 rounded bg-bg text-fg-dim text-[8px] font-mono">{totalCount}</span>
          )}
        </button>
      </Tooltip>

      {open && (
        <div
          role="menu"
          aria-label="Toolbelt"
          className="absolute right-0 top-full mt-1 z-50 w-80 bg-bg-elev border border-line rounded shadow-lg text-xs"
          data-testid="toolbelt-menu"
        >
          {/* Search + filter tabs */}
          <div className="p-2 border-b border-line">
            <input
              ref={searchRef}
              type="text"
              placeholder="Search agents and skills…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full px-2 py-1 bg-bg border border-line rounded text-xs text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent"
              data-testid="toolbelt-search"
            />
            <div className="flex gap-1 mt-2">
              {(['all', 'agents', 'skills'] as TabKey[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setTab(k)}
                  className={`flex-1 px-2 py-1 rounded text-[10px] uppercase tracking-wider transition-colors ${
                    tab === k
                      ? 'bg-accent/20 text-accent border border-accent/30'
                      : 'text-fg-dim hover:text-fg hover:bg-bg-hi/60 border border-transparent'
                  }`}
                  data-testid={`toolbelt-tab-${k}`}
                >
                  {k}
                  <span className="ml-1 text-fg-faint">
                    {k === 'all' ? totalCount : k === 'agents' ? agents.length : skills.length}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Find Me a Skill — featured action */}
          <div className="px-2 py-2 border-b border-line">
            <button
              type="button"
              onClick={findSkill}
              disabled={!canSend}
              className="w-full flex items-center gap-2 px-2 py-2 rounded bg-accent/10 hover:bg-accent/20 border border-accent/20 text-fg disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-accent/10"
              data-testid="toolbelt-find-skill"
            >
              <span aria-hidden="true">✨</span>
              <span className="flex-1 text-left">
                <span className="block text-xs font-medium">Find Me a Skill</span>
                <span className="block text-[10px] text-fg-dim">Claude analyzes your work and suggests skills</span>
              </span>
              <span aria-hidden="true" className="text-fg-dim">→</span>
            </button>
          </div>

          {/* List */}
          {loading && (
            <div className="px-3 py-6 text-center text-fg-dim">Loading…</div>
          )}
          {!loading && totalCount === 0 && (
            <div className="px-3 py-6 text-center text-fg-faint">
              No agents or skills found in ~/.claude/agents or ~/.claude/skills.
            </div>
          )}
          {!loading && totalCount > 0 && filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-fg-faint">
              No matches for &ldquo;{query}&rdquo;.
            </div>
          )}
          {!loading && filtered.length > 0 && (
            <ul className="max-h-64 overflow-y-auto py-1" role="none">
              {filtered.map((item, i) => {
                const isAgent = item.kind === 'agent'
                const id = item.entry.id
                const desc = item.entry.description
                const selected = i === cursor
                return (
                  <li key={`${item.kind}-${id}`}>
                    <button
                      role="menuitem"
                      type="button"
                      disabled={!canSend}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => (isAgent ? pickAgent(item.entry) : pickSkill(item.entry))}
                      className={`w-full text-left px-3 py-1.5 flex items-start gap-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                        selected ? 'bg-bg-hi text-fg' : 'text-fg-dim hover:bg-bg-hi hover:text-fg'
                      }`}
                      data-testid={`toolbelt-item-${item.kind}-${id}`}
                    >
                      <span aria-hidden="true" className="mt-0.5">{isAgent ? '🤖' : '⚡'}</span>
                      <span className="flex-1 min-w-0">
                        <span className="flex items-center gap-1.5">
                          <span className="font-mono text-xs truncate">{isAgent ? id : `/${id}`}</span>
                          <span className="text-[9px] uppercase tracking-wider text-fg-faint">
                            {isAgent ? 'agent' : 'skill'}
                          </span>
                        </span>
                        {desc && <span className="block text-[10px] text-fg-faint truncate">{desc}</span>}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {/* Footer hints */}
          <div className="px-3 py-1.5 border-t border-line text-[10px] text-fg-faint flex items-center justify-between">
            {!canSend ? (
              <span>Open a running session to use Toolbelt items.</span>
            ) : (
              <>
                <span>
                  <kbd className="px-1 rounded bg-bg text-fg-dim font-mono">↑↓</kbd> nav{' '}
                  <kbd className="px-1 rounded bg-bg text-fg-dim font-mono">↵</kbd> draft
                </span>
                <span>
                  <kbd className="px-1 rounded bg-bg text-fg-dim font-mono">Tab</kbd> filter
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
