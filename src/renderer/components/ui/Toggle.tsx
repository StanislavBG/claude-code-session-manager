interface Props {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
  disabled?: boolean
}

/**
 * Switch per design-mocks/claude-config (renders 07, 13): a pill track — accent when on,
 * line colour when off — with a white (bg-bg-hi) thumb inside it. The track never shrinks
 * in a flex row, so the thumb can't spill over the optional label, which sits after it.
 */
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
        className={`relative inline-flex shrink-0 items-center w-8 h-[18px] rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
          checked ? 'bg-accent' : 'bg-line'
        }`}
      >
        <span
          data-testid="toggle-thumb"
          aria-hidden
          className={`absolute left-0.5 top-0.5 w-3.5 h-3.5 rounded-full bg-bg-hi shadow-sm transition-transform ${
            checked ? 'translate-x-3.5' : 'translate-x-0'
          }`}
        />
      </button>
      {label && (
        <span data-testid="toggle-label" className="whitespace-nowrap text-fg-dim">
          {label}
        </span>
      )}
    </label>
  )
}
