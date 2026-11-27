import { useMemo, useState } from 'react'
import type { AgentPersona } from '../../../../preload/api'
import { computeLineDiff } from '../../../lib/lineDiff'
import { toast } from '../../../state/toast'

/** Notice above the agent sheet when a newer bundled version of this persona exists but was not applied. */
export function PersonaUpgradeNotice({ persona, onDone }: { persona: AgentPersona; onDone: () => Promise<void> | void }) {
  const upgrade = persona.upgrade
  const [busy, setBusy] = useState(false)
  const diff = useMemo(() => (upgrade ? computeLineDiff(persona.body, upgrade.bundledBody) : null), [persona.body, upgrade])
  if (!upgrade || !diff) return null

  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    try {
      toast.info(await fn())
      await onDone()
    } catch (e) {
      toast.error((e as Error).message || 'failed to update agent')
    } finally {
      setBusy(false)
    }
  }
  const take = () => run(async () => {
    const r = await window.api.agents.takeBundledPersona({ name: persona.name })
    return `updated ${persona.name} to v${r.seedVersion}; old copy saved at ${r.backupPath}`
  })
  const keep = () => run(async () => {
    await window.api.agents.dismissPersonaUpgrade({ name: persona.name, bundledVersion: upgrade.bundledVersion })
    return `keeping your ${persona.name}`
  })

  return (
    <div data-testid="persona-upgrade-notice" className="m-2 rounded border border-line bg-bg-hi p-3 text-xs text-fg flex flex-col gap-2">
      <div>
        A newer {persona.name} is available (v{upgrade.installedVersion} installed, v{upgrade.bundledVersion} bundled).
        {upgrade.edited ? ' You edited this agent, so your edits were kept and it was not updated automatically.' : ''}
      </div>
      <details>
        <summary className="cursor-pointer text-accent">Show changes (+{diff.added} / -{diff.removed})</summary>
        <pre className="mt-1 max-h-64 overflow-auto font-mono text-[11px] whitespace-pre-wrap">
          {diff.lines.map((l, i) => (
            <div key={i} data-diff={l.type} className={l.type === 'context' ? 'text-fg-dim' : l.type === 'add' ? 'text-accent' : 'text-fg line-through'}>
              {l.type === 'add' ? '+ ' : l.type === 'remove' ? '- ' : '  '}{l.text}
            </div>
          ))}
        </pre>
      </details>
      <div className="flex gap-2">
        <button type="button" data-testid="persona-upgrade-take" disabled={busy} onClick={take}
          className="rounded border border-accent px-2 py-1 text-accent hover:bg-bg-elev disabled:opacity-50">Take the new version</button>
        <button type="button" data-testid="persona-upgrade-keep" disabled={busy} onClick={keep}
          className="rounded border border-line px-2 py-1 text-fg hover:bg-bg-elev disabled:opacity-50">Keep mine</button>
      </div>
    </div>
  )
}
