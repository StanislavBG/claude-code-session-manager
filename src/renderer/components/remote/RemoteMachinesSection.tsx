import { useCallback, useEffect, useState } from 'react'
import { useToast } from '../../state/toast'
import { useLayout } from '../../state/layout'
import { Badge } from '../ui/Badge'
import { SectionLabel, PillButton, RemoteCard, RevokeButton, SasBanner, EmptyState } from './remoteUi'
import { useRemotePeers } from './useRemotePeers'
import { useUpdateStatus } from '../../lib/useUpdateStatus'
import type { RemoteMachinePeer, RemoteClientStatus, RemoteClientDevice } from '../../../preload/api'

const UNAVAILABLE = 'relay_client_auth_unavailable'
const errMsg = (e: unknown) => (e as Error)?.message || String(e)

const UNPAIRED_REASONS = ['relay_client_unpaired', 'token_revoked']

const PAIRING_ERROR_COPY: Record<string, string> = {
  invalid_code: "That code didn't match. Check it and try again.",
  code_expired: 'That code expired. Mint a new one on bilko.run → Desktop clients.',
  invalid_code_format: 'Codes are 8 letters or numbers. Check it and try again.',
  rate_limited: 'Too many tries. Wait a minute and try again.',
  relay_client_unpaired: 'This computer is no longer connected to your account. Enter a new code to reconnect.',
}

/** Plain-language copy for a relay pairing error code. */
export function pairingErrorCopy(code: string): string {
  return Object.prototype.hasOwnProperty.call(PAIRING_ERROR_COPY, code)
    ? PAIRING_ERROR_COPY[code]
    : `Pairing failed (${code})`
}

const parseVersion = (v: string): number[] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** True only when both parse as major.minor.patch and `a` is strictly newer than `b`. */
function isNewerVersion(a: string, b: string): boolean {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

function MachineCard({
  peer, onConnect, onRevoke, onConfirmSas,
}: {
  peer: RemoteMachinePeer
  onConnect: (id: string) => void
  onRevoke: (id: string) => void
  onConfirmSas: (id: string) => void
}) {
  const online = peer.status === 'authenticated'
  const [remoteVersion, setRemoteVersion] = useState<string | null>(null)
  const latest = useUpdateStatus()?.latest ?? null

  useEffect(() => {
    if (!online) { setRemoteVersion(null); return }
    let cancelled = false
    // passive display: a failed or non-string result just renders nothing
    window.api.remoteClient.send(peer.peerId, 'cmd:app:version')
      .then((v: unknown) => { if (!cancelled) setRemoteVersion(typeof v === 'string' ? v : null) })
      .catch(() => { if (!cancelled) setRemoteVersion(null) })
    return () => { cancelled = true }
  }, [peer.peerId, online])

  const updateAvailable = remoteVersion != null && latest != null && isNewerVersion(latest, remoteVersion)
  const unavailable = peer.status === 'failed' && peer.reason === UNAVAILABLE
  const connecting = peer.status === 'connecting'
  const lastSeen = new Date(peer.pairedAt).toLocaleString()
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
            {!online && !unavailable && peer.status !== 'pending_sas' && (
              <PillButton testId="remote-machine-connect" disabled={connecting} onClick={() => onConnect(peer.peerId)}>
                {connecting ? 'Connecting…' : 'Connect'}
              </PillButton>
            )}
            <RevokeButton testId="remote-machine-revoke" onClick={() => onRevoke(peer.peerId)}>Revoke</RevokeButton>
          </div>
        }
      />
      {remoteVersion && (
        <p data-testid="remote-machine-version" className="text-[12.5px] leading-snug text-fg-faint">
          v{remoteVersion}
        </p>
      )}
      {updateAvailable && (
        <p data-testid="remote-machine-update-available" className="text-[12.5px] leading-snug text-fg-faint">
          {`Update available on ${peer.machineName} (v${remoteVersion} → v${latest}) — update it on that machine`}
        </p>
      )}
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
    </div>
  )
}

/** Account pairing: enter the phone-minted code, or pick an account device to add. */
function ClientPairing({
  paired, revoked, peers, onAuthChanged, onAdded,
}: {
  paired: boolean
  revoked: boolean
  peers: RemoteMachinePeer[]
  onAuthChanged: () => void
  onAdded: () => void
}) {
  const showToast = useToast((s) => s.show)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [devices, setDevices] = useState<RemoteClientDevice[] | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})

  const onPair = async () => {
    setBusy(true)
    try {
      const r = await window.api.remoteClient.pair(code.trim())
      if (r.ok) {
        setUnavailable(false)
        setCode('')
        onAuthChanged()
      } else if (r.error === UNAVAILABLE) {
        setUnavailable(true)
      } else {
        showToast('error', pairingErrorCopy(r.error ?? 'unknown'))
      }
    } catch (e) {
      showToast('error', errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const onFind = async () => {
    setBusy(true)
    try {
      const r = await window.api.remoteClient.devices()
      if (r.ok) setDevices(r.devices ?? [])
      else if (r.error === UNAVAILABLE) setUnavailable(true)
      else showToast('error', pairingErrorCopy(r.error ?? 'unknown'))
    } catch (e) {
      showToast('error', errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const onAdd = async (deviceId: string) => {
    try {
      await window.api.remoteClient.add(deviceId, names[deviceId] ?? `Machine ${deviceId.slice(0, 8)}`)
      onAdded()
    } catch (e) {
      showToast('error', errMsg(e))
    }
  }

  const onUnpair = async () => {
    try {
      await window.api.remoteClient.unpair()
      setDevices(null)
      onAuthChanged()
    } catch (e) {
      showToast('error', errMsg(e))
    }
  }

  const unavailableCopy = unavailable && (
    <p data-testid="remote-machine-unavailable" className="text-[12.5px] leading-snug text-fg-faint">
      The bilko.run relay does not support desktop clients yet
    </p>
  )

  if (!paired) {
    return (
      <div className="space-y-2 mb-3" data-testid="remote-client-pairing">
        <div className="flex items-center gap-2">
          <input
            data-testid="remote-client-code"
            value={code}
            maxLength={8}
            onChange={(e) => setCode(e.target.value)}
            placeholder="8-character code"
            className="px-2 py-1 text-[13px] rounded border border-line bg-transparent"
          />
          <PillButton testId="remote-client-pair" disabled={busy || code.trim().length === 0} onClick={() => { void onPair() }}>
            Pair
          </PillButton>
        </div>
        <p className="text-[12.5px] leading-snug text-fg-faint">
          Mint a desktop code on your phone: Session Manager remote → Desktop clients.
        </p>
        {revoked && (
          <p data-testid="remote-client-revoked" className="text-[12.5px] leading-snug text-fg-faint">
            This computer was disconnected from your account on bilko.run. Enter a new code to reconnect.
          </p>
        )}
        {unavailableCopy}
      </div>
    )
  }

  const pairedIds = new Set(peers.map((p) => p.deviceId))
  const available = (devices ?? []).filter((d) => !pairedIds.has(d.deviceId))
  return (
    <div className="space-y-2 mb-3" data-testid="remote-client-pairing">
      <div className="flex items-center gap-2">
        <PillButton testId="remote-client-find" disabled={busy} onClick={() => { void onFind() }}>
          Find my devices
        </PillButton>
        <PillButton testId="remote-client-unpair" kind="ghost" onClick={() => { void onUnpair() }}>
          Unpair
        </PillButton>
      </div>
      {unavailableCopy}
      {devices && available.length === 0 && (
        <EmptyState testId="remote-client-devices-empty">No other devices to add.</EmptyState>
      )}
      {available.map((d) => (
        <div key={d.deviceId} data-testid="remote-client-device" className="flex items-center gap-2">
          <span className="text-[12.5px] text-fg-faint shrink-0">{d.email}</span>
          <Badge tone="default" className={d.isOnline ? '!text-sage !border-sage/40' : undefined}>
            {d.isOnline ? 'online' : 'offline'}
          </Badge>
          <input
            data-testid="remote-client-name"
            value={names[d.deviceId] ?? `Machine ${d.deviceId.slice(0, 8)}`}
            onChange={(e) => setNames((n) => ({ ...n, [d.deviceId]: e.target.value }))}
            className="px-2 py-1 text-[13px] rounded border border-line bg-transparent min-w-0"
          />
          <PillButton testId="remote-client-add" onClick={() => { void onAdd(d.deviceId) }}>Add</PillButton>
        </div>
      ))}
    </div>
  )
}

/** Settings → Phone remote: paired remote Session Managers (desktop-to-desktop). */
export function RemoteMachinesSection() {
  const showToast = useToast((s) => s.show)
  const openPanel = useLayout((s) => s.openPanel)
  const [paired, setPaired] = useState(false)
  const [revoked, setRevoked] = useState(false)

  const readAuth = useCallback(async () => {
    try {
      const p = (await window.api.remoteClient.authStatus()).paired
      setPaired(p)
      if (p) setRevoked(false)
    } catch (e) {
      showToast('error', errMsg(e))
    }
  }, [showToast])

  const onStatusEvent = useCallback((s: RemoteClientStatus) => {
    if (s.reason && UNPAIRED_REASONS.includes(s.reason)) {
      if (s.reason === 'token_revoked') setRevoked(true)
      void readAuth()
    }
  }, [readAuth])

  const { peers, refresh, connect: onConnect, confirmSas: onConfirmSas, revoke } = useRemotePeers(onStatusEvent)

  useEffect(() => { void readAuth() }, [readAuth])

  const onRevoke = useCallback((peerId: string) => revoke(peerId), [revoke])

  return (
    <div data-testid="remote-machines">
      <SectionLabel
        right={peers.length > 0 ? (
          <div className="flex items-center gap-2">
            <span className="text-[11.5px] text-fg-faint">{peers.length} paired</span>
            <PillButton testId="remote-machines-open-view" onClick={() => openPanel('remote')}>
              Open Remote view
            </PillButton>
          </div>
        ) : undefined}
      >
        Remote machines
      </SectionLabel>
      <ClientPairing paired={paired} revoked={revoked} peers={peers} onAuthChanged={() => { void readAuth() }} onAdded={() => { void refresh() }} />
      {peers.length === 0 ? (
        <EmptyState testId="remote-machines-empty">No machines paired yet.</EmptyState>
      ) : (
        <div className="space-y-2">
          {peers.map((p) => (
            <MachineCard
              key={p.peerId}
              peer={p}
              onConnect={onConnect}
              onRevoke={onRevoke}
              onConfirmSas={onConfirmSas}
            />
          ))}
        </div>
      )}
    </div>
  )
}
