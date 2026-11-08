import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'

/**
 * Folder-shaped tab row (Home ▸ Extensions 3a, DESIGN_SPEC §1). The active tab is a taller
 * "folder" whose bottom border is the panel-band color, so it opens into the panel below.
 * The caller places it directly above that panel in a wrapper with `-mb-px relative z-[1]`
 * so the row sits 1px over the panel's top border.
 *
 * Not ViewTabs — that is the small pill toggle the scope-editor pages share; leave it alone.
 * Selection follows focus: ArrowLeft/ArrowRight wrap around, with a roving tabIndex.
 */

export interface FolderTabOption<K extends string> {
  key: K
  label: string
  /** Shown beside the label only when it is a number (0 included); null/absent hides it. */
  count?: number | null
}

interface Props<K extends string> {
  options: ReadonlyArray<FolderTabOption<K>>
  active: K
  onChange: (k: K) => void
  ariaLabel: string
  /** Right-aligned content after the tabs (e.g. the active tab's source files). */
  trailing?: ReactNode
}

// Whole literal class strings only — Tailwind JIT cannot see interpolated names.
const ACTIVE_TAB =
  'flex items-center gap-[9px] px-5 whitespace-nowrap cursor-default h-[41px] bg-bg-elev border border-accent border-t-2 border-b-bg-elev rounded-t-[9px] text-[14.5px] font-semibold text-fg'
const INACTIVE_TAB =
  'flex items-center gap-[9px] px-5 whitespace-nowrap cursor-pointer h-[38px] border border-b-0 border-transparent rounded-t-[9px] text-[14.5px] font-medium text-fg-dim hover:bg-bg-elev hover:border-line hover:text-fg'
const ACTIVE_COUNT = 'font-mono text-[11px] font-semibold text-accent'
const INACTIVE_COUNT = 'font-mono text-[11px] font-medium text-fg-faint'

export function FolderTabs<K extends string>({ options, active, onChange, ariaLabel, trailing }: Props<K>) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  // Roving tabIndex: the active tab is the row's single Tab stop. If `active` matches no
  // option, the first tab takes it so the row stays keyboard-reachable.
  const tabStop = Math.max(0, options.findIndex((o) => o.key === active))

  const select = (key: K) => {
    if (key !== active) onChange(key)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = (index + (e.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length
    tabRefs.current[next]?.focus()
    select(options[next].key)
  }

  return (
    <div className="flex items-end gap-0.5">
      <div role="tablist" aria-label={ariaLabel} className="flex flex-none items-end gap-0.5">
        {options.map(({ key, label, count }, i) => {
          const isActive = key === active
          return (
            <button
              key={key}
              ref={(el) => {
                tabRefs.current[i] = el
              }}
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={i === tabStop ? 0 : -1}
              data-testid={`folder-tab-${key}`}
              onClick={() => select(key)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={isActive ? ACTIVE_TAB : INACTIVE_TAB}
            >
              {label}
              {typeof count === 'number' && (
                <span data-testid={`folder-tab-count-${key}`} className={isActive ? ACTIVE_COUNT : INACTIVE_COUNT}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {trailing != null && <div className="ml-auto self-center min-w-0">{trailing}</div>}
    </div>
  )
}
