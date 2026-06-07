import { useEffect, useRef, useState } from 'react'
import { toast } from '../../state/toast'
import type { WebRemoteDevice, WebRemoteStatus } from '../../../preload/api'

// ─── Types ────────────────────────────────────────────────────────────────────

type PairingStep = 'idle' | 'enter-otp' | 'pairing'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full mr-2 ${connected ? 'bg-green-400' : 'bg-zinc-500'}`} />
  )
}

function DeviceCard({
  device,
  onRevoke,
  revoking,
}: {
  device: WebRemoteDevice
  onRevoke: (id: string) => void
  revoking: boolean
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2 bg-zinc-800 rounded border border-zinc-700">
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-100 truncate">{device.deviceName}</p>
        <p className="text-xs text-zinc-500 font-mono mt-0.5">{device.deviceId}</p>
        <p className="text-xs text-zinc-500 mt-0.5">
          Paired {new Date(device.issuedAt).toLocaleDateString()}
          {device.lastConnectedAt && (
            <> · Last seen {new Date(device.lastConnectedAt).toLocaleString()}</>
          )}
        </p>
      </div>
      <button
        onClick={() => onRevoke(device.deviceId)}
        disabled={revoking}
        className="ml-4 shrink-0 px-2.5 py-1 text-xs rounded border border-red-700 text-red-400 hover:bg-red-900/30 disabled:opacity-50 transition-colors"
      >
        Revoke
      </button>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function WebRemote() {
  const [status, setStatus] = useState<WebRemoteStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState(false)
  const [pairingStep, setPairingStep] = useState<PairingStep>('idle')
  const [otp, setOtp] = useState('')
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [revokingAll, setRevokingAll] = useState(false)
  const [auditLines, setAuditLines] = useState<string[]>([])
  const [showAudit, setShowAudit] = useState(false)
  const otpRef = useRef<HTMLInputElement>(null)

  // Load initial status and subscribe to push updates
  useEffect(() => {
    let teardown: (() => void) | null = null

    window.api.webRemote.getStatus().then((s) => {
      setStatus(s)
      setLoading(false)
    }).catch((e) => {
      toast.error(`Remote status: ${e?.message || String(e)}`)
      setLoading(false)
    })

    teardown = window.api.webRemote.onStatus((s) => setStatus(s))

    const offRevoked = window.api.webRemote.onTokenRevoked(() => {
      toast.warn('Remote device token was revoked. Re-pair to reconnect.')
      window.api.webRemote.getStatus().then(setStatus).catch(() => {})
    })

    const offRevokedAll = window.api.webRemote.onRevokedAll(({ revokedCount }) => {
      toast.info(`Panic: all ${revokedCount} device(s) revoked and sessions torn down.`)
      window.api.webRemote.getStatus().then(setStatus).catch(() => {})
    })

    return () => {
      teardown?.()
      offRevoked()
      offRevokedAll()
    }
  }, [])

  // Focus OTP input when entering pairing mode
  useEffect(() => {
    if (pairingStep === 'enter-otp') {
      setTimeout(() => otpRef.current?.focus(), 50)
    }
  }, [pairingStep])

  const handleToggle = async () => {
    if (!status) return
    setToggling(true)
    try {
      if (status.enabled) {
        await window.api.webRemote.disable()
      } else {
        await window.api.webRemote.enable()
      }
      const updated = await window.api.webRemote.getStatus()
      setStatus(updated)
    } catch (e) {
      toast.error(`Failed: ${(e as Error)?.message || String(e)}`)
    } finally {
      setToggling(false)
    }
  }

  const handlePair = async () => {
    const code = otp.trim().toUpperCase()
    if (!/^[A-Z0-9]{8}$/.test(code)) {
      toast.warn('OTP must be 8 alphanumeric characters.')
      return
    }
    setPairingStep('pairing')
    try {
      const result = await window.api.webRemote.pair(code)
      if (!result.ok) {
        toast.error(result.error || 'Pairing failed.')
        setPairingStep('enter-otp')
        return
      }
      toast.info('Device paired successfully.')
      setOtp('')
      setPairingStep('idle')
      const updated = await window.api.webRemote.getStatus()
      setStatus(updated)
    } catch (e) {
      toast.error(`Pairing error: ${(e as Error)?.message || String(e)}`)
      setPairingStep('enter-otp')
    }
  }

  const handleRevoke = async (deviceId: string) => {
    setRevokingId(deviceId)
    try {
      const result = await window.api.webRemote.revokeDevice(deviceId)
      if (!result.ok) {
        toast.error(result.error || 'Revoke failed.')
        return
      }
      const updated = await window.api.webRemote.getStatus()
      setStatus(updated)
    } catch (e) {
      toast.error(`Revoke error: ${(e as Error)?.message || String(e)}`)
    } finally {
      setRevokingId(null)
    }
  }

  const handleRevokeAll = async () => {
    setRevokingAll(true)
    try {
      const result = await window.api.webRemote.revokeAll()
      if (!result.ok) {
        toast.error(result.error || 'Panic revoke failed.')
      }
    } catch (e) {
      toast.error(`Panic revoke error: ${(e as Error)?.message || String(e)}`)
    } finally {
      setRevokingAll(false)
    }
  }

  const handleAuditToggle = async () => {
    if (showAudit) {
      setShowAudit(false)
      return
    }
    try {
      const result = await window.api.webRemote.auditTail(100)
      setAuditLines(result.lines ?? [])
      setShowAudit(true)
    } catch (e) {
      toast.error(`Audit log: ${(e as Error)?.message || String(e)}`)
    }
  }

  if (loading) {
    return <div className="p-6 text-zinc-500 text-sm">Loading…</div>
  }

  const enabled = status?.enabled ?? false
  const connected = status?.connected ?? false
  const e2eActive = status?.e2eActive ?? false
  const devices = status?.devices ?? []

  return (
    <div className="space-y-6 max-w-xl">

      {/* Active-session banner — prominent warning when remote control is live */}
      {enabled && connected && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg border border-red-600/70 bg-red-950/40">
          <span className="text-red-400 text-lg leading-none mt-0.5 animate-pulse">●</span>
          <div className="text-sm text-red-200">
            <strong>Remote control is ACTIVE.</strong> A web session can currently send commands to
            this machine. Disable or revoke all devices below if unexpected.
            {e2eActive && (
              <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded bg-green-900/60 text-green-300 border border-green-700/50">
                🔐 E2E encrypted
              </span>
            )}
            {!e2eActive && (
              <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded bg-amber-900/60 text-amber-300 border border-amber-700/50">
                ⚠ Not yet E2E encrypted
              </span>
            )}
          </div>
        </div>
      )}

      {/* Kill switch banner — makes OFF state unmistakable */}
      {!enabled && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg border border-amber-700/60 bg-amber-950/30">
          <span className="text-amber-400 text-lg leading-none mt-0.5">⚠</span>
          <div className="text-sm text-amber-300">
            <strong>Remote control is OFF.</strong> The relay connection is closed and no remote
            commands will be accepted. Enable it below only when you need it.
          </div>
        </div>
      )}

      {/* Enable / disable */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Remote Control
        </h2>
        <div className="flex items-center justify-between px-3 py-3 bg-zinc-800/60 rounded border border-zinc-700">
          <div>
            <p className="text-sm font-medium text-zinc-100">Allow remote control from the web</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              {enabled
                ? connected
                  ? 'Connected to relay · receiving commands'
                  : 'Enabled · connecting to relay…'
                : 'Disabled · no inbound traffic · off by default'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusDot connected={connected && enabled} />
            <button
              onClick={handleToggle}
              disabled={toggling}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none disabled:opacity-50 ${
                enabled ? 'bg-blue-600' : 'bg-zinc-600'
              }`}
              aria-pressed={enabled}
              aria-label="Toggle remote control"
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  enabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        </div>
      </section>

      {/* Pairing */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Pair a Device
        </h2>
        <p className="text-sm text-zinc-400">
          Open the web app and click "Add Device" to get an 8-character code, then enter it here.
        </p>

        {pairingStep === 'idle' && (
          <button
            onClick={() => setPairingStep('enter-otp')}
            className="px-4 py-2 text-sm rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100 transition-colors"
          >
            Pair Device…
          </button>
        )}

        {(pairingStep === 'enter-otp' || pairingStep === 'pairing') && (
          <div className="flex items-center gap-2">
            <input
              ref={otpRef}
              value={otp}
              onChange={(e) => setOtp(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') handlePair() }}
              maxLength={8}
              placeholder="XXXXXXXX"
              disabled={pairingStep === 'pairing'}
              className="w-36 px-3 py-1.5 text-sm font-mono rounded border border-zinc-600 bg-zinc-800 text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500 disabled:opacity-50"
            />
            <button
              onClick={handlePair}
              disabled={pairingStep === 'pairing' || otp.length < 8}
              className="px-3 py-1.5 text-sm rounded bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50 transition-colors"
            >
              {pairingStep === 'pairing' ? 'Pairing…' : 'Confirm'}
            </button>
            <button
              onClick={() => { setPairingStep('idle'); setOtp('') }}
              disabled={pairingStep === 'pairing'}
              className="px-3 py-1.5 text-sm rounded border border-zinc-600 text-zinc-400 hover:text-zinc-200 disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </section>

      {/* Paired devices */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Paired Devices
          {devices.length > 0 && (
            <span className="ml-2 text-zinc-600 normal-case font-normal">
              ({devices.length})
            </span>
          )}
        </h2>

        {devices.length === 0 ? (
          <p className="text-sm text-zinc-500">No devices paired yet.</p>
        ) : (
          <div className="space-y-2">
            {devices.map((d) => (
              <DeviceCard
                key={d.deviceId}
                device={d}
                onRevoke={handleRevoke}
                revoking={revokingId === d.deviceId}
              />
            ))}
          </div>
        )}
      </section>

      {/* Audit log tail */}
      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Audit Log
          </h2>
          <button
            onClick={handleAuditToggle}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {showAudit ? 'Hide' : 'Show last 100 entries'}
          </button>
        </div>

        {showAudit && (
          <div className="rounded border border-zinc-700 bg-zinc-900 overflow-auto max-h-64">
            {auditLines.length === 0 ? (
              <p className="p-3 text-xs text-zinc-500">No entries today.</p>
            ) : (
              <pre className="p-3 text-xs text-zinc-300 font-mono whitespace-pre-wrap leading-relaxed">
                {auditLines.join('\n')}
              </pre>
            )}
          </div>
        )}

        <p className="text-xs text-zinc-600">
          Full log at{' '}
          <code className="text-zinc-500">~/.claude/session-manager/logs/remote-audit-YYYY-MM-DD.log</code>
          {' '}(0600, never leaves this machine)
        </p>
      </section>

      {/* Panic — revoke all devices */}
      <section className="space-y-3 border-t border-zinc-800 pt-6">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-red-500">
          Danger Zone
        </h2>
        <div className="flex items-start justify-between gap-4 px-4 py-3 rounded-lg border border-red-900/60 bg-red-950/20">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-red-300">Panic — disconnect &amp; revoke all devices</p>
            <p className="text-xs text-zinc-500 mt-1">
              Immediately tears down every active session and invalidates all paired-device tokens.
              Devices must re-pair to reconnect. Use if you suspect compromise.
            </p>
          </div>
          <button
            onClick={handleRevokeAll}
            disabled={revokingAll}
            className="shrink-0 px-3 py-1.5 text-sm rounded border border-red-700 text-red-400 hover:bg-red-900/40 disabled:opacity-50 transition-colors"
          >
            {revokingAll ? 'Revoking…' : 'Revoke All'}
          </button>
        </div>
      </section>
    </div>
  )
}
