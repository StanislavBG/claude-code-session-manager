import { useEffect, useRef, useState } from 'react'
import { SaveBar } from '../ui/SaveBar'
import { Toggle } from '../ui/Toggle'
import { SourceChip } from '../ui/SourceChip'
import { ConfigCard, ConfigDetailHeader } from '../claudeConfig/ConfigLayout'
import { useToast } from '../../state/toast'
import type { ToolRiskMark } from '../../../preload/api'

/** The closed mark set main's toolRiskMarks.cjs accepts — in display order. */
export const TOOL_RISK_MARKS: readonly ToolRiskMark[] = ['read', 'write', 'confirm', 'irreversible', 'money', 'public']

export type ToolRiskScope = 'user' | 'project'

interface Row {
  id: number
  rule: string
  mark: ToolRiskMark
}

interface Snapshot {
  rows: Row[]
  interactive: boolean
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const sameRows = (a: Row[], b: Row[]) =>
  a.length === b.length && a.every((r, i) => r.rule === b[i].rule && r.mark === b[i].mark)

/**
 * Tool risk — one risk mark per tool rule, kept per layer in
 * ~/.claude/tool-risk.json (System) and <project>/.claude/tool-risk.json
 * (Project; Project overrides System). Read/written only through
 * window.api.toolRisk (main's toolRiskIpc.cjs → toolRiskMarks.cjs, which owns
 * rule/mark validation — a refusal comes back as `{ ok:false, error }` and is
 * shown as-is while the edit stays dirty). Same shape as SettingsEpicIsolation:
 * ConfigDetailHeader + ConfigCard + SourceChip + the shared SaveBar. The
 * Project face also carries the opt-in to guard interactive sessions.
 */
export function SettingsToolRisk({ scope, cwd }: { scope: ToolRiskScope; cwd: string | null }) {
  const show = useToast((s) => s.show)
  const nextId = useRef(1)
  const [loaded, setLoaded] = useState(false)
  const [path, setPath] = useState<string | null>(null)
  const [saved, setSaved] = useState<Snapshot>({ rows: [], interactive: false })
  const [rows, setRows] = useState<Row[]>([])
  const [interactive, setInteractive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    setRefusal(null)
    Promise.resolve()
      .then(() => window.api.toolRisk.read({ scope, cwd: scope === 'project' ? cwd : null }))
      .then(
        (r) => {
          if (cancelled) return
          setPath(r.path)
          if (!r.ok) {
            const msg = r.error ?? 'could not read tool-risk marks'
            setRefusal(msg)
            show('error', msg)
          }
          const loadedRows = Object.entries(r.marks ?? {}).map(([rule, mark]) => ({ id: nextId.current++, rule, mark }))
          const snap = { rows: loadedRows, interactive: r.interactive === true }
          setSaved(snap)
          setRows(snap.rows)
          setInteractive(snap.interactive)
          setLoaded(true)
        },
        (e: unknown) => {
          if (cancelled) return
          const msg = errText(e)
          setRefusal(msg)
          show('error', msg)
          setLoaded(true)
        },
      )
    return () => {
      cancelled = true
    }
  }, [scope, cwd, show])

  const dirty = loaded && (!sameRows(rows, saved.rows) || (scope === 'project' && interactive !== saved.interactive))

  const updateRow = (id: number, patch: Partial<Omit<Row, 'id'>>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const removeRow = (id: number) => setRows((prev) => prev.filter((r) => r.id !== id))
  const addRow = () => setRows((prev) => [...prev, { id: nextId.current++, rule: '', mark: 'write' }])

  const onSave = () => {
    const marks: Record<string, ToolRiskMark> = {}
    for (const r of rows) marks[r.rule.trim()] = r.mark
    setBusy(true)
    setRefusal(null)
    const payload =
      scope === 'project' ? { scope, cwd, marks, interactive } : { scope, cwd: null, marks }
    Promise.resolve()
      .then(() => window.api.toolRisk.write(payload))
      .then((r) => {
        if (r.path) setPath(r.path)
        if (!r.ok) {
          const msg = r.error ?? 'tool-risk marks were not saved'
          setRefusal(msg)
          show('error', msg)
          return
        }
        const trimmed = rows.map((row) => ({ ...row, rule: row.rule.trim() }))
        setRows(trimmed)
        setSaved({ rows: trimmed, interactive: scope === 'project' ? interactive : false })
      })
      .catch((e: unknown) => {
        const msg = errText(e)
        setRefusal(msg)
        show('error', msg)
      })
      .finally(() => setBusy(false))
  }

  const onRevert = () => {
    setRows(saved.rows)
    setInteractive(saved.interactive)
    setRefusal(null)
  }

  const eyebrow = scope === 'project' ? 'PROJECT · TOOL RISK' : 'SYSTEM · TOOL RISK'

  return (
    <div data-testid="settings-tool-risk" className="flex flex-col flex-1 min-h-0">
      <ConfigDetailHeader eyebrow={eyebrow} title="Tool risk" />
      <div className="flex-1 min-h-0 overflow-y-auto px-9 py-6 flex flex-col gap-3">
        <ConfigCard label="Marks" labelNote="PROJECT OVERRIDES SYSTEM">
          <p className="text-[13.5px] leading-snug text-fg-dim">
            One risk mark per tool rule (<code>mcp__server__tool</code>, <code>mcp__server__*</code>,{' '}
            <code>Bash(prefix:*)</code>). Project overrides System.
          </p>
          <div data-testid="tool-risk-rows" className="mt-3 flex flex-col gap-2">
            {loaded && rows.length === 0 && (
              <span data-testid="tool-risk-empty" className="text-[13px] text-fg-faint">
                No marks in this file yet.
              </span>
            )}
            {rows.map((r) => (
              <div key={r.id} data-testid="tool-risk-row" className="flex items-center gap-2">
                <input
                  type="text"
                  aria-label="Tool rule"
                  data-testid="tool-risk-rule"
                  value={r.rule}
                  placeholder="mcp__server__tool"
                  disabled={busy}
                  onChange={(e) => updateRow(r.id, { rule: e.target.value })}
                  className="flex-1 min-w-0 h-8 px-2.5 rounded-[8px] bg-bg-hi border border-line font-mono text-[13px] text-fg outline-none focus:border-fg-faint"
                />
                <select
                  aria-label="Risk mark"
                  data-testid="tool-risk-mark"
                  value={r.mark}
                  disabled={busy}
                  onChange={(e) => updateRow(r.id, { mark: e.target.value as ToolRiskMark })}
                  className="h-8 px-2 rounded-[8px] bg-bg-hi border border-line text-[13px] text-fg"
                >
                  {TOOL_RISK_MARKS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  data-testid="tool-risk-remove"
                  aria-label={`Remove ${r.rule || 'mark'}`}
                  disabled={busy}
                  onClick={() => removeRow(r.id)}
                  className="h-8 px-2.5 rounded-[8px] border border-line text-[13px] text-fg-dim hover:bg-bg-hi focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              data-testid="tool-risk-add"
              disabled={!loaded || busy}
              onClick={addRow}
              className="h-8 px-3 rounded-[8px] border border-line bg-bg-hi text-[13px] font-medium text-fg hover:bg-bg-elev focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              + Add mark
            </button>
          </div>
          {refusal && (
            <div role="alert" data-testid="tool-risk-refusal" className="mt-3 text-xs text-red-400">
              {refusal}
            </div>
          )}
          {path && (
            <div className="mt-3">
              <SourceChip path={path} />
            </div>
          )}
        </ConfigCard>
        {scope === 'project' && (
          <ConfigCard label="Interactive sessions" labelNote="PROJECT ONLY">
            <div className="flex items-start gap-3">
              <span className="flex-1 min-w-0">
                <span className="block font-semibold text-fg">Also guard interactive sessions in this project</span>
                <span className="mt-1 block text-[13.5px] leading-snug text-fg-dim">
                  Off by default — marks apply to scheduled jobs. Turning this on installs the tool-risk guard hook into
                  this project's <code>.claude/settings.json</code>.
                </span>
              </span>
              <span data-testid="tool-risk-interactive-toggle" className="shrink-0 mt-0.5">
                <Toggle checked={interactive} disabled={!loaded || busy} onChange={setInteractive} />
              </span>
            </div>
          </ConfigCard>
        )}
      </div>
      {dirty && (
        <div className="shrink-0 border-t border-line bg-bg-elev">
          <SaveBar dirty={dirty} busy={busy} onSave={onSave} onRevert={onRevert} />
        </div>
      )}
    </div>
  )
}
