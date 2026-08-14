import { useEffect, useState } from 'react'
import { SaveBar } from '../ui/SaveBar'
import { toast } from '../../state/toast'

/**
 * Per-project "disable Epic worktree isolation" toggle (PRD 1035, final
 * link of the epic-worktree-isolation chain) — the UI-reachable equivalent
 * of setting `SM_EPIC_WORKTREE_DISABLE=1` for just this one project rather
 * than machine-wide. Not part of Claude Code's own settings.json (this is a
 * Session Manager runtime concern, same tier as SettingsAppPrefs), so it
 * gets its own small card rather than a JSON key — but reuses the same
 * SaveBar dirty/save/revert affordance Settings.tsx's scoped editors use,
 * per CLAUDE.md's "follow the existing scoped-editor pattern" convention.
 * Rendered by Settings.tsx only when scope === 'project' — that scope's own
 * ScopeSwitcher is what makes this "per-project", not a switcher of its own.
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
    <div
      data-testid="settings-epic-isolation"
      className="border-b border-line bg-bg-elev px-3 py-2.5 text-[11.5px] leading-snug"
    >
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={checked}
          disabled={!loaded || busy}
          onChange={(e) => setChecked(e.target.checked)}
          data-testid="settings-epic-isolation-checkbox"
          className="mt-0.5"
        />
        <span>
          <span className="font-semibold text-fg">Disable Epic worktree isolation for this project</span>
          <span className="block text-fg-dim">
            Off by default — each active Epic runs in its own isolated <code>git worktree</code> (branch{' '}
            <code>sm-epic/&lt;id&gt;</code>), merged back to main at an explicit checkpoint. Turning this on makes
            every new Epic in this project run directly in the shared working tree instead, same as before this
            feature existed.
          </span>
        </span>
      </label>
      {dirty && <SaveBar dirty={dirty} busy={busy} onSave={onSave} onRevert={onRevert} />}
    </div>
  )
}
