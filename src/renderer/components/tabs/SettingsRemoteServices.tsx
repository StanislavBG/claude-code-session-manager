import { useCallback, useEffect, useMemo, useState } from 'react'
import { useToast } from '../../state/toast'
import { useSessions } from '../../state/sessions'
import { copyText } from '../../lib/clipboard'
import { SectionLabel, PillButton, RemoteCard, RevokeButton } from '../remote/remoteUi'
import type {
  WebRemoteService,
  WebRemotePendingService,
  WebRemoteRelayOrphan,
  WebRemoteServiceTool,
} from '../../../preload/api'

/** Every tool a paired service may be scoped to (servicePairings.cjs SERVICE_TOOL_NAMES). */
export const SERVICE_TOOLS: WebRemoteServiceTool[] = [
  'feedback_list_projects',
  'feedback_open_session',
  'macro_list',
  'macro_run',
  'epic_get',
  'events_read',
  'project_create',
]

/** Tools that create things outside the home project; never ticked by default. */
const OPT_IN_TOOLS: WebRemoteServiceTool[] = ['project_create']

/** The scope a new pairing starts with: every tool except the opt-in ones. */
export const DEFAULT_SCOPE: WebRemoteServiceTool[] = SERVICE_TOOLS.filter((t) => !OPT_IN_TOOLS.includes(t))

/** Plain-English labels for tools whose name alone does not say what they do. */
const TOOL_LABELS: Partial<Record<WebRemoteServiceTool, string>> = {
  project_create: 'Create projects',
}

/** `<home>/Projects`, the default folder project_create creates into. */
export function defaultProjectRoot(home: string): string {
  const base = home.replace(/[/\\]+$/, '')
  return base ? `${base}/Projects` : ''
}

export const SERVICE_NAME_MAX = 64

/** Relay errors the owner can act on, shown inline; anything else is a toast. */
export const RELAY_ERROR_TEXT: Record<string, string> = {
  relay_unsupported: 'The bilko.run relay does not accept services yet',
  device_token_invalid: 'Re-pair this desktop with the phone first',
  rate_limited: 'Too many codes this hour',
}

const errMsg = (e: unknown) => (e as Error)?.message || String(e)

const shellArg = (s: string) => (/^[A-Za-z0-9._\-/~]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'service'

/** The command the service runs to redeem the one-time code. */
export function servicePairCommand(p: { code: string; deviceId: string; name: string }): string {
  const stateDir = `~/.session-manager-service/${slug(p.name)}`
  return `npx claude-code-session-manager service pair --code ${p.code} --device ${p.deviceId.slice(0, 8)} --name ${shellArg(p.name)} --state-dir ${stateDir}`
}

interface ActiveCode {
  code: string
  pairingId: string
  codeExpiresAt: number
  deviceId: string
  name: string
}

function formatLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const baseName = (p: string) => p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || p

/**
 * 'May start work it opens': the owner's per-service grant. Collapsed to one
 * select (Off by default); a project list only when scoped. Every change saves.
 */
function StartWorkControl({
  service, projects, busy, onSave,
}: {
  service: WebRemoteService
  projects: string[]
  busy: boolean
  onSave: (serviceId: string, targets: string[]) => void
}) {
  const targets = service.startWork?.targets ?? []
  const mode: 'off' | 'all' | 'selected' = targets.length === 0 ? 'off' : targets.includes('*') ? 'all' : 'selected'
  const choices = useMemo(
    () => Array.from(new Set([...projects, ...targets.filter((t) => t !== '*')])),
    [projects, targets],
  )
  const id = `remote-service-start-work-${service.serviceId}`
  return (
    <div className="flex flex-col gap-1 mt-1 px-[18px]">
      <label className="text-[12px] text-fg-dim" htmlFor={id}>May start work it opens</label>
      <select
        id={id}
        data-testid="remote-service-start-work-mode"
        disabled={busy}
        value={mode}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'off') onSave(service.serviceId, [])
          else if (v === 'all') onSave(service.serviceId, ['*'])
          else onSave(service.serviceId, choices.length > 0 ? [choices[0]] : [])
        }}
        className="bg-bg border border-line rounded-lg px-2 py-1 text-[12.5px] text-fg w-fit"
      >
        <option value="off">Off</option>
        <option value="all">All projects</option>
        <option value="selected">Selected projects</option>
      </select>
      {mode === 'selected' && choices.map((p) => (
        <label key={p} title={p} className="flex items-center gap-1.5 text-[11.5px] text-fg-dim">
          <input
            type="checkbox"
            data-testid="remote-service-start-work-project"
            data-cwd={p}
            disabled={busy}
            checked={targets.includes(p)}
            onChange={(e) => onSave(service.serviceId, e.target.checked ? [...targets, p] : targets.filter((x) => x !== p))}
          />
          {baseName(p)}
        </label>
      ))}
      <div data-testid="remote-service-start-work-note" className="text-[11px] text-fg-faint">
        {mode === 'off'
          ? 'Work it opens waits for your approval.'
          : mode === 'all'
            ? 'Work it opens in any project starts without a second approval.'
            : `Work it opens starts without a second approval in ${targets.length} project${targets.length === 1 ? '' : 's'}.`}
      </div>
    </div>
  )
}

function PendingRow({
  pending, onConfirm, onDeny, busy,
}: {
  pending: WebRemotePendingService
  onConfirm: (pairingId: string, sas: string) => void
  onDeny: (pairingId: string) => void
  busy: boolean
}) {
  const [sas, setSas] = useState('')
  return (
    <div data-testid="remote-service-pending" className="bg-bg-hi border border-accent/40 rounded-xl px-[18px] py-3.5">
      <div className="text-sm font-semibold text-fg mb-0.5">Verify {pending.name}</div>
      <div className="text-[12.5px] text-fg-faint mb-2.5">
        Type the 6-digit code the service printed. It must match before the service can call any tool.
      </div>
      <div className="flex items-center gap-2">
        <input
          data-testid="remote-service-sas-input"
          value={sas}
          onChange={(e) => setSas(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          maxLength={6}
          placeholder="000000"
          className="w-[130px] bg-bg border border-line rounded-lg px-3 py-1.5 font-mono text-[18px] tracking-[4px] text-fg"
        />
        <PillButton
          testId="remote-service-sas-confirm"
          onClick={() => onConfirm(pending.pairingId, sas)}
          disabled={busy || sas.length !== 6}
        >
          Confirm
        </PillButton>
        <PillButton testId="remote-service-sas-deny" kind="ghost" onClick={() => onDeny(pending.pairingId)} disabled={busy}>
          Deny
        </PillButton>
      </div>
      {pending.projectRoot && (
        <div data-testid={`remote-service-project-root-${pending.pairingId}`} className="text-[12px] text-fg-faint mt-2">
          New projects go in <span className="font-mono">{pending.projectRoot}</span>
        </div>
      )}
    </div>
  )
}

/**
 * Settings > Web remote > Services. Pair a named service (e.g. Kiln) with a home
 * project and a tool scope over the relay; list and revoke paired services and
 * relay clients no local service owns. Needs only the Web Remote switch and a
 * paired device. `refreshKey` changes whenever the relay client set changes.
 */
export function SettingsRemoteServices({
  enabled, hasDevice, refreshKey,
}: {
  enabled: boolean
  hasDevice: boolean
  refreshKey?: string
}) {
  const showToast = useToast((s) => s.show)
  const tabs = useSessions((s) => s.tabs)
  const projects = useMemo(() => Array.from(new Set(tabs.map((t) => t.cwd))), [tabs])

  const [services, setServices] = useState<WebRemoteService[]>([])
  const [pending, setPending] = useState<WebRemotePendingService[]>([])
  const [orphans, setOrphans] = useState<WebRemoteRelayOrphan[]>([])
  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [homeCwd, setHomeCwd] = useState('')
  const [scope, setScope] = useState<WebRemoteServiceTool[]>(DEFAULT_SCOPE)
  const [projectRoot, setProjectRoot] = useState('')
  const [starting, setStarting] = useState(false)
  const [relayError, setRelayError] = useState<string | null>(null)
  const [active, setActive] = useState<ActiveCode | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)

  const usable = enabled && hasDevice

  const refresh = useCallback(async () => {
    try {
      const r = await window.api.webRemote.servicesList()
      setServices(r.services ?? [])
      setPending(r.pending ?? [])
      setOrphans(r.relayOrphans ?? [])
    } catch (e) {
      showToast('error', `Services: ${errMsg(e)}`)
    }
  }, [showToast])

  useEffect(() => {
    if (!usable) return
    void refresh()
  }, [usable, refresh, refreshKey])

  useEffect(() => {
    if (!homeCwd && projects.length > 0) setHomeCwd(projects[0])
  }, [projects, homeCwd])

  useEffect(() => {
    let cancelled = false
    window.api.app.homeDir()
      .then((home) => { if (!cancelled) setProjectRoot((cur) => cur || defaultProjectRoot(home)) })
      .catch((e) => showToast('error', `Home folder: ${errMsg(e)}`))
    return () => { cancelled = true }
  }, [showToast])

  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])

  const resetForm = () => {
    setFormOpen(false)
    setName('')
    setScope(DEFAULT_SCOPE)
    setRelayError(null)
    setActive(null)
  }

  const toggleTool = (tool: WebRemoteServiceTool) =>
    setScope((prev) => (prev.includes(tool) ? prev.filter((t) => t !== tool) : SERVICE_TOOLS.filter((t) => t === tool || prev.includes(t))))

  const handleStart = async () => {
    const trimmed = name.trim()
    const wantsProjects = scope.includes('project_create')
    const root = projectRoot.trim()
    if (!trimmed || !homeCwd || scope.length === 0 || (wantsProjects && !root)) return
    setStarting(true)
    setRelayError(null)
    try {
      const r = await window.api.webRemote.servicePairStart(
        wantsProjects ? { name: trimmed, homeCwd, scope, projectRoot: root } : { name: trimmed, homeCwd, scope },
      )
      if (!r.ok) {
        const known = RELAY_ERROR_TEXT[r.error]
        if (known) setRelayError(known)
        else showToast('error', `Service pairing: ${r.error}`)
        return
      }
      setActive({ code: r.code, pairingId: r.pairingId, codeExpiresAt: r.codeExpiresAt, deviceId: r.deviceId, name: trimmed })
      await refresh()
    } catch (e) {
      showToast('error', `Service pairing: ${errMsg(e)}`)
    } finally {
      setStarting(false)
    }
  }

  const handleCopy = async () => {
    if (!active) return
    const ok = await copyText(servicePairCommand(active))
    if (ok) showToast('info', 'Pair command copied.')
    else showToast('error', 'Could not copy the pair command.')
  }

  const handleConfirmSas = async (pairingId: string, sas: string) => {
    setBusyId(pairingId)
    try {
      const r = await window.api.webRemote.serviceConfirmSas(pairingId, sas)
      if (!r.ok) {
        showToast('error', r.error === 'sas_mismatch' ? 'The code does not match the service.' : `Confirm failed: ${r.error}`)
        return
      }
      showToast('info', `${r.service.name} paired.`)
      if (active?.pairingId === pairingId) resetForm()
      await refresh()
    } catch (e) {
      showToast('error', `Confirm failed: ${errMsg(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  const handleDeny = async (pairingId: string) => {
    setBusyId(pairingId)
    try {
      const r = await window.api.webRemote.servicePairCancel(pairingId)
      if (!r.ok) {
        showToast('error', `Deny failed: ${r.error}`)
        return
      }
      if (active?.pairingId === pairingId) resetForm()
      await refresh()
    } catch (e) {
      showToast('error', `Deny failed: ${errMsg(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  const handleRevokeService = async (serviceId: string) => {
    setConfirmRevoke(null)
    setBusyId(serviceId)
    try {
      const r = await window.api.webRemote.serviceRevoke(serviceId)
      if (!r.ok) {
        showToast('error', `Revoke failed: ${r.error}`)
        return
      }
      if (!r.relayRevoked) showToast('warn', 'Revoked here; the relay could not be reached — revoke its client below when it shows.')
      await refresh()
    } catch (e) {
      showToast('error', `Revoke failed: ${errMsg(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  const handleSetStartWork = async (serviceId: string, targets: string[]) => {
    setBusyId(serviceId)
    try {
      const r = await window.api.webRemote.serviceSetStartWork(serviceId, targets)
      if (!r.ok) {
        showToast('error', `Could not save the start-work grant: ${r.error}`)
        return
      }
      await refresh()
    } catch (e) {
      showToast('error', `Could not save the start-work grant: ${errMsg(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  const handleRevokeOrphan = async (clientId: string) => {
    setConfirmRevoke(null)
    setBusyId(clientId)
    try {
      const r = await window.api.webRemote.relayClientRevoke(clientId)
      if (!r.ok) {
        showToast('error', `Revoke failed: ${r.error || 'unknown error'}`)
        return
      }
      await refresh()
    } catch (e) {
      showToast('error', `Revoke failed: ${errMsg(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  const revokeAction = (id: string, testId: string, onConfirm: () => void) =>
    confirmRevoke === id ? (
      <div className="flex items-center gap-1.5 shrink-0">
        <RevokeButton testId={`${testId}-confirm`} onClick={onConfirm} disabled={busyId === id}>Confirm revoke</RevokeButton>
        <PillButton kind="ghost" onClick={() => setConfirmRevoke(null)}>cancel</PillButton>
      </div>
    ) : (
      <RevokeButton testId={testId} onClick={() => setConfirmRevoke(id)} disabled={busyId === id} />
    )

  const msLeft = active ? active.codeExpiresAt - now : 0
  const wantsProjects = scope.includes('project_create')
  const canStart = !starting && name.trim().length > 0 && !!homeCwd && scope.length > 0
    && (!wantsProjects || projectRoot.trim().length > 0)

  return (
    <div data-testid="remote-services">
      <SectionLabel>Services</SectionLabel>

      {!usable ? (
        <div data-testid="remote-service-disabled" className="flex items-center justify-between gap-4 bg-bg-hi border border-line rounded-2xl px-5 py-[18px] opacity-70">
          <div className="text-[13.5px] text-fg-dim leading-relaxed max-w-[420px]">
            {!enabled
              ? 'Turn on “Allow remote control from the web” above to pair a service.'
              : 'Pair a device above first — a service pairs through this desktop’s device.'}
          </div>
          <PillButton testId="remote-service-pair" icon="link" onClick={() => {}} disabled>Pair a service…</PillButton>
        </div>
      ) : !formOpen ? (
        <div className="flex items-center justify-between gap-4 bg-bg-hi border border-line rounded-2xl px-5 py-[18px]">
          <div className="text-[13.5px] text-fg-dim leading-relaxed max-w-[420px]">
            Let a named service (such as Kiln) drive work in one home project through a scoped set of tools.
          </div>
          <PillButton testId="remote-service-pair" icon="link" onClick={() => setFormOpen(true)}>Pair a service…</PillButton>
        </div>
      ) : active ? (
        <div data-testid="remote-service-code-panel" className="bg-bg-hi border border-accent/40 rounded-2xl px-6 py-[18px] space-y-2.5">
          <div className="text-[11.5px] font-bold uppercase tracking-[0.8px] text-fg-faint">One-time code for {active.name}</div>
          <div className="flex items-center gap-4">
            <span data-testid="remote-service-code" className="font-mono text-[30px] font-semibold tracking-[6px] text-fg select-all">{active.code}</span>
            <span data-testid="remote-service-countdown" className={`text-[12.5px] ${msLeft > 0 ? 'text-fg-faint' : 'text-accent'}`}>
              {msLeft > 0 ? `expires in ${formatLeft(msLeft)}` : 'Code expired — start again'}
            </span>
          </div>
          <code className="block font-mono text-[11.5px] text-fg-dim break-all">{servicePairCommand(active)}</code>
          <div className="flex items-center gap-2">
            <PillButton testId="remote-service-copy" icon="copy" onClick={handleCopy}>Copy command</PillButton>
            <PillButton kind="ghost" onClick={resetForm}>done</PillButton>
          </div>
          <div className="text-[12px] text-fg-faint">Run it where the service lives. It prints a 6-digit code; type it below to finish.</div>
        </div>
      ) : (
        <div data-testid="remote-service-form" className="bg-bg-hi border border-accent/40 rounded-2xl px-6 py-[18px] space-y-3">
          <label className="block">
            <span className="block text-[12px] font-semibold text-fg-dim mb-1">Name</span>
            <input
              data-testid="remote-service-name"
              value={name}
              maxLength={SERVICE_NAME_MAX}
              onChange={(e) => setName(e.target.value.slice(0, SERVICE_NAME_MAX))}
              placeholder="Kiln"
              className="w-full bg-bg border border-line rounded-lg px-3 py-1.5 text-[13px] text-fg"
            />
          </label>
          <label className="block">
            <span className="block text-[12px] font-semibold text-fg-dim mb-1">Home project</span>
            <select
              data-testid="remote-service-home"
              value={homeCwd}
              onChange={(e) => setHomeCwd(e.target.value)}
              className="w-full bg-bg border border-line rounded-lg px-3 py-1.5 text-[13px] text-fg font-mono"
            >
              {projects.length === 0 && <option value="">Open a project tab first</option>}
              {projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <fieldset>
            <legend className="text-[12px] font-semibold text-fg-dim mb-1">Tools it may call</legend>
            <div className="grid grid-cols-2 gap-1">
              {SERVICE_TOOLS.map((tool) => (
                <label key={tool} className="flex items-center gap-2 text-[12.5px] text-fg font-mono">
                  <input
                    type="checkbox"
                    data-testid={`remote-service-scope-${tool}`}
                    checked={scope.includes(tool)}
                    onChange={() => toggleTool(tool)}
                  />
                  {TOOL_LABELS[tool] ? (
                    <span className="font-sans">{TOOL_LABELS[tool]} <span className="font-mono text-fg-faint">({tool})</span></span>
                  ) : tool}
                </label>
              ))}
            </div>
          </fieldset>
          {wantsProjects && (
            <label className="block">
              <span className="block text-[12px] font-semibold text-fg-dim mb-1">New projects go in</span>
              <input
                data-testid="remote-service-project-root"
                value={projectRoot}
                onChange={(e) => setProjectRoot(e.target.value)}
                placeholder="~/Projects"
                className="w-full bg-bg border border-line rounded-lg px-3 py-1.5 text-[13px] text-fg font-mono"
              />
              <span className="block text-[11.5px] text-fg-faint mt-1">The service can create new folders and private GitHub repos here.</span>
            </label>
          )}
          {relayError && (
            <div data-testid="remote-service-error" className="text-[12.5px] text-accent">{relayError}</div>
          )}
          <div className="flex items-center gap-2">
            <PillButton testId="remote-service-start" onClick={handleStart} disabled={!canStart}>
              {starting ? 'Starting…' : 'Start'}
            </PillButton>
            <PillButton kind="ghost" onClick={resetForm} disabled={starting}>cancel</PillButton>
          </div>
        </div>
      )}

      {usable && pending.length > 0 && (
        <div className="space-y-2 mt-2.5">
          {pending.map((p) => (
            <PendingRow key={p.pairingId} pending={p} onConfirm={handleConfirmSas} onDeny={handleDeny} busy={busyId === p.pairingId} />
          ))}
        </div>
      )}

      {usable && services.length > 0 && (
        <div className="mt-[18px]">
          <SectionLabel right={<span className="text-[11.5px] text-fg-faint">{services.length} paired</span>}>Paired services</SectionLabel>
          <div className="space-y-2">
            {services.map((s) => (
              <div key={s.serviceId} data-testid="remote-service-row">
                <RemoteCard
                  icon="link"
                  title={s.name}
                  subtitle={`${s.homeCwd} · ${s.scope.length} of ${SERVICE_TOOLS.length} tools · paired${s.pairedVia === 'local' ? ' locally' : ''} ${new Date(s.pairedAt).toLocaleDateString()}`}
                  action={revokeAction(s.serviceId, 'remote-service-revoke', () => handleRevokeService(s.serviceId))}
                />
                <StartWorkControl service={s} projects={projects} busy={busyId === s.serviceId} onSave={handleSetStartWork} />
                {s.projectRoot && (
                  <div data-testid={`remote-service-project-root-${s.serviceId}`} className="text-[12px] text-fg-faint mt-1 px-[18px]">
                    New projects go in <span className="font-mono">{s.projectRoot}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {usable && orphans.length > 0 && (
        <div className="mt-[18px]">
          <SectionLabel>Relay clients without a service</SectionLabel>
          <div className="space-y-2">
            {orphans.map((o) => (
              <div key={o.clientId} data-testid="remote-relay-orphan-row">
                <RemoteCard
                  icon="wifi"
                  title={o.clientName || 'unnamed client'}
                  subtitle={o.clientId}
                  action={revokeAction(o.clientId, 'remote-relay-orphan-revoke', () => handleRevokeOrphan(o.clientId))}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
