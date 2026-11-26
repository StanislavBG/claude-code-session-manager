/**
 * ClaudeConfigShell — the one page template for Home (`~/.claude`) and Project Claude
 * config. A dark vertical rail on the left (title, scope path, search, tabs, LEARN) and,
 * to its right, an optional learn panel above a full-bleed content area. Scope props only.
 * Colors are app tokens only (`bg-fg text-bg-hi` is the dark rail).
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AlmanacIcon } from '../layout/AlmanacIcon'
import { Z } from '../../lib/zLayers'
import { LearningBody } from '../LearningPanel'
import type { LearningContent } from '../learningContent'
import {
  ConfigSearchResults,
  chipClass,
  compactScopePath,
  useConfigSearch,
  type ConfigTabSpec,
} from './configShared'

/** Rail width in px — the `w-[248px]` class below (Tailwind needs the literal; keep in step). */
export const RAIL_W_PX = 248
/** Rail horizontal padding per side in px — the `px-5` class below. */
export const RAIL_PAD_X_PX = 20
/** Scope-path limit: the rail's inner width over the 12px mono advance (0.6em = 7.2px). */
export const RAIL_PATH_MAX_CHARS = Math.floor((RAIL_W_PX - 2 * RAIL_PAD_X_PX) / 7.2)

export interface ClaudeConfigShellProps<K extends string> {
  testId: string
  eyebrow: string
  title: string
  scopePath: string
  tabs: ReadonlyArray<ConfigTabSpec<K>>
  activeKey: K
  onSelect: (k: K) => void
  search: ReturnType<typeof useConfigSearch>
  learn?: LearningContent | null
  children: ReactNode
  drawer?: ReactNode
}

export function ClaudeConfigShell<K extends string>({
  testId,
  eyebrow,
  title,
  scopePath,
  tabs,
  activeKey,
  onSelect,
  search,
  learn,
  children,
  drawer,
}: ClaudeConfigShellProps<K>) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [learnOpen, setLearnOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const { searchQuery, onSearch, onSearchFocus, onSearchKeyDown, searchInputRef } = search.bandProps

  // '/' jumps to the search field unless the user is already typing somewhere.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
      const t = e.target instanceof HTMLElement ? e.target : null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.closest('[contenteditable="true"]'))) return
      if (!searchInputRef.current) return
      e.preventDefault()
      searchInputRef.current.focus()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [searchInputRef])

  const onFieldKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onSearch('')
      e.currentTarget.blur()
      return
    }
    onSearchKeyDown(e)
  }

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1
    if (e.key === 'ArrowDown') next = (index + 1) % tabs.length
    else if (e.key === 'ArrowUp') next = (index - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    if (next < 0) return
    e.preventDefault()
    tabRefs.current[next]?.focus()
    onSelect(tabs[next].key)
  }

  const showPanel = focused && searchQuery.trim() !== ''

  return (
    <div data-testid={testId} className="h-full w-full flex bg-bg text-fg">
      <nav
        data-testid="config-rail"
        className="w-[248px] shrink-0 h-full overflow-y-auto bg-fg text-bg-hi px-5 py-6 flex flex-col gap-4"
      >
        <div className="flex flex-col gap-1">
          <span className="text-[10.5px] font-semibold tracking-[0.1em] text-bg-hi/60">{eyebrow}</span>
          <span className="font-serif text-[22px] font-medium leading-[1.15] text-bg-hi">{title}</span>
          <span
            data-testid="config-rail-path"
            title={scopePath}
            className="block font-mono text-xs text-rhythm whitespace-nowrap"
          >
            {compactScopePath(scopePath, RAIL_PATH_MAX_CHARS)}
          </span>
        </div>

        <div className="relative">
          <label className="flex items-center gap-2.5 w-full h-10 px-3 rounded-[10px] bg-bg/[0.08] border border-bg/[0.14] text-[13px] text-bg-hi/60 focus-within:border-bg/30">
            <AlmanacIcon name="search" size={15} className="shrink-0" />
            <input
              ref={searchInputRef}
              type="search"
              aria-label="Search all config"
              placeholder="Search all config"
              value={searchQuery}
              onChange={(e) => onSearch(e.target.value)}
              onFocus={() => { setFocused(true); onSearchFocus() }}
              onBlur={() => setFocused(false)}
              onKeyDown={onFieldKeyDown}
              className="flex-1 min-w-0 bg-transparent outline-none text-bg-hi placeholder:text-bg-hi/60"
            />
            <kbd className="font-mono text-[11px] px-1.5 py-px rounded border border-bg/20">/</kbd>
          </label>
          {showPanel && (
            <div
              data-testid="config-search-panel"
              // Keep focus in the field while a row is pressed, so the click still lands.
              onMouseDown={(e) => e.preventDefault()}
              className={`absolute left-full top-0 ml-2 w-[380px] max-h-[60vh] overflow-y-auto rounded-xl border border-line bg-bg-hi text-fg shadow-lg whitespace-normal ${Z.dialog}`}
            >
              <ConfigSearchResults {...search.panelProps} tabs={tabs} />
            </div>
          )}
        </div>

        <div role="tablist" aria-orientation="vertical" aria-label={title} className="flex flex-col gap-1">
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
                data-testid={`config-rail-tab-${tab.key}`}
                onClick={() => onSelect(tab.key)}
                onKeyDown={(e) => onTabKeyDown(e, i)}
                className={`w-full h-10 flex items-center gap-2.5 px-3 rounded-xl border border-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-butter ${
                  active ? 'bg-bg text-fg shadow-sm' : 'text-bg-elev hover:bg-bg/10'
                }`}
              >
                <AlmanacIcon name={tab.icon} size={18} stroke={1.7} className={active ? 'text-fg' : 'text-rhythm'} />
                <span className="flex-1 truncate text-left text-[14px] font-semibold">{tab.label}</span>
                {tab.count !== undefined && (
                  <span
                    data-testid="config-rail-count"
                    className={`font-mono text-xs px-[7px] py-0.5 rounded-md ${chipClass(active, !!tab.warn)}`}
                  >
                    {tab.count}
                  </span>
                )}
                {tab.attention && (
                  <span
                    data-testid="config-rail-attention"
                    aria-label="needs attention"
                    className="w-[7px] h-[7px] rounded-full bg-butter"
                  />
                )}
              </button>
            )
          })}
        </div>

        <div className="mt-auto pt-2">
          <button
            type="button"
            onClick={() => setLearnOpen((v) => !v)}
            className="text-[11px] font-semibold tracking-[0.08em] text-butter hover:underline"
          >
            LEARN
          </button>
        </div>
      </nav>

      <div className="flex-1 min-w-0 h-full flex flex-col">
        {learnOpen && learn && (
          <div
            data-testid={`${testId}-learn`}
            className="shrink-0 border-b border-line bg-bg-elev px-7 py-4 max-h-[40vh] overflow-y-auto"
          >
            <LearningBody content={learn} />
          </div>
        )}
        <div className="flex-1 min-h-0" data-testid={`${testId}-panel-${activeKey}`}>
          {children}
        </div>
        {drawer}
      </div>
    </div>
  )
}
