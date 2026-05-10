import type { Scope } from '../../lib/scopes'
import { SCOPE_LABELS } from '../../lib/scopes'

interface Props {
  scopes: Scope[]
  active: Scope
  onChange: (s: Scope) => void
  /** Optional per-scope annotation (e.g., exists/dirty dot). */
  annotate?: (s: Scope) => { exists?: boolean; dirty?: boolean } | null
}

export function ScopeSwitcher({ scopes, active, onChange, annotate }: Props) {
  return (
    <div className="inline-flex rounded border border-line overflow-hidden">
      {scopes.map((s) => {
        const info = SCOPE_LABELS[s]
        const ann = annotate?.(s)
        const isActive = s === active
        return (
          <button
            key={s}
            title={info.hint}
            onClick={() => onChange(s)}
            className={`px-2.5 py-1 text-xs flex items-center gap-1.5 transition-colors ${
              isActive
                ? 'bg-bg-hi text-fg'
                : 'bg-bg-elev text-fg-dim hover:text-fg hover:bg-bg-hi'
            }`}
          >
            <span>{info.label}</span>
            {ann?.dirty && <span className="w-1 h-1 rounded-full bg-accent" title="unsaved edits" />}
            {ann && ann.exists === false && !ann.dirty && (
              <span className="w-1 h-1 rounded-full bg-fg-faint" title="not yet created" />
            )}
          </button>
        )
      })}
    </div>
  )
}
