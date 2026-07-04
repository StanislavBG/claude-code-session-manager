import { useCallback, useEffect, useRef, useState } from 'react'
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
  // `collapsed` boolean logic inverted: open = !collapsed.
  const [open, setOpen] = useState<boolean>(() => !loadCollapsed())
  const rootRef = useRef<HTMLSpanElement | null>(null)

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev
      saveCollapsed(!next)
      return next
    })
  }, [])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return
      setOpen(!loadCollapsed())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false)
        saveCollapsed(true)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  // Close on tab change (skip the initial mount so persisted state still applies).
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    setOpen(false)
  }, [active])

  const content: LearningContent | undefined = LEARNING_CONTENT[active]
  if (!content) return null

  return (
    <span ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={toggle}
        className="text-[10px] uppercase tracking-wider text-accent font-medium hover:opacity-80 transition-opacity"
        aria-expanded={open}
        title={open ? 'Close learning panel' : 'What is this?'}
      >
        Learn
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-96 max-h-[70vh] overflow-y-auto rounded border border-line bg-bg-elev shadow-lg px-4 pb-4 pt-3 text-left">
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
    </span>
  )
}
