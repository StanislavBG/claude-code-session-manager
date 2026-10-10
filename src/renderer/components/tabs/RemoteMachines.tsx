import { useState } from 'react'
import { Badge } from '../ui/Badge'
import { EmptyState, PillButton, RemoteCard, SasBanner, SectionLabel } from '../remote/remoteUi'
import { RemoteSessionsPanel } from '../remote/RemoteSessionsPanel'
import { RemoteTerminalPanel } from '../remote/RemoteTerminalPanel'
import { useRemotePeers } from '../remote/useRemotePeers'
import type { RemoteMachinePeer } from '../../../preload/api'

const UNAVAILABLE = 'relay_client_auth_unavailable'
const DEVICE_OFFLINE = 'device_offline'

type Tab = 'sessions' | 'terminal'

const OS_LABELS: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
const osLabel = (os: string | null | undefined) => (os ? OS_LABELS[os] ?? os : 'OS unknown')

function Switcher({ peers, selectedId, onSelect }: {
  peers: RemoteMachinePeer[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  return (
    <div className="w-[240px] shrink-0 border-r border-line p-3 space-y-2 overflow-y-auto" data-testid="remote-view-switcher">
      <SectionLabel>Machines</SectionLabel>
      {peers.map((p) => {
        const online = p.status === 'authenticated'
        return (
          <button
            key={p.peerId}
            type="button"
            data-testid="remote-view-machine"
            aria-pressed={p.peerId === selectedId}
            onClick={() => onSelect(p.peerId)}
            className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
              p.peerId === selectedId ? 'bg-bg-hi border-accent/40' : 'bg-bg border-line hover:bg-bg-hi'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-fg truncate">{p.machineName}</span>
              {online
                ? <Badge tone="good">online</Badge>
                : <Badge tone="dim">offline</Badge>}
            </div>
            <div className="text-[11.5px] text-fg-faint">{osLabel(p.os)}</div>
          </button>
        )
      })}
    </div>
  )
}

export function RemoteMachines({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { peers, connect, confirmSas } = useRemotePeers()
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('sessions')
  const [terminalCwd, setTerminalCwd] = useState('')

  if (peers.length === 0) {
    return (
      <div className="p-6 space-y-3" data-testid="remote-view">
        <EmptyState testId="remote-view-empty">No machines paired yet. Pair a machine in Settings → Phone remote.</EmptyState>
        <PillButton testId="remote-view-open-settings" onClick={onOpenSettings}>Open Settings</PillButton>
      </div>
    )
  }

  const peer = peers.find((p) => p.peerId === selectedPeerId) ?? peers[0]
  const online = peer.status === 'authenticated'
  const unavailable = peer.status === 'failed' && peer.reason === UNAVAILABLE
  const connecting = peer.status === 'connecting'
  const badge = `Remote: ${peer.machineName}`

  const select = (id: string) => {
    setSelectedPeerId(id)
    setTab('sessions')
    setTerminalCwd('')
  }
  const openTerminal = (cwd: string) => {
    setTerminalCwd(cwd)
    setTab('terminal')
  }

  return (
    <div className="flex h-full min-h-0" data-testid="remote-view">
      <Switcher peers={peers} selectedId={peer.peerId} onSelect={select} />
      <div className="flex-1 min-w-0 flex flex-col p-4 gap-3 overflow-y-auto">
        <div data-testid="remote-view-header" className="flex items-center gap-2.5">
          <Badge tone="accent" className="" title={peer.peerId}>
            <span data-testid="remote-view-header-badge">{badge}</span>
          </Badge>
          <span className="text-[12.5px] text-fg-faint">{osLabel(peer.os)}</span>
        </div>
        {peer.status === 'pending_sas' && peer.sas && (
          <SasBanner
            peer="other machine"
            testId="remote-view-sas"
            code={peer.sas}
            onConfirm={() => { void confirmSas(peer.peerId) }}
          />
        )}
        {!online ? (
          <div className="space-y-2" data-testid="remote-view-offline">
            <EmptyState>
              {unavailable
                ? 'The bilko.run relay does not support desktop clients yet'
                : peer.reason === DEVICE_OFFLINE
                  ? `${peer.machineName} is offline.`
                  : `Not connected to ${peer.machineName}.`}
            </EmptyState>
            {!unavailable && peer.status !== 'pending_sas' && (
              <RemoteCard
                icon="terminal"
                title={peer.machineName}
                subtitle={peer.peerId}
                action={
                  <PillButton testId="remote-view-connect" disabled={connecting} onClick={() => { void connect(peer.peerId) }}>
                    {connecting ? 'Connecting…' : 'Connect'}
                  </PillButton>
                }
              />
            )}
          </div>
        ) : (
          <>
            <div className="flex gap-2 border-b border-line pb-2">
              {(['sessions', 'terminal'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  data-testid={`remote-view-tab-${t}`}
                  onClick={() => setTab(t)}
                  className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] font-semibold ${
                    tab === t ? 'bg-bg-hi text-fg border border-line' : 'text-fg-dim hover:text-fg'
                  }`}
                >
                  {t === 'sessions' ? 'Sessions' : 'Terminal'}
                  <Badge tone="accent">{badge}</Badge>
                </button>
              ))}
            </div>
            {tab === 'sessions' ? (
              <RemoteSessionsPanel key={peer.peerId} peerId={peer.peerId} machineName={peer.machineName} onOpenTerminal={openTerminal} />
            ) : (
              <RemoteTerminalPanel
                key={peer.peerId}
                peerId={peer.peerId}
                machineName={peer.machineName}
                cwd={terminalCwd}
                onClose={() => setTab('sessions')}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
