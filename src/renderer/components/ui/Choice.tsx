/**
 * Choice — single-select pill row for catalog-driven pickers (model family/version, effort, New Session overrides).
 */
export function Choice({ options, value, onChange, mono, blocked, labels }: { options: string[]; value: string; onChange: (v: string) => void; mono?: boolean; blocked?: Record<string, string>; labels?: Record<string, string> }) {
  // A persona's on-disk `model:` may not be in the option list (hand-edited,
  // or a since-retired id; agentPersonaSchema.cjs just takes a bounded string).
  // It is appended as a selected-but-unlisted option, so a re-render or an
  // untouched save never silently rewrites it. `blocked` maps option -> reason;
  // those render disabled with the reason as their title, never hidden.
  const outOfList = value && !options.includes(value)
  const shown = outOfList ? [...options, value] : options
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((o) => {
        const on = o === value
        const isCurrentOnDisk = outOfList && o === value
        const block = blocked?.[o]
        return (
          <button
            key={o}
            onClick={() => onChange(o)}
            disabled={!!block}
            title={block ?? (isCurrentOnDisk ? `${o} — current on-disk value, not in the standard list` : undefined)}
            className={`px-2.5 py-1 rounded text-xs border ${mono ? 'font-mono' : ''} ${
              on ? 'bg-accent/15 text-accent border-accent/40 font-semibold' : 'bg-bg-hi text-fg-dim border-line'
            } ${isCurrentOnDisk ? 'border-dashed' : ''} ${block ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            {labels?.[o] ?? o}
            {isCurrentOnDisk ? ' (current)' : ''}
          </button>
        )
      })}
    </div>
  )
}
