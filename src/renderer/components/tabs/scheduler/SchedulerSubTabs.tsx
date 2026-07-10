/**
 * Segmented pill control for the Scheduler tab's Queue / PRDs / History switch.
 * Scheduler-local — do not reuse across other tabs' sub-tab chrome (mirrors
 * the Almanac/Hive "keep design primitives separate" convention).
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

export function SchedulerSubTabs<K extends string>({ options, active, onChange }: Props<K>) {
  return (
    <div className="inline-flex gap-1 bg-bg-hi p-1 rounded-xl shadow-[inset_0_0_0_1px] shadow-line">
      {options.map(({ key, label }) => {
        const isActive = active === key
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={`px-[18px] py-[7px] rounded-[9px] text-[13.5px] transition-colors ${
              isActive
                ? 'bg-bg-elev shadow-[inset_0_0_0_1px] shadow-line font-semibold text-fg'
                : 'font-medium text-fg-dim hover:text-fg'
            }`}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
