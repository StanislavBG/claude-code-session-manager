import { useEffect, useState } from 'react'
import { Toggle } from '../ui/Toggle'
import { EmptyState } from '../ui/EmptyState'
import type {
  OtelConfig,
  OtelStatus,
  TelemetryConfig,
  TelemetryStatus,
  TelemetryRecentRecord,
} from '../../../preload/api'

const DAY_MS = 24 * 60 * 60 * 1000

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const ms = new Date(iso).getTime()
  if (Number.isNaN(ms)) return 'never'
  return new Date(ms).toLocaleString()
}

function fmtWhenMs(ms: number | null | undefined): string {
  if (!ms) return 'never'
  return new Date(ms).toLocaleString()
}

/**
 * Sub-view of Settings > Telemetry. Two clearly separated sections that
 * happen to share this pane: the pre-existing opt-in OTEL transcript
 * exporter, and product telemetry (this app phoning bilko.run about itself).
 * They are unrelated data paths — see the module-level split in
 * session-manager-operations/architecture/telemetry.md — kept in one
 * sub-view rather than a new LeftNav destination per CLAUDE.md's Avoid list.
 */
export function SettingsTelemetry() {
  return (
    <div className="p-4 max-w-3xl space-y-8 text-sm">
      <OtelExportSection />
      <hr className="border-line" />
      <ProductTelemetrySection />
    </div>
  )
}

function OtelExportSection() {
  const [cfg, setCfg] = useState<OtelConfig | null>(null)
  const [status, setStatus] = useState<OtelStatus | null>(null)
  const [draft, setDraft] = useState<OtelConfig | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.api.otel.getConfig(),
      window.api.otel.status(),
      window.api.otel.configPath(),
    ]).then(([c, s, p]) => {
      if (cancelled) return
      setCfg(c)
      setDraft(c)
      setStatus(s)
      setPath(p)
    }).catch((e) => {
      console.warn('[telemetry] load failed:', e?.message)
    })
    return () => { cancelled = true }
  }, [])

  if (!draft || !cfg) return <EmptyState title="loading…" />

  const dirty = JSON.stringify(draft) !== JSON.stringify(cfg)
  const update = <K extends keyof OtelConfig>(key: K, value: OtelConfig[K]) => {
    setSaveError(null)
    setDraft({ ...draft, [key]: value })
  }

  const onSave = async () => {
    setBusy(true)
    setSaveError(null)
    try {
      const res = await window.api.otel.setConfig(draft)
      if (!res.ok && res.error) {
        setSaveError(res.error)
      }
      setCfg(res.config)
      setDraft(res.config)
      setStatus(res.status)
      setSavedAt(Date.now())
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onRevert = () => {
    setSaveError(null)
    setDraft(cfg)
  }

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-fg text-base font-medium">OpenTelemetry export</h2>
        <p className="text-fg-dim text-xs leading-relaxed">
          When enabled, every classified transcript event (tool_use, todo_write, plan, usage,
          agent_spawn) is mirrored as a 0-duration OTLP/HTTP span. Point this at a local
          collector (Jaeger, Grafana Tempo, SigNoz, Honeycomb) for cross-session analysis.
        </p>
        {path && (
          <p className="text-fg-faint text-[11px]">
            stored at <span className="font-mono">{path}</span>
          </p>
        )}
      </header>

      <section className="border border-line rounded p-3 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-fg">Export transcripts to OTEL</div>
            <div className="text-fg-faint text-xs">Toggle off to disable all span emission immediately.</div>
          </div>
          <Toggle
            checked={draft.enabled}
            onChange={(v) => update('enabled', v)}
            label={draft.enabled ? 'on' : 'off'}
          />
        </div>

        <label className="block space-y-1">
          <span className="text-fg-dim text-xs">OTLP/HTTP traces endpoint</span>
          <input
            type="text"
            value={draft.endpoint}
            onChange={(e) => update('endpoint', e.target.value)}
            placeholder="http://localhost:4318/v1/traces"
            className="w-full bg-bg border border-line rounded px-2 py-1 text-fg font-mono text-xs"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-fg-dim text-xs">
            Headers (newline-separated <span className="font-mono">Key: Value</span>)
          </span>
          <textarea
            value={draft.headers}
            onChange={(e) => update('headers', e.target.value)}
            placeholder="x-honeycomb-team: YOUR_API_KEY"
            rows={3}
            className="w-full bg-bg border border-line rounded px-2 py-1 text-fg font-mono text-xs"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-fg-dim text-xs">Service name</span>
          <input
            type="text"
            value={draft.serviceName}
            onChange={(e) => update('serviceName', e.target.value)}
            placeholder="session-manager"
            className="w-full bg-bg border border-line rounded px-2 py-1 text-fg font-mono text-xs"
          />
        </label>

        <div className="flex items-start justify-between gap-3 pt-1">
          <div>
            <div className="text-fg">Include content (PII)</div>
            <div className="text-fg-faint text-xs leading-relaxed">
              Adds tool inputs, plan text, and agent prompts to span attributes.
              Off by default — matches upstream Claude Code's <span className="font-mono">OTEL_LOG_USER_PROMPTS</span> opt-in.
            </div>
          </div>
          <Toggle
            checked={draft.includeContent}
            onChange={(v) => update('includeContent', v)}
            label={draft.includeContent ? 'on' : 'off'}
          />
        </div>
      </section>

      {status && (
        <section className="border border-line rounded p-3 text-xs space-y-1">
          <div className="text-fg-dim">Runtime status</div>
          <div>
            <span className="text-fg-faint">enabled:</span>{' '}
            <span className={status.enabled ? 'text-accent' : 'text-fg-dim'}>
              {String(status.enabled)}
            </span>
          </div>
          {status.error && (
            <div className="text-red-400 break-words">
              <span className="text-fg-faint">error:</span> {status.error}
            </div>
          )}
          {!status.error && status.enabled && (
            <div className="text-fg-faint">
              spans batched and exported in the background. Verify by enabling and pointing at a local Jaeger.
            </div>
          )}
        </section>
      )}

      <footer className="flex items-center gap-3 pt-2 border-t border-line">
        <button
          onClick={onSave}
          disabled={!dirty || busy}
          className="px-3 py-1 text-xs rounded bg-accent text-bg disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? 'saving…' : 'Save'}
        </button>
        <button
          onClick={onRevert}
          disabled={!dirty || busy}
          className="px-3 py-1 text-xs rounded border border-line text-fg-dim hover:text-fg disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Revert
        </button>
        {saveError && <span className="text-red-400 text-xs">{saveError}</span>}
        {!saveError && savedAt && !dirty && (
          <span className="text-fg-faint text-xs">saved</span>
        )}
      </footer>
    </div>
  )
}

/**
 * Product telemetry (bilko.run) — anonymous, on-by-default, opt-out. Persisted
 * to ~/.claude/session-manager/telemetry.json (telemetrySettings.cjs). No
 * identity field beyond the minted installId; no email/username/account
 * input anywhere in this section — see telemetry.md for the full data model
 * and the "how duplicate submission is prevented" mechanisms this section's
 * counters reflect.
 */
function ProductTelemetrySection() {
  const [cfg, setCfg] = useState<TelemetryConfig | null>(null)
  const [status, setStatus] = useState<TelemetryStatus | null>(null)
  const [copyLabel, setCopyLabel] = useState('Copy')
  const [flushBusy, setFlushBusy] = useState(false)
  const [flushResult, setFlushResult] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [records, setRecords] = useState<TelemetryRecentRecord[] | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)

  const reload = () => {
    window.api.telemetry.status().then(setStatus).catch((e) => {
      console.warn('[product-telemetry] status reload failed:', e?.message)
    })
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([window.api.telemetry.getConfig(), window.api.telemetry.status()]).then(([c, s]) => {
      if (cancelled) return
      setCfg(c)
      setStatus(s)
    }).catch((e) => {
      console.warn('[product-telemetry] load failed:', e?.message)
    })
    return () => { cancelled = true }
  }, [])

  if (!cfg || !status) return <EmptyState title="loading…" />

  const persist = async (next: TelemetryConfig) => {
    setSaveError(null)
    try {
      const res = await window.api.telemetry.setConfig(next)
      setCfg(res.config)
      setStatus(res.status)
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : String(e))
    }
  }

  const onToggle = (enabled: boolean) => {
    void persist({ ...cfg, enabled })
  }

  const onAckNotice = (opts: { turnOff: boolean }) => {
    void persist({
      ...cfg,
      enabled: opts.turnOff ? false : cfg.enabled,
      noticeAckedAt: new Date().toISOString(),
    })
  }

  const onCopyInstallId = async () => {
    try {
      await navigator.clipboard.writeText(cfg.installId)
      setCopyLabel('Copied')
      setTimeout(() => setCopyLabel('Copy'), 1500)
    } catch { /* clipboard denied — non-fatal */ }
  }

  const onSendNow = async () => {
    setFlushBusy(true)
    setFlushResult(null)
    try {
      const res = await window.api.telemetry.flushNow()
      setFlushResult(`sent ${res.sent.length}, failed ${res.failed.length}`)
      reload()
    } catch (e: unknown) {
      setFlushResult(e instanceof Error ? e.message : String(e))
    } finally {
      setFlushBusy(false)
    }
  }

  const onToggleInspector = async () => {
    if (inspectorOpen) {
      setInspectorOpen(false)
      return
    }
    try {
      const recs = await window.api.telemetry.recentRecords()
      setRecords(recs)
      setInspectorOpen(true)
    } catch (e: unknown) {
      console.warn('[product-telemetry] recentRecords failed:', e instanceof Error ? e.message : e)
    }
  }

  const nextDailyDueAt = cfg.lastDailyFlushAt ? new Date(cfg.lastDailyFlushAt).getTime() + DAY_MS : null

  return (
    <div className="space-y-5" data-testid="product-telemetry-section">
      <header className="space-y-1">
        <h2 className="text-fg text-base font-medium">Product telemetry (bilko.run)</h2>
        <p className="text-fg-dim text-xs leading-relaxed">
          Anonymous, strictly non-identifying usage/error reporting that helps improve this app.
          On by default; switchable off in one click. See{' '}
          <span className="font-mono">session-manager-operations/architecture/telemetry.md</span> for the
          full data model.
        </p>
      </header>

      {!cfg.noticeAckedAt && (
        <section
          data-testid="telemetry-first-run-notice"
          className="border border-accent rounded p-3 space-y-2 text-xs"
        >
          <div className="text-fg font-medium">This app sends anonymous product telemetry</div>
          <p className="text-fg-dim leading-relaxed">
            Collected: a coarse machine profile (OS/arch/app version, no hardware id), error and
            warning counts, and session counts — sent on start-up, after an update, and once a day.
          </p>
          <p className="text-fg-dim leading-relaxed">
            Never collected: prompts, transcripts, file paths, project names, email, or username.
          </p>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => onAckNotice({ turnOff: false })}
              className="px-3 py-1 rounded bg-accent text-bg"
            >
              OK
            </button>
            <button
              onClick={() => onAckNotice({ turnOff: true })}
              className="px-3 py-1 rounded border border-line text-fg-dim hover:text-fg"
            >
              Turn off
            </button>
          </div>
        </section>
      )}

      <section className="border border-line rounded p-3 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-fg">Send anonymous product telemetry</div>
            <div className="text-fg-faint text-xs">
              Sent on start-up, after an update, and once a day. Strictly anonymous — an install id
              only, never an email, name, or other identifier.
            </div>
          </div>
          <Toggle checked={cfg.enabled} onChange={onToggle} label={cfg.enabled ? 'on' : 'off'} />
        </div>

        <div className="space-y-1">
          <div className="text-fg-dim text-xs">Anonymous install id</div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={cfg.installId}
              aria-label="Anonymous install identifier"
              className="flex-1 bg-bg border border-line rounded px-2 py-1 text-fg font-mono text-xs"
            />
            <button
              onClick={onCopyInstallId}
              className="px-2 py-1 text-xs rounded border border-line text-fg-dim hover:text-fg"
            >
              {copyLabel}
            </button>
          </div>
        </div>

        <div className="space-y-1 text-xs">
          <div className="text-fg-faint">Endpoint</div>
          <div className="font-mono text-fg-dim break-all">{cfg.endpoint}</div>
        </div>

        <div className="space-y-1 text-xs">
          <div className="text-fg-faint">Send cadence</div>
          <div className="text-fg-dim">on start-up, after an update, and once a day</div>
        </div>

        {saveError && <div className="text-red-400 text-xs">{saveError}</div>}
      </section>

      {status.pendingCount > 0 && status.sentCount === 0 && (
        <section
          data-testid="telemetry-never-delivered-warning"
          className="border border-red-400 rounded p-3 text-xs space-y-1 text-red-400"
        >
          <div className="font-medium">Never delivered</div>
          <div className="leading-relaxed">
            {status.pendingCount} record{status.pendingCount === 1 ? '' : 's'} queued but none have ever
            been sent to bilko.run on this install. Check the endpoint/network, or click "Send now" below.
          </div>
        </section>
      )}

      <section className="border border-line rounded p-3 text-xs space-y-1.5">
        <div className="text-fg-dim">Runtime status</div>
        <div><span className="text-fg-faint">last send:</span> {fmtWhenMs(status.lastFlushAt)}</div>
        <div><span className="text-fg-faint">next daily send due:</span> {fmtWhen(nextDailyDueAt ? new Date(nextDailyDueAt).toISOString() : null)}</div>
        <div><span className="text-fg-faint">queued records:</span> {status.pendingCount}</div>
        <div><span className="text-fg-faint">delivered so far:</span> {status.sentCount}</div>
        <div><span className="text-fg-faint">de-duplicated:</span> {status.dedupedAppends}</div>
        <div><span className="text-fg-faint">evicted:</span> {status.evictedCount}</div>
        {status.backlog && (
          <div className="text-fg-faint">
            last backlog drain ({status.backlog.reason}, {fmtWhen(status.backlog.ranAt)}):{' '}
            {status.backlog.linesEnqueued} enqueued, {status.backlog.linesConfirmed} confirmed,{' '}
            {status.backlog.watermarksRewound} watermarks rewound
          </div>
        )}
        {status.lastError && (
          <div className="text-red-400 break-words">
            <span className="text-fg-faint">last error:</span> {status.lastError.message}
            {' '}({fmtWhenMs(status.lastError.at)})
          </div>
        )}
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={onSendNow}
          disabled={flushBusy}
          className="px-3 py-1 text-xs rounded bg-accent text-bg disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {flushBusy ? 'sending…' : 'Send now'}
        </button>
        {flushResult && <span className="text-fg-faint text-xs">{flushResult}</span>}
      </div>

      <section className="space-y-2">
        <button
          onClick={onToggleInspector}
          className="px-3 py-1 text-xs rounded border border-line text-fg-dim hover:text-fg"
        >
          {inspectorOpen ? 'Hide last records' : 'Inspect last records sent'}
        </button>
        {inspectorOpen && (
          <pre
            data-testid="telemetry-inspector-json"
            className="bg-bg border border-line rounded p-2 text-[11px] font-mono overflow-auto max-h-96 whitespace-pre-wrap"
          >
            {JSON.stringify(records ?? [], null, 2)}
          </pre>
        )}
      </section>
    </div>
  )
}
