import { useEffect, useState } from 'react'
import { Toggle } from '../ui/Toggle'
import { EmptyState } from '../ui/EmptyState'
import type { OtelConfig, OtelStatus } from '../../../preload/api'

/**
 * Telemetry sub-view of Settings — opt-in OTEL export of classified
 * transcript events. Persisted to ~/.config/session-manager/otel.json,
 * not the scoped Claude Code settings file.
 *
 * Spans are emitted with structural metadata only (tool names, todo counts,
 * usage tokens). Tool inputs / plan text / agent prompts are excluded
 * unless "Include content" is on — this mirrors upstream Claude Code's
 * OTEL_LOG_USER_PROMPTS opt-in.
 */
export function SettingsTelemetry() {
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
    <div className="p-4 max-w-3xl space-y-5 text-sm">
      <header className="space-y-1">
        <h2 className="text-fg text-base font-medium">Telemetry — OpenTelemetry export</h2>
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
