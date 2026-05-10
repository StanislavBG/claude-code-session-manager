interface Props {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
  disabled?: boolean
}

export function Toggle({ checked, onChange, label, disabled }: Props) {
  return (
    <label
      className={`inline-flex items-center gap-2 text-xs ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
      }`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative w-7 h-4 rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-bg-hi border border-line'
        }`}
      >
        <span
          className={`absolute top-0.5 w-3 h-3 rounded-full bg-fg transition-transform ${
            checked ? 'translate-x-3.5' : 'translate-x-0.5'
          }`}
        />
      </button>
      {label && <span className="text-fg-dim">{label}</span>}
    </label>
  )
}
