import { useEffect, useState, type ReactNode } from 'react'
import type { Armory, ToolRiskMark } from '../../../../preload/api'
import type { Draft } from './AgentDetail'
import { RiskBadge } from './RiskBadge'

/**
 * The Constraints card of the agent sheet (frame 1b). Only the sandbox environment is editable (it
 * writes `draft.environment`, the persona's `environment:` frontmatter). Risk marks, the banned list
 * and the settings.json summary are READ-ONLY views — Settings is substrate, edited only in
 * Claude config ▸ Settings (the Settings law), reached by "Open Settings ›".
 *
 * Environment cards render from `armory.environments` (served by agentArmory.cjs).
 */

export const DEFAULT_ENVIRONMENT = 'headless-default'

const RISK_LABEL: Record<ToolRiskMark, string> = {
  read: 'READ', write: 'WRITE', confirm: 'CONFIRM', irreversible: 'IRREVERSIBLE', money: 'MONEY', public: 'PUBLIC',
}

interface Perms { allow: number; deny: number }

function Section({ testid, title, children }: { testid: string; title: string; children: ReactNode }) {
  return (
    <div data-testid={testid} className="flex flex-col gap-1.5 pt-3 border-t border-line first:border-t-0 first:pt-0">
      <div className="font-serif italic text-[12px] text-fg-faint">{title}</div>
      {children}
    </div>
  )
}

export function ConstraintsPanel({ obj, set }: { obj: Draft; set: (patch: Partial<Draft>) => void }) {
  const [armory, setArmory] = useState<Armory | null>(null)
  const [marks, setMarks] = useState<Record<string, ToolRiskMark>>({})
  const [perms, setPerms] = useState<Perms | null>(null)
  const current = obj.environment || DEFAULT_ENVIRONMENT

  useEffect(() => {
    let live = true
    const api = window.api
    api?.agents?.armory?.({}).then((a) => { if (live) setArmory(a) }).catch(() => {})
    api?.toolRisk?.read?.({ scope: 'user' }).then((r) => { if (live && r?.ok) setMarks(r.marks ?? {}) }).catch(() => {})
    api?.claudeConfig?.read?.({ fileId: 'settings', scope: 'user' }).then((r) => {
      if (!live) return
      const p = (r?.data?.permissions ?? {}) as { allow?: unknown; deny?: unknown }
      setPerms({ allow: Array.isArray(p.allow) ? p.allow.length : 0, deny: Array.isArray(p.deny) ? p.deny.length : 0 })
    }).catch(() => {})
    return () => { live = false }
  }, [])

  const banned = armory
    ? [
        ...armory.builtins, ...armory.bundledSkills,
        ...armory.mcpServers.flatMap((m) => [m, ...m.tools]),
      ].filter((i) => i.badges.includes('banned'))
    : []
  const markEntries = Object.entries(marks).filter(([, m]) => m !== 'read')

  return (
    <section data-testid="agent-constraints-slot" className="px-[18px] py-4 rounded-[14px] bg-bg-hi border border-line flex flex-col gap-3">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-faint">
          Constraints <span className="font-serif italic normal-case tracking-normal">rules of the realm</span>
        </div>
        <div className="text-[12px] text-fg-faint italic">Rules on the gear — not inventory.</div>
      </div>

      <Section testid="constraints-environment" title="Sandbox environment">
        <div role="radiogroup" aria-label="Sandbox environment" className="flex flex-col gap-1.5">
          {(armory?.environments ?? []).map((c) => {
            const on = c.name === current
            return (
              <button
                key={c.name}
                type="button"
                role="radio"
                aria-checked={on}
                data-environment={c.name}
                onClick={() => set({ environment: c.name })}
                className={`text-left px-3 py-2 rounded-[10px] border flex items-start gap-2 ${on ? 'border-accent bg-accent/10' : 'border-line bg-bg hover:border-rule'}`}
              >
                <span
                  aria-hidden="true"
                  data-radio-dot={on ? 'on' : 'off'}
                  className={`mt-1 w-2.5 h-2.5 shrink-0 rounded-full border ${on ? 'border-accent bg-accent' : 'border-rule'}`}
                />
                <span className="min-w-0">
                  <div className="text-[13px] font-semibold text-fg font-mono">{c.name}</div>
                  <div className="text-[11.5px] text-fg-faint">{c.summary}</div>
                </span>
              </button>
            )
          })}
        </div>
      </Section>

      <Section testid="constraints-risk-marks" title="Risk marks">
        {markEntries.length === 0 ? (
          <div className="text-[12px] text-fg-faint italic">No risk marks set.</div>
        ) : (
          <ul className="flex flex-col gap-1">
            {markEntries.map(([rule, mark]) => (
              <li key={rule} data-risk-mark={mark} className="flex items-center gap-2 text-[12px]">
                <RiskBadge mark={mark}>{RISK_LABEL[mark]}</RiskBadge>
                <span className="font-mono text-fg-dim truncate">{rule}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section testid="constraints-banned" title="Banned in unattended runs">
        {banned.length === 0 ? (
          <div className="text-[12px] text-fg-faint italic">Nothing banned.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {banned.map((b) => (
              <span key={b.id} data-banned={b.id} className="px-2 py-0.5 rounded-full text-[11px] font-mono bg-red-500/15 text-red-700">{b.label || b.id}</span>
            ))}
          </div>
        )}
      </Section>

      <Section testid="constraints-settings" title="settings.json">
        <div className="flex items-center gap-2 text-[12px] text-fg-dim">
          <span data-testid="constraints-settings-counts" className="flex-1">
            {perms ? `${perms.allow} allow · ${perms.deny} deny` : '— allow · — deny'}
          </span>
          <button
            type="button"
            data-testid="constraints-open-settings"
            onClick={() => window.dispatchEvent(new CustomEvent('sm:navigate', { detail: 'settings' }))}
            className="text-[12px] font-medium text-accent hover:underline"
          >
            Open Settings ›
          </button>
        </div>
      </Section>
    </section>
  )
}
