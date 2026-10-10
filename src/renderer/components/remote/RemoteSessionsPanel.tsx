import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '../ui/Badge'
import { useToast } from '../../state/toast'
import { EmptyState, PillButton, RemoteCard, SectionLabel } from './remoteUi'

/** Sessions open on a paired remote Session Manager + a chat prompt box (cmd:sessions:load / cmd:chat:send). */

interface RemoteTab {
  sessionId: string
  cwd: string
  label?: string
}

type LoadState = 'loading' | 'ready' | 'error'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function RemoteSessionsPanel({ peerId, machineName }: { peerId: string; machineName: string }) {
  const showToast = useToast((s) => s.show)
  const [tabs, setTabs] = useState<RemoteTab[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [selected, setSelected] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const reqId = useRef(0)

  const load = useCallback(async () => {
    const id = ++reqId.current
    setLoadState('loading')
    try {
      const data = (await window.api.remoteClient.send(peerId, 'cmd:sessions:load', {})) as { tabs?: RemoteTab[] } | null
      if (id !== reqId.current) return
      setTabs(Array.isArray(data?.tabs) ? data!.tabs! : [])
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
      {loadState === 'ready' && tabs.length === 0 && (
        <EmptyState testId="remote-sessions-empty">No sessions open on {machineName}.</EmptyState>
      )}
      {loadState === 'ready' && tabs.map((t) => (
        <RemoteCard
          key={t.sessionId}
          testId={`remote-session-${t.sessionId}`}
          icon="terminal"
          title={t.label || t.cwd}
          subtitle={t.cwd}
          action={
            <PillButton
              kind={selected === t.sessionId ? 'soft' : 'ghost'}
              testId={`remote-session-select-${t.sessionId}`}
              onClick={() => setSelected(t.sessionId)}
            >
              {selected === t.sessionId ? 'Selected' : 'Select'}
            </PillButton>
          }
        />
      ))}

      {loadState === 'ready' && tabs.length > 0 && (
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
