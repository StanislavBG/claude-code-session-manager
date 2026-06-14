import { useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from '../../state/toast'
import { Toggle } from '../ui/Toggle'
import { Badge } from '../ui/Badge'
import { AlmanacIcon, type AlmanacIconName } from '../layout/AlmanacIcon'
import type { WebRemoteDevice, WebRemoteStatus } from '../../../preload/api'

// ─── Types ────────────────────────────────────────────────────────────────────

type PairingStep = 'idle' | 'enter-otp' | 'pairing'

// ─── Almanac sub-primitives (local to the Remote tab) ──────────────────────────

/** Small uppercase section label with an optional right-aligned slot. */
function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between mb-2.5">
      <span className="text-[11.5px] font-bold uppercase tracking-[0.8px] text-fg-faint">{children}</span>
      {right}
    </div>
  )
}

/** A labelled toggle row used inside the permission card. */
function ToggleRow({
  label, hint, on, onChange, warn, disabled, first,
}: {
  label: string
  hint: string
  on: boolean
  onChange: (v: boolean) => void
  warn?: boolean
  disabled?: boolean
  first?: boolean
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 px-[18px] py-[15px] ${
        first ? '' : 'border-t border-rule'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold text-fg mb-0.5">{label}</div>
        <div className={`text-[12.5px] leading-snug flex items-center gap-1.5 ${warn ? 'text-honey-dark' : 'text-fg-faint'}`}>
          {warn && <span aria-hidden>⚠</span>}{hint}
        </div>
      </div>
      <Toggle checked={on} onChange={disabled ? () => {} : onChange} disabled={disabled} />
    </div>
  )
}

/** Soft / ghost pill button matching the Almanac config kit. */
function PillButton({
  kind = 'soft', icon, children, onClick, disabled,
}: {
  kind?: 'soft' | 'ghost'
  icon?: AlmanacIconName
  children: ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`shrink-0 inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-colors disabled:opacity-50 ${
        kind === 'soft'
          ? 'bg-bg-hi border border-line text-fg hover:bg-bg'
          : 'text-fg-dim hover:text-fg'
      }`}
    >
      {icon && <AlmanacIcon name={icon} size={15} />}
      {children}
    </button>
  )
}

function CountChip({ children }: { children: ReactNode }) {
  return <span className="text-[11.5px] text-fg-faint">{children}</span>
}

// ─── Paired-device row ─────────────────────────────────────────────────────────

function DeviceCard({
  device, online, onRevoke, revoking,
}: {
  device: WebRemoteDevice
  online: boolean
  onRevoke: (id: string) => void
  revoking: boolean
}) {
  const lastSeen = device.lastConnectedAt
    ? new Date(device.lastConnectedAt).toLocaleString()
    : `paired ${new Date(device.issuedAt).toLocaleDateString()}`
  return (
    <div className="flex items-center gap-3.5 bg-bg-hi border border-line rounded-xl px-[18px] py-3.5">
      <span className="w-[34px] h-[34px] rounded-lg bg-bg border border-line grid place-items-center text-fg-dim shrink-0">
        <AlmanacIcon name="remote" size={17} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2.5 mb-0.5">
          <span className="text-sm font-semibold text-fg truncate">{device.deviceName}</span>
          {online && <Badge tone="default" className="!text-sage !border-sage/40">online</Badge>}
        </div>
        <div className="font-mono text-[11.5px] text-fg-faint truncate">
          {device.deviceId} · last seen {lastSeen}
        </div>
      </div>
      <button
        onClick={() => onRevoke(device.deviceId)}
        disabled={revoking}
        className="shrink-0 rounded-lg border border-line bg-bg text-accent px-3.5 py-1.5 text-[12.5px] font-semibold hover:bg-bg-hi disabled:opacity-50 transition-colors"
      >
        Revoke
      </button>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────
// Visual reskin to the Almanac design language (design bundle: variants/remote.jsx).
// The page title/eyebrow/intro is rendered by MainPane's SectionFrame — this
// component must NOT add its own heading. All IPC/pairing/SAS/audit behavior is
// preserved exactly from the prior version.

export function WebRemote() {
  const [status, setStatus] = useState<WebRemoteStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState(false)
  const [togglingControl, setTogglingControl] = useState(false)
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

  const handleControlToggle = async () => {
    if (!status) return
    setTogglingControl(true)
    try {
      if (status.remoteControlEnabled) {
        await window.api.webRemote.disableControl()
      } else {
        await window.api.webRemote.enableControl()
      }
      const updated = await window.api.webRemote.getStatus()
      setStatus(updated)
    } catch (e) {
      toast.error(`Failed: ${(e as Error)?.message || String(e)}`)
    } finally {
      setTogglingControl(false)
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
    return <div className="p-6 text-fg-faint text-sm">Loading…</div>
  }

  const enabled = status?.enabled ?? false
  const remoteControlEnabled = status?.remoteControlEnabled ?? false
  const connected = status?.connected ?? false
  const e2eActive = status?.e2eActive ?? false
  const e2eAuthenticated = status?.e2eAuthenticated ?? false
  const e2eState = status?.e2eState ?? 'idle'
  const pendingSas = status?.pendingSas ?? null
  const devices = status?.devices ?? []

  // "active" = the relay is on AND a device is currently connected.
  const active = enabled && connected
  // The currently-live device (most recently connected) gets the online badge.
  const liveDeviceId = connected
    ? devices.reduce<WebRemoteDevice | null>((best, d) => {
        if (!d.lastConnectedAt) return best
        if (!best || (best.lastConnectedAt ?? '') < d.lastConnectedAt) return d
        return best
      }, null)?.deviceId ?? null
    : null

  const handleConfirmSas = async () => {
    try {
      const result = await window.api.webRemote.confirmSas()
      if (!result?.ok) {
        toast.error(`SAS confirm failed: ${result?.error ?? 'unexpected state — reconnect the mobile app'}`)
      }
    } catch (e) {
      toast.error(`SAS confirm failed: ${(e as Error)?.message || String(e)}`)
    }
  }

  return (
    <div className="max-w-[760px] mx-auto space-y-[22px]">

      {/* SAS verification banner — a new E2E session needs authentication */}
      {pendingSas && (
        <div className="flex items-start gap-3.5 px-5 py-4 rounded-2xl border border-accent/40 bg-accent/[0.06]">
          <span className="w-[38px] h-[38px] rounded-[11px] shrink-0 grid place-items-center bg-bg-hi text-accent">
            <AlmanacIcon name="shield" size={20} />
          </span>
          <div className="flex-1 min-w-0 text-sm text-fg">
            <strong className="font-semibold">Verify E2E session.</strong> Compare this code with the browser — they must match.
            <div className="my-2 text-3xl font-mono tracking-[0.3em] text-center text-accent select-all">{pendingSas}</div>
            <p className="text-[12.5px] text-fg-faint mb-3">
              If the codes match, confirm below. Mutating commands are blocked until confirmed.
            </p>
            <button
              onClick={handleConfirmSas}
              className="rounded-lg bg-accent text-white px-4 py-2 text-[13px] font-semibold hover:opacity-90 transition-opacity"
            >
              Codes match — confirm
            </button>
          </div>
        </div>
      )}

      {/* E2E failed banner */}
      {e2eState === 'failed' && (
        <div className="flex items-center gap-3.5 px-5 py-4 rounded-2xl border border-[#eccdbe] bg-[#f8e8e0]">
          <span className="w-4 h-4 rounded-full bg-accent text-white grid place-items-center text-[11px] font-bold shrink-0">!</span>
          <div className="text-[13px] text-[#9a3f1f]">
            <strong className="font-semibold">E2E key exchange failed.</strong>{' '}
            <span className="text-fg-dim">The session key could not be established. Reconnect the mobile app to retry.</span>
          </div>
        </div>
      )}

      {/* Status banner — one calm banner; color tells the truth */}
      <div className={`flex items-center gap-3.5 px-5 py-4 rounded-2xl border ${active ? 'border-[#e8cdb9] bg-[#f5e9df]' : 'border-line bg-bg-hi'}`}>
        <span className={`w-[38px] h-[38px] rounded-[11px] shrink-0 grid place-items-center ${active ? 'bg-[#f0d9c8] text-accent' : 'bg-[#e4ebd6] text-sage'}`}>
          <AlmanacIcon name={active ? 'wifi' : 'shield'} size={20} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[14.5px] font-semibold text-fg mb-0.5">
            {active ? 'Remote control is active' : enabled ? 'Remote control is idle' : 'Remote control is off'}
          </div>
          <div className="text-[13px] text-fg-dim leading-snug">
            {active
              ? 'A web session can send commands to this machine. Revoke below if unexpected.'
              : enabled
                ? 'The relay is on but no device is connected. Pair a device to begin.'
                : 'The relay connection is closed — no remote commands are accepted. Enable it below only when you need it.'}
          </div>
        </div>
        {e2eActive && e2eAuthenticated
          ? <Badge tone="default" className="!text-sage !border-sage/40">E2E authenticated</Badge>
          : e2eActive
            ? <Badge tone="warn">E2E · awaiting SAS</Badge>
            : <Badge tone="dim">relay only · not E2E yet</Badge>}
      </div>

      {/* Permission toggles */}
      <div>
        <SectionLabel>Remote control</SectionLabel>
        <div className="bg-bg-hi border border-line rounded-2xl overflow-hidden">
          <ToggleRow
            first
            label="Allow remote control from the web"
            hint="Master switch. When off, the relay refuses every connection."
            on={enabled}
            onChange={() => { if (!toggling) handleToggle() }}
          />
          <ToggleRow
            label="Allow command writes (pty + scheduler)"
            hint={remoteControlEnabled
              ? 'A paired device can run shell commands and queue jobs on this machine.'
              : 'Paired devices can watch session output but cannot send commands.'}
            warn={remoteControlEnabled}
            disabled={!enabled || togglingControl}
            on={remoteControlEnabled && enabled}
            onChange={() => { if (enabled && !togglingControl) handleControlToggle() }}
          />
        </div>
      </div>

      {/* Pair a device */}
      <div>
        <SectionLabel>Pair a device</SectionLabel>
        {pairingStep === 'idle' ? (
          <div className="flex items-center justify-between gap-4 bg-bg-hi border border-line rounded-2xl px-5 py-[18px]">
            <div className="text-[13.5px] text-fg-dim leading-relaxed max-w-[420px]">
              Open the <strong className="text-fg font-semibold">web app</strong> on your phone and tap{' '}
              <strong className="text-fg font-semibold">Add Device</strong> to get an 8-character code, then enter it here.
            </div>
            <PillButton kind="soft" icon="link" onClick={() => setPairingStep('enter-otp')}>Pair Device…</PillButton>
          </div>
        ) : (
          <div className="flex items-center gap-5 bg-bg-hi border border-accent/40 rounded-2xl px-6 py-[22px] shadow-[0_0_0_1px_rgba(184,92,52,0.25)]">
            <span className="w-[52px] h-[52px] rounded-xl bg-bg border border-line grid place-items-center text-accent shrink-0">
              <AlmanacIcon name="link" size={24} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[11.5px] font-bold uppercase tracking-[0.8px] text-fg-faint mb-2">Enter the code from your phone</div>
              <input
                ref={otpRef}
                value={otp}
                onChange={(e) => setOtp(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter') handlePair() }}
                maxLength={8}
                placeholder="XXXXXXXX"
                disabled={pairingStep === 'pairing'}
                className="w-full bg-transparent border-0 outline-none font-mono text-[30px] font-semibold tracking-[6px] text-fg placeholder:text-fg-faint/40 disabled:opacity-50"
              />
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <PillButton
                kind="soft"
                onClick={handlePair}
                disabled={pairingStep === 'pairing' || otp.length < 8}
              >
                {pairingStep === 'pairing' ? 'Pairing…' : 'Confirm'}
              </PillButton>
              <PillButton kind="ghost" onClick={() => { setPairingStep('idle'); setOtp('') }} disabled={pairingStep === 'pairing'}>
                cancel
              </PillButton>
            </div>
          </div>
        )}
      </div>

      {/* Paired devices */}
      <div>
        <SectionLabel right={devices.length > 0 ? <CountChip>{devices.length} paired</CountChip> : undefined}>
          Paired devices
        </SectionLabel>
        {devices.length === 0 ? (
          <div className="bg-bg-hi border border-line rounded-xl p-5 text-center text-[13.5px] text-fg-faint italic font-serif">
            No devices paired yet.
          </div>
        ) : (
          <div className="space-y-2">
            {devices.map((d) => (
              <DeviceCard
                key={d.deviceId}
                device={d}
                online={d.deviceId === liveDeviceId}
                onRevoke={handleRevoke}
                revoking={revokingId === d.deviceId}
              />
            ))}
          </div>
        )}
      </div>

      {/* Audit log */}
      <div>
        <SectionLabel right={
          <button onClick={handleAuditToggle} className="text-[12px] text-fg-faint hover:text-fg-dim transition-colors">
            {showAudit ? 'Hide' : 'Show last 100 · 0600, stays on this machine'}
          </button>
        }>
          Audit log
        </SectionLabel>
        {showAudit && (
          <div className="bg-bg-hi border border-line rounded-xl overflow-auto max-h-64 mb-2">
            {auditLines.length === 0 ? (
              <p className="p-4 text-[12.5px] text-fg-faint">No entries today.</p>
            ) : (
              <pre className="p-4 text-[12px] text-fg-dim font-mono whitespace-pre-wrap leading-relaxed">
                {auditLines.join('\n')}
              </pre>
            )}
          </div>
        )}
        <p className="text-[12px] text-fg-faint">
          Full log at{' '}
          <code className="font-mono text-fg-faint">~/.claude/session-manager/logs/remote-audit-YYYY-MM-DD.log</code>
          {' '}(0600, never leaves this machine)
        </p>
      </div>

      {/* Danger zone — panic */}
      <div className="flex items-center justify-between gap-4 bg-[#f8e8e0] border border-[#eccdbe] rounded-2xl px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-4 h-4 rounded-full bg-accent text-white grid place-items-center text-[11px] font-bold shrink-0">!</span>
            <span className="text-sm font-semibold text-[#9a3f1f]">Panic — disconnect &amp; revoke everything</span>
          </div>
          <div className="text-[12.5px] text-fg-dim leading-snug max-w-[440px]">
            Tears down every active session and invalidates all paired-device tokens. Devices must re-pair.
            Use if you suspect compromise.
          </div>
        </div>
        <button
          onClick={handleRevokeAll}
          disabled={revokingAll}
          className="shrink-0 rounded-lg bg-accent text-white px-[18px] py-2 text-[13px] font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {revokingAll ? 'Revoking…' : 'Revoke all'}
        </button>
      </div>
    </div>
  )
}
