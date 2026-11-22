/**
 * ConfigBand — the dark band header of the Claude config page, shared by the
 * Home (`~/.claude`) and Project (cwd) scopes. Palette B: this band is the only
 * dark surface on the page; everything below it is paper.
 *
 * Design: session-manager-operations/design-mocks/claude-config/ (DESIGN_SPEC.md §2,
 * ConfigWorkbench.dc.html band markup). Colors are app tokens only — the band's
 * `#2a221a` is `bg-fg` with `text-bg-hi` (DESIGN_SPEC.md §4 token note).
 */
import { useRef, type KeyboardEvent } from 'react'
import { AlmanacIcon, type AlmanacIconName } from '../layout/AlmanacIcon'

export interface ConfigBandTab<K extends string = string> {
  key: K
  label: string
  icon: AlmanacIconName
  /** Mono chip after the label — a number or short text such as `3 files` / `missing`. */
  count?: number | string
  /** Renders the status dot (e.g. an MCP server needs attention). */
  attention?: boolean
  /** Tints the count chip as a warning (e.g. CLAUDE.md `missing`). */
  warn?: boolean
}

export interface ConfigBandProps<K extends string = string> {
  eyebrow: string
  title: string
  scopePath: string
  tabs: ReadonlyArray<ConfigBandTab<K>>
  activeKey: K
  onSelect: (key: K) => void
  /** Called with the query as the user types in "Search all config". */
  onSearch?: (query: string) => void
  /** Called when the LEARN link is pressed. */
  onLearn?: () => void
}

function chipClass(active: boolean, warn: boolean): string {
  if (warn) return active ? 'bg-accent/15 text-accent-dark' : 'bg-accent-muted/15 text-accent-muted'
  return active ? 'bg-fg text-bg-hi' : 'bg-bg/10 text-line'
}

export function ConfigBand<K extends string = string>({
  eyebrow,
  title,
  scopePath,
  tabs,
  activeKey,
  onSelect,
  onSearch,
  onLearn,
}: ConfigBandProps<K>) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    if (next < 0) return
    e.preventDefault()
    tabRefs.current[next]?.focus()
    onSelect(tabs[next].key)
  }

  return (
    <div
      data-testid="config-band"
      className="shrink-0 h-[84px] bg-fg text-bg-hi border-b border-fg px-7 flex items-center gap-[26px] whitespace-nowrap"
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[10.5px] font-semibold tracking-[0.1em] text-bg-hi/60">{eyebrow}</span>
        <span className="flex items-baseline gap-2.5">
          <span className="font-serif text-[25px] font-medium leading-[1.15] text-bg-hi">{title}</span>
          <span className="font-mono text-xs text-rhythm truncate">{scopePath}</span>
        </span>
      </div>

      <div role="tablist" aria-label={title} className="flex items-center gap-1.5">
        {tabs.map((tab, i) => {
          const active = tab.key === activeKey
          return (
            <button
              key={tab.key}
              ref={(el) => { tabRefs.current[i] = el }}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              data-testid={`config-band-tab-${tab.key}`}
              onClick={() => onSelect(tab.key)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
              className={`h-12 flex items-center gap-2.5 pl-[13px] pr-3.5 rounded-xl border border-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-butter ${
                active ? 'bg-bg text-fg shadow-sm' : 'text-bg-elev hover:bg-bg/10'
              }`}
            >
              <AlmanacIcon name={tab.icon} size={18} stroke={1.7} className={active ? 'text-fg' : 'text-rhythm'} />
              <span className="text-[14.5px] font-semibold">{tab.label}</span>
              {tab.count !== undefined && (
                <span
                  data-testid="config-band-count"
                  className={`font-mono text-xs px-[7px] py-0.5 rounded-md ${chipClass(active, !!tab.warn)}`}
                >
                  {tab.count}
                </span>
              )}
              {tab.attention && (
                <span
                  data-testid="config-band-attention"
                  aria-label="needs attention"
                  className="w-[7px] h-[7px] rounded-full bg-butter -ml-1"
                />
              )}
            </button>
          )
        })}
      </div>

      <span className="flex-1" />

      <label className="flex items-center gap-2.5 w-[250px] h-10 px-3 rounded-[10px] bg-bg/[0.08] border border-bg/[0.14] text-[13px] text-bg-hi/60 focus-within:border-bg/30">
        <AlmanacIcon name="search" size={15} className="shrink-0" />
        <input
          type="search"
          aria-label="Search all config"
          placeholder="Search all config"
          onChange={(e) => onSearch?.(e.target.value)}
          className="flex-1 min-w-0 bg-transparent outline-none text-bg-hi placeholder:text-bg-hi/60"
        />
        <kbd className="font-mono text-[11px] px-1.5 py-px rounded border border-bg/20">/</kbd>
      </label>

      <button
        type="button"
        onClick={onLearn}
        className="text-[11px] font-semibold tracking-[0.08em] text-butter hover:underline"
      >
        LEARN
      </button>
    </div>
  )
}
