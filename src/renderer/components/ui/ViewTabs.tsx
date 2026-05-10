/**
 * Generic N-way pill toggle used for Effective | Raw | Library -style view
 * switches in scope-editor tabs. Library.tsx has its own 2-way ViewSwitcher
 * that predates this; keep both until those callers converge.
 */

interface Option<K extends string> {
  key: K
  label: string
}

interface Props<K extends string> {
  options: ReadonlyArray<Option<K>>
  active: K
  onChange: (v: K) => void
}

export function ViewTabs<K extends string>({ options, active, onChange }: Props<K>) {
  return (
    <div className="flex rounded border border-line overflow-hidden">
      {options.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`px-2 py-0.5 text-xs ${
            active === key ? 'bg-bg-hi text-fg' : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
