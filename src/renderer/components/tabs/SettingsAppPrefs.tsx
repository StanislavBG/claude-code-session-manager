import { rawModelOptions, useRawSessionModel } from '../../lib/rawSessionModel'
import { useModelCatalog } from '../../lib/useModelCatalog'
import { useDensity } from '../../lib/useDensity'
import { Choice } from '../ui/Choice'

const DENSITY_LABELS = { compact: 'Compact', roomy: 'Roomy' }

/**
 * Session Manager native preferences — not backed by Claude Code's own
 * settings.json, same tier as density. Applies immediately via the
 * disk-backed `uiChromePrefs` store, no save/revert/dirty tracking.
 */
export function SettingsAppPrefs() {
  const { model, setModel } = useRawSessionModel()
  const { catalog } = useModelCatalog(null)
  const { density, setDensity } = useDensity()

  return (
    <div className="p-4 max-w-3xl space-y-5 text-sm">
      <header className="space-y-1">
        <h2 className="text-fg text-base font-medium">Session Manager preferences</h2>
        <p className="text-fg-dim text-xs leading-relaxed">
          Native app preferences, stored locally — not part of Claude Code&apos;s own settings.
        </p>
      </header>

      <section className="border border-line rounded p-3 space-y-3">
        <div className="block space-y-1">
          <span className="text-fg-dim text-xs">Default model for raw sessions</span>
          <Choice options={rawModelOptions(catalog)} value={model} onChange={setModel} mono />
          <span className="text-fg-faint text-[11px]">
            Used when opening a raw interactive session without an explicit per-launch override.
          </span>
        </div>

        <div className="block space-y-1">
          <span className="text-fg-dim text-xs">Density</span>
          <Choice
            options={['compact', 'roomy']}
            value={density}
            onChange={(v) => setDensity(v as 'compact' | 'roomy')}
            labels={DENSITY_LABELS}
          />
          <span className="text-fg-faint text-[11px]">
            Compact tightens spacing across the app&apos;s chrome; Roomy is the default.
          </span>
        </div>
      </section>
    </div>
  )
}
