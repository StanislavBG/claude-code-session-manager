import { useEffect, useState } from 'react'
import { SaveBar } from '../ui/SaveBar'
import { Toggle } from '../ui/Toggle'
import { SourceChip } from '../ui/SourceChip'
import { ConfigCard, ConfigDetailHeader } from '../claudeConfig/ConfigLayout'
import { toast } from '../../state/toast'

/** Where main keeps the per-project isolation toggle: opsPath(cwd, 'prompt-sessions', …) in epicWorktreeProjectConfig.cjs. */
export const epicWorktreeConfigPath = (cwd: string) =>
  `${cwd}/session-manager-operations/prompt-sessions/epic-worktree-config.json`

/**
 * Per-project "disable Epic worktree isolation" toggle (PRD 1035, final
 * link of the epic-worktree-isolation chain) — the UI-reachable equivalent
 * of setting `SM_EPIC_WORKTREE_DISABLE=1` for just this one project rather
 * than machine-wide. Not part of Claude Code's own settings.json (this is a
 * Session Manager runtime concern, same tier as SettingsAppPrefs), so it
 * gets its own card rather than a JSON key — but reuses the same
 * SaveBar dirty/save/revert affordance Settings.tsx's scoped editors use.
 * Rendered as the detail of the 'Epic isolation' rail entry in Settings.tsx
 * (project scope only; DESIGN_SPEC.md §5.6): ConfigDetailHeader + ConfigCard
 * with the shared Toggle and a SourceChip naming its real file. It is
 * per-project, so it has no Project / Local switch of its own.
 */
export function SettingsEpicIsolation({ cwd }: { cwd: string }) {
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    // Optional-chained: older/lighter test harnesses stub only a subset of
    // window.api, and a missing IPC surface here must degrade to "not
    // disabled, but still editable" rather than crash the whole Settings tab.
    Promise.resolve(window.api.promptSessions?.getWorktreeDisabled?.({ cwd })).then(
      (result) => {
        if (cancelled) return
        setSaved(result?.disabled ?? false)
        setChecked(result?.disabled ?? false)
        setLoaded(true)
      },
      () => {
        if (cancelled) return
        setLoaded(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [cwd])

  const dirty = loaded && checked !== saved

  const onSave = () => {
    setBusy(true)
    Promise.resolve(window.api.promptSessions?.setWorktreeDisabled?.({ cwd, disabled: checked }))
      .then((result) => {
        setSaved(result?.disabled ?? checked)
        setChecked(result?.disabled ?? checked)
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  const onRevert = () => setChecked(saved)

  return (
    <div data-testid="settings-epic-isolation" className="flex flex-col flex-1 min-h-0">
      <ConfigDetailHeader eyebrow="PROJECT · SESSION MANAGER" title="Epic isolation" />
      <div className="flex-1 min-h-0 overflow-y-auto px-9 py-6 flex flex-col gap-3">
        <ConfigCard label="Worktree isolation" labelNote="SESSION MANAGER'S OWN SETTING, NOT A SETTINGS.JSON KEY">
          <div className="flex items-start gap-3">
            <span className="flex-1 min-w-0">
              <span className="block font-semibold text-fg">Disable Epic worktree isolation for this project</span>
              <span className="mt-1 block text-[13.5px] leading-snug text-fg-dim">
                Off by default — each active Epic runs in its own isolated <code>git worktree</code> (branch{' '}
                <code>sm-epic/&lt;id&gt;</code>), merged back to main at an explicit checkpoint. Turning this on makes
                every new Epic in this project run directly in the shared working tree instead, same as before this
                feature existed.
              </span>
            </span>
            <span data-testid="settings-epic-isolation-toggle" className="shrink-0 mt-0.5">
              <Toggle checked={checked} disabled={!loaded || busy} onChange={setChecked} />
            </span>
          </div>
          <div className="mt-3">
            <SourceChip path={epicWorktreeConfigPath(cwd)} />
          </div>
        </ConfigCard>
      </div>
      {dirty && (
        <div className="shrink-0 border-t border-line bg-bg-elev">
          <SaveBar dirty={dirty} busy={busy} onSave={onSave} onRevert={onRevert} />
        </div>
      )}
    </div>
  )
}
