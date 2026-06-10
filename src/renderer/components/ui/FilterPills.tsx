interface FilterPillOption<T extends string> {
  value: T
  label: string
}

interface FilterPillsProps<T extends string> {
  options: readonly FilterPillOption<T>[]
  value: T
  onChange: (v: T) => void
  /** Override the padding/sizing classes on each pill. Defaults to `px-3 py-1.5`. */
  pillPadding?: string
}

export function FilterPills<T extends string>({ options, value, onChange, pillPadding = 'px-3 py-1.5' }: FilterPillsProps<T>) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {options.map((opt) => {
        const on = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`rounded-full ${pillPadding} text-[12.5px] border transition-colors ${
              on
                ? 'bg-accent text-white border-accent font-semibold'
                : 'bg-bg-hi text-fg-dim border-line hover:border-fg-faint font-medium'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
