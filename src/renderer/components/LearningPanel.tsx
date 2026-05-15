import { useCallback, useEffect, useState } from 'react'
import type { NavKey } from './LeftNav'
import { LEARNING_CONTENT, type LearningContent } from './learningContent'

const STORAGE_KEY = 'sm.learningPanel.collapsed'

function loadCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return false
    // Legacy: was a per-tab JSON map. Migrate "any tab collapsed" → globally collapsed.
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw)
      return !!(parsed && typeof parsed === 'object' && Object.values(parsed).some(Boolean))
    }
    return raw === '1' || raw === 'true'
  } catch {
    return false
  }
}

function saveCollapsed(collapsed: boolean) {
  try { localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0') } catch { /* */ }
}

export function LearningPanel({ active }: { active: NavKey }) {
  const [collapsed, setCollapsed] = useState<boolean>(() => loadCollapsed())

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      saveCollapsed(next)
      return next
    })
  }, [])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return
      setCollapsed(loadCollapsed())
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
