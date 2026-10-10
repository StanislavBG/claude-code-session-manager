import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge } from '../ui/Badge'
import { useToast } from '../../state/toast'
import { EmptyState, PillButton, RemoteCard, SectionLabel } from './remoteUi'

/** Sessions open on a paired remote Session Manager + a chat prompt box (cmd:sessions:list, falling back to cmd:sessions:load / cmd:chat:send). */

interface RemoteTab {
  sessionId: string
  cwd: string
  label?: string
}

/** Row shape of the remote's buildRemoteSessionList. */
interface RemoteRow {
  kind: 'project' | 'epic'
  tabId: string
  epicId?: string
  cwd: string
  title: string
  project: string
  tag?: string
  agentType?: string
}

type LoadState = 'loading' | 'ready' | 'error'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function baseName(cwd: string): string {
  const parts = cwd.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || cwd
}

export function RemoteSessionsPanel({ peerId, machineName, onOpenTerminal }: {
  peerId: string
  machineName: string
  onOpenTerminal?: (cwd: string) => void
}) {
  const showToast = useToast((s) => s.show)
  const [rows, setRows] = useState<RemoteRow[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [selected, setSelected] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const reqId = useRef(0)

  const load = useCallback(async () => {
    const id = ++reqId.current
    setLoadState('loading')
    try {
      let next: RemoteRow[]
      try {
        const data = (await window.api.remoteClient.send(peerId, 'cmd:sessions:list', {})) as { sessions?: RemoteRow[] } | null
        next = Array.isArray(data?.sessions) ? data!.sessions! : []
      } catch {
        if (id !== reqId.current) return
        const data = (await window.api.remoteClient.send(peerId, 'cmd:sessions:load', {})) as { tabs?: RemoteTab[] } | null
        const tabs = Array.isArray(data?.tabs) ? data!.tabs! : []
        next = tabs.map((t) => ({
          kind: 'project' as const,
          tabId: t.sessionId,
          cwd: t.cwd,
          title: t.label || t.cwd,
          project: t.label || baseName(t.cwd),
        }))
      }
      if (id !== reqId.current) return
      setRows(next)
      setLoadState('ready')
    } catch (e) {
      if (id !== reqId.current) return
      setLoadState('error')
      showToast('error', `Could not load sessions from ${machineName}: ${errMsg(e)}`)
    }
  }, [peerId, machineName, showToast])

  useEffect(() => {
    void load()
    return () => { reqId.current++ }
  }, [load])

  const groups = useMemo(() => {
    const byProject = new Map<string, RemoteRow[]>()
    for (const r of rows) {
      const key = r.project || baseName(r.cwd)
      ;(byProject.get(key) ?? byProject.set(key, []).get(key)!).push(r)
    }
    const kindRank = (r: RemoteRow) => (r.kind === 'project' ? 0 : 1)
    for (const list of byProject.values()) list.sort((a, b) => kindRank(a) - kindRank(b))
    return [...byProject.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [rows])

  const trimmed = prompt.trim()
  const canSend = selected !== null && trimmed.length > 0 && !sending

  const send = useCallback(async () => {
    if (selected === null || prompt.trim().length === 0) return
    setSending(true)
    try {
      await window.api.remoteClient.send(peerId, 'cmd:chat:send', { tabId: selected, prompt })
      setPrompt('')
    } catch (e) {
      showToast('error', `Could not send prompt to ${machineName}: ${errMsg(e)}`)
    } finally {
      setSending(false)
    }
  }, [peerId, machineName, selected, prompt, showToast])

  return (
    <div data-testid="remote-sessions-panel" className="flex flex-col gap-3">
      <SectionLabel
        right={<Badge tone="accent" className="" title={`Sessions on ${machineName}`}><span data-testid="remote-sessions-badge">Remote: {machineName}</span></Badge>}
      >
        Remote sessions
      </SectionLabel>
      <div className="flex justify-end">
        <PillButton icon="history" testId="remote-sessions-refresh" onClick={() => { void load() }} disabled={loadState === 'loading'}>
          Refresh
        </PillButton>
      </div>

      {loadState === 'loading' && <EmptyState testId="remote-sessions-loading">Loading sessions…</EmptyState>}
      {loadState === 'error' && <EmptyState testId="remote-sessions-error">Could not load sessions from {machineName}.</EmptyState>}
      {loadState === 'ready' && rows.length === 0 && (
        <EmptyState testId="remote-sessions-empty">No sessions open on {machineName}.</EmptyState>
      )}
      {loadState === 'ready' && groups.map(([project, list]) => (
        <div key={project} data-testid="remote-sessions-group" className="flex flex-col gap-2">
          {list.map((r) => (
            <RemoteCard
              key={r.tabId}
              testId={`remote-session-${r.tabId}`}
              icon="terminal"
              title={r.title || r.cwd}
              subtitle={r.cwd}
              badge={r.kind === 'epic' && r.tag ? <Badge tone="accent">{r.tag}</Badge> : undefined}
              action={
                <div className="flex items-center gap-2">
                  {r.kind === 'project' && onOpenTerminal && (
                    <PillButton icon="terminal" kind="ghost" testId={`remote-session-terminal-${r.tabId}`} onClick={() => onOpenTerminal(r.cwd)}>
                      Terminal here
                    </PillButton>
                  )}
                  <PillButton
                    kind={selected === r.tabId ? 'soft' : 'ghost'}
                    testId={`remote-session-select-${r.tabId}`}
                    onClick={() => setSelected(r.tabId)}
                  >
                    {selected === r.tabId ? 'Selected' : 'Select'}
                  </PillButton>
                </div>
              }
            />
          ))}
        </div>
      ))}

      {loadState === 'ready' && rows.length > 0 && (
        <div className="flex flex-col gap-2">
          <textarea
            data-testid="remote-sessions-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder={selected ? `Prompt for the selected session on ${machineName}` : 'Select a session first'}
            className="w-full rounded-lg bg-bg-hi border border-line px-3 py-2 text-[13px] text-fg placeholder:text-fg-faint"
          />
          <div className="flex justify-end">
            <PillButton icon="play" testId="remote-sessions-send" onClick={() => { void send() }} disabled={!canSend}>
              Send
            </PillButton>
          </div>
        </div>
      )}
    </div>
  )
}
