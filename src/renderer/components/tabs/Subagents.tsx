import { useEffect, useMemo, useState } from 'react'
import { Panel } from '../ui/Panel'
import { ListDetail } from '../ui/ListDetail'
import { MarkdownEditor } from '../ui/MarkdownEditor'
import { SaveBar } from '../ui/SaveBar'
import { EmptyState } from '../ui/EmptyState'
import { ScopeSwitcher } from '../ui/ScopeSwitcher'
import { useConfig } from '../../state/config'
import { useActiveTab } from '../../lib/useActiveTab'
import { useHomeDir } from '../../lib/useHomeDir'
import { useLive } from '../../state/live'
import type { Scope } from '../../lib/scopes'
import { AgentsLibrary } from './Library'

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

export function Subagents() {
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
        if (!cancelled) setAgents([])
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

  // Live mode: subscribe to transcripts for active tab.
  const subscribe = useLive((s) => s.subscribe)
  const unsubscribe = useLive((s) => s.unsubscribe)
  const liveTabs = useLive((s) => s.tabs)
  useEffect(() => {
    if (mode !== 'live' || !activeTab) return
    subscribe(activeTab.id, activeTab.cwd, activeTab.claudeSessionId)
    return () => unsubscribe(activeTab.id)
  }, [mode, activeTab, subscribe, unsubscribe])

  const [saveError, setSaveError] = useState<string | null>(null)

  if (!home) return <EmptyState title="loading…" />
  const file = selectedPath ? files[selectedPath] : null

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
            </>
          )}
          <div className="flex-1" />
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
                      className={`w-full text-left px-3 py-1 text-xs ${
                        selectedPath === a.path
                          ? 'bg-bg-hi text-fg'
                          : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
                      }`}
                    >
                      {a.name}
                    </button>
                  ))
                )}
              </div>
            }
            detail={
              selectedPath && file ? (
                <MarkdownEditor
                  path={selectedPath}
                  value={file.draftRaw}
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
        <LiveAgentsPanel tabId={activeTab.id} live={liveTabs[activeTab.id]} />
      )}
    </Panel>
  )
}

function LiveAgentsPanel({
  tabId,
  live,
}: {
  tabId: string
  live: ReturnType<typeof useLive.getState>['tabs'][string] | undefined
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
