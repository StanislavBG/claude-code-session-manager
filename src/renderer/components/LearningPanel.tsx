import { useCallback, useEffect, useState } from 'react'
import type { NavKey } from './LeftNav'
import { LEARNING_CONTENT, type LearningContent } from './learningContent'

const STORAGE_KEY = 'sm.learningPanel.collapsed'

/** Per-tab collapse state, persisted to localStorage. New users see the panel
 *  expanded by default the first time they visit each tab; once collapsed it
 *  stays collapsed for that tab until they expand it again. */
function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function saveCollapsed(state: Record<string, boolean>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* */ }
}

export function LearningPanel({ active }: { active: NavKey }) {
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>(() => loadCollapsed())

  const collapsed = collapsedMap[active] ?? false

  const toggle = useCallback(() => {
    setCollapsedMap((prev) => {
      const next = { ...prev, [active]: !(prev[active] ?? false) }
      saveCollapsed(next)
      return next
    })
  }, [active])

  // Cross-tab sync: if another window updates the same key, mirror it here.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return
      setCollapsedMap(loadCollapsed())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const content: LearningContent | undefined = LEARNING_CONTENT[active]
  if (!content) return null

  return (
    <section
      className="shrink-0 border-b border-line bg-bg-elev"
      aria-label="learning panel"
    >
      <button
        type="button"
        onClick={toggle}
        className="w-full px-4 py-1.5 flex items-center gap-2 text-left hover:bg-bg-hi transition-colors"
        aria-expanded={!collapsed}
        title={collapsed ? 'Expand learning panel' : 'Collapse learning panel'}
      >
        <span className="text-[10px] uppercase tracking-wider text-accent font-medium">
          Learn
        </span>
        <span className="text-xs text-fg-dim truncate">{content.headline}</span>
        <div className="flex-1" />
        <span className="text-fg-faint text-xs">{collapsed ? '▸ expand' : '▾ collapse'}</span>
      </button>
      {!collapsed && (
        <div className="px-4 pb-4 pt-1 max-w-4xl">
          <p className="text-xs text-fg-dim leading-relaxed mb-3">{content.intro}</p>
          {content.sections.map((sec) => (
            <div key={sec.title} className="mb-3 last:mb-0">
              <h3 className="text-[11px] uppercase tracking-wider text-fg font-medium mb-1">
                {sec.title}
              </h3>
              <ul className="space-y-1">
                {sec.items.map((item, i) => (
                  <li key={i} className="text-xs text-fg-dim leading-relaxed">
                    {item.term && (
                      <span className="text-fg font-medium">{item.term}</span>
                    )}
                    {item.term && ' — '}
                    <span>{item.body}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {content.tips && content.tips.length > 0 && (
            <div className="mt-3 pt-3 border-t border-line">
              <h3 className="text-[11px] uppercase tracking-wider text-fg-dim font-medium mb-1">
                Tips
              </h3>
              <ul className="space-y-1">
                {content.tips.map((tip, i) => (
                  <li key={i} className="text-xs text-fg-faint leading-relaxed">
                    • {tip}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
