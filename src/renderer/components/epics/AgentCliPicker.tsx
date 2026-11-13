import { useCallback, useEffect, useState } from 'react'
import type { AgentCliDetectRow, PromptSessionsCreateEpicPayload } from '../../../preload/api'
import { AGENT_CLI_LABELS, type AgentCliId } from '../../lib/agentCliCatalog'
import { useToast } from '../../state/toast'

/** The CLI an Epic runs under; 'claude' (Claude Code) is the default and always available. */
export type AgentCliChoice = NonNullable<PromptSessionsCreateEpicPayload['agentCli']>

const ORDER: AgentCliId[] = ['codex', 'gemini', 'antigravity', 'cursor', 'opencode']

/**
 * Third independent New Session selection (beside Agent and Mission): which
 * coding-agent CLI runs the session. Claude Code is listed first and is always
 * enabled; the others come from `window.api.agentCli.detect` — a not-installed
 * CLI is disabled and shows its install command (copyable) and docs link. A
 * detect failure toasts and leaves only Claude Code enabled.
 */
export function AgentCliPicker({ value, onChange }: { value: AgentCliChoice; onChange: (id: AgentCliChoice) => void }) {
  const show = useToast((s) => s.show)
  const [rows, setRows] = useState<AgentCliDetectRow[] | null>(null)
  const [checking, setChecking] = useState(false)

  const load = useCallback(async (refresh: boolean) => {
    setChecking(true)
    try {
      const detect = window.api?.agentCli?.detect
      if (typeof detect !== 'function') throw new Error('agentCli.detect is unavailable — restart Session Manager')
      const next = await detect(refresh ? { refresh: true } : {})
      setRows(Array.isArray(next) ? next : [])
    } catch (e) {
      setRows([])
      show('error', `Could not detect agent CLIs: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setChecking(false)
    }
  }, [show])

  useEffect(() => { void load(false) }, [load])

  const byId = new Map((rows ?? []).map((r) => [r.id, r]))
  const copy = async (text: string) => {
    try {
      const r = await window.api.clipboard.writeText(text)
      if (!r.ok) show('error', r.error || 'Could not copy the install command')
      else show('info', 'Install command copied')
    } catch (e) {
      show('error', `Could not copy the install command: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const openDocs = async (url: string) => {
    try {
      const r = await window.api.shell.open({ as: 'external', url })
      if (!r.ok) show('error', r.error || `Could not open ${url}`)
    } catch (e) {
      show('error', `Could not open ${url}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const chip = (id: AgentCliChoice, label: string, enabled: boolean, title?: string) => {
    const on = value === id
    return (
      <button
        key={id}
        type="button"
        role="radio"
        aria-checked={on}
        data-testid={`new-epic-agent-cli-option-${id}`}
        disabled={!enabled}
        title={title}
        onClick={() => onChange(id)}
        className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
          on ? 'bg-bg-hi text-fg font-semibold shadow-sm' : 'text-fg-dim'
        }`}
      >
        {label}
      </button>
    )
  }

  const missing = ORDER.map((id) => byId.get(id)).filter((r): r is AgentCliDetectRow => Boolean(r && !r.installed))

  return (
    <div data-testid="new-epic-agent-cli" className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Agent CLI" className="inline-flex flex-wrap rounded-[10px] border border-line bg-bg p-0.5">
          {chip('claude', 'Claude Code', true)}
          {ORDER.map((id) => {
            const row = byId.get(id)
            const label = row?.label || AGENT_CLI_LABELS[id]
            const enabled = Boolean(row?.installed)
            const title = row ? (row.installed ? [row.version, row.path].filter(Boolean).join(' · ') || undefined : 'Not installed') : (rows === null ? 'Checking…' : 'Not detected')
            return chip(id, label, enabled, title)
          })}
        </div>
        <button
          type="button"
          data-testid="new-epic-agent-cli-recheck"
          disabled={checking}
          onClick={() => void load(true)}
          className="rounded border border-line px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-fg-dim hover:bg-bg-elev disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Re-check'}
        </button>
      </div>
      {missing.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {missing.map((r) => (
            <li
              key={r.id}
              data-testid={`new-epic-agent-cli-install-${r.id}`}
              className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-fg-faint"
            >
              <span className="font-medium text-fg-dim">{r.label || AGENT_CLI_LABELS[r.id]}</span>
              <span>not installed</span>
              {r.install && (
                <>
                  <code className="min-w-0 truncate rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-[10.5px] text-fg-dim">{r.install}</code>
                  <button
                    type="button"
                    data-testid={`new-epic-agent-cli-copy-${r.id}`}
                    onClick={() => void copy(r.install!)}
                    className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-fg-dim hover:bg-bg-elev"
                  >
                    Copy
                  </button>
                </>
              )}
              <a
                href={r.docs}
                data-testid={`new-epic-agent-cli-docs-${r.id}`}
                onClick={(e) => { e.preventDefault(); void openDocs(r.docs) }}
                className="text-accent hover:underline"
              >
                Docs
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
