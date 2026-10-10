import { useCallback, useEffect, useState } from 'react'
import { useToast } from '../../state/toast'
import { Badge } from '../ui/Badge'
import { SectionLabel, PillButton, RemoteCard, RevokeButton, SasBanner, EmptyState } from './remoteUi'
import { RemoteTerminalPanel } from './RemoteTerminalPanel'
import { RemoteSessionsPanel } from './RemoteSessionsPanel'
import type { RemoteMachinePeer, RemoteClientStatus } from '../../../preload/api'

const UNAVAILABLE = 'relay_client_auth_unavailable'
const errMsg = (e: unknown) => (e as Error)?.message || String(e)

type OpenPanel = { peerId: string; kind: 'terminal' | 'sessions' } | null

function MachineCard({
  peer, panel, onConnect, onRevoke, onTogglePanel, onConfirmSas,
}: {
  peer: RemoteMachinePeer
  panel: OpenPanel
  onConnect: (id: string) => void
  onRevoke: (id: string) => void
  onTogglePanel: (id: string, kind: 'terminal' | 'sessions') => void
  onConfirmSas: (id: string) => void
}) {
  const online = peer.status === 'authenticated'
  const unavailable = peer.status === 'failed' && peer.reason === UNAVAILABLE
  const connecting = peer.status === 'connecting'
  const lastSeen = new Date(peer.pairedAt).toLocaleString()
  const open = panel?.peerId === peer.peerId ? panel.kind : null
  return (
    <div className="space-y-2" data-testid="remote-machine-row">
      <RemoteCard
        testId="remote-machine"
        icon="terminal"
        title={peer.machineName}
        badge={online ? <Badge tone="default" className="!text-sage !border-sage/40">online</Badge> : undefined}
        subtitle={`${peer.peerId} · last seen ${lastSeen}`}
        action={
          <div className="flex items-center gap-2 shrink-0">
            {online ? (
              <>
                <PillButton testId="remote-machine-terminal" icon="terminal" onClick={() => onTogglePanel(peer.peerId, 'terminal')}>
                  Open terminal
                </PillButton>
                <PillButton testId="remote-machine-sessions" onClick={() => onTogglePanel(peer.peerId, 'sessions')}>
                  Sessions
                </PillButton>
              </>
            ) : !unavailable && peer.status !== 'pending_sas' ? (
              <PillButton testId="remote-machine-connect" disabled={connecting} onClick={() => onConnect(peer.peerId)}>
                {connecting ? 'Connecting…' : 'Connect'}
              </PillButton>
            ) : null}
            <RevokeButton testId="remote-machine-revoke" onClick={() => onRevoke(peer.peerId)}>Revoke</RevokeButton>
          </div>
        }
      />
      {unavailable && (
        <p data-testid="remote-machine-unavailable" className="text-[12.5px] leading-snug text-fg-faint">
          The bilko.run relay does not support desktop clients yet
        </p>
      )}
      {peer.status === 'pending_sas' && peer.sas && (
        <SasBanner
          peer="other machine"
          testId="remote-machine-sas"
          codeTestId="remote-machine-sas-code"
          confirmTestId="remote-machine-sas-confirm"
          code={peer.sas}
          onConfirm={() => onConfirmSas(peer.peerId)}
        />
      )}
      {open === 'terminal' && (
        <RemoteTerminalPanel peerId={peer.peerId} machineName={peer.machineName} cwd="" onClose={() => onTogglePanel(peer.peerId, 'terminal')} />
      )}
      {open === 'sessions' && <RemoteSessionsPanel peerId={peer.peerId} machineName={peer.machineName} />}
    </div>
  )
}

/** Settings → Phone remote: paired remote Session Managers (desktop-to-desktop). */
export function RemoteMachinesSection() {
  const showToast = useToast((s) => s.show)
  const [peers, setPeers] = useState<RemoteMachinePeer[]>([])
  const [panel, setPanel] = useState<OpenPanel>(null)

  const refresh = useCallback(async () => {
    try {
      setPeers(await window.api.remoteClient.list())
    } catch (e) {
      showToast('error', errMsg(e))
    }
  }, [showToast])

  useEffect(() => {
    void refresh()
    const unsub = window.api.remoteClient.onStatus((s: RemoteClientStatus) => {
      setPeers((prev) => prev.map((p) => (p.peerId === s.peerId ? { ...p, status: s.status, reason: s.reason, sas: s.sas } : p)))
    })
    return () => { unsub() }
  }, [refresh])

  const onConnect = useCallback(async (peerId: string) => {
    try {
      const r = await window.api.remoteClient.connect(peerId)
      setPeers((prev) => prev.map((p) => (p.peerId === peerId ? { ...p, status: r.status, reason: r.reason, sas: r.sas } : p)))
    } catch (e) {
      showToast('error', errMsg(e))
    }
  }, [showToast])

  const onConfirmSas = useCallback(async (peerId: string) => {
    try {
      const r = await window.api.remoteClient.confirmSas(peerId)
      if (!r.ok) showToast('error', r.reason ?? 'SAS confirmation failed')
      await refresh()
    } catch (e) {
      showToast('error', errMsg(e))
    }
  }, [showToast, refresh])

  const onRevoke = useCallback(async (peerId: string) => {
    try {
      await window.api.remoteClient.remove(peerId)
      setPanel((cur) => (cur?.peerId === peerId ? null : cur))
      await refresh()
    } catch (e) {
      showToast('error', errMsg(e))
    }
  }, [showToast, refresh])

  const onTogglePanel = useCallback((peerId: string, kind: 'terminal' | 'sessions') => {
    setPanel((cur) => (cur?.peerId === peerId && cur.kind === kind ? null : { peerId, kind }))
  }, [])

  return (
    <div data-testid="remote-machines">
      <SectionLabel right={peers.length > 0 ? <span className="text-[11.5px] text-fg-faint">{peers.length} paired</span> : undefined}>
        Remote machines
      </SectionLabel>
      {peers.length === 0 ? (
        <EmptyState testId="remote-machines-empty">No machines paired yet.</EmptyState>
      ) : (
        <div className="space-y-2">
          {peers.map((p) => (
            <MachineCard
              key={p.peerId}
              peer={p}
              panel={panel}
              onConnect={onConnect}
              onRevoke={onRevoke}
              onTogglePanel={onTogglePanel}
              onConfirmSas={onConfirmSas}
            />
          ))}
        </div>
      )}
    </div>
  )
}
