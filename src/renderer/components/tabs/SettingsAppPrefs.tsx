import { RAW_MODELS, useRawSessionModel } from '../../lib/rawSessionModel'

/**
 * Session Manager native preferences — not backed by Claude Code's own
 * settings.json, same tier as density. Applies immediately via localStorage,
 * no save/revert/dirty tracking.
 */
export function SettingsAppPrefs() {
  const { model, setModel } = useRawSessionModel()

  return (
    <div className="p-4 max-w-3xl space-y-5 text-sm">
      <header className="space-y-1">
        <h2 className="text-fg text-base font-medium">Session Manager preferences</h2>
        <p className="text-fg-dim text-xs leading-relaxed">
          Native app preferences, stored locally — not part of Claude Code&apos;s own settings.
        </p>
      </header>

      <section className="border border-line rounded p-3 space-y-3">
        <label className="block space-y-1">
          <span className="text-fg-dim text-xs">Default model for raw sessions</span>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value as typeof model)}
            className="w-full bg-bg border border-line rounded px-2 py-1 text-fg font-mono text-xs"
          >
            {RAW_MODELS.map((m) => (
              <option key={m} value={m}>
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </option>
            ))}
          </select>
          <span className="text-fg-faint text-[11px]">
            Used when opening a raw interactive session without an explicit per-launch override.
          </span>
        </label>
      </section>
    </div>
  )
}
