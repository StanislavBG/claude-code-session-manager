/**
 * The plugin enable switch — one control for both the list row and the detail header, so both call the
 * same `onToggle` (Plugins.tsx → `window.api.plugins.setEnabled`, settings.json › enabledPlugins).
 * Click and keydown stop at the switch so a list row does not also take them as a select.
 */
export interface PluginSwitchProps {
  name: string
  enabled: boolean
  disabled?: boolean
  onToggle: () => void
  testId?: string
}

export function PluginSwitch({ name, enabled, disabled, onToggle, testId = 'plugin-enabled-switch' }: PluginSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${enabled ? 'Disable' : 'Enable'} ${name}`}
      data-testid={testId}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className={`relative shrink-0 w-[30px] h-[18px] rounded-full transition-colors align-middle disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
        enabled ? 'bg-accent' : 'bg-rule'
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-bg-hi shadow transition-[left] ${enabled ? 'left-[14px]' : 'left-0.5'}`}
      />
    </button>
  )
}
