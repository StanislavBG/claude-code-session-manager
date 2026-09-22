import { useCallback, useEffect, useRef, useState } from 'react'
import type { NavKey } from '../lib/navKey'
import { useUiChromePrefs } from '../state/uiChromePrefs'
import { LEARNING_CONTENT, type LearningContent } from './learningContent'

/** The Learn popover's content — shared with the Scheduler's title-band ⓘ popover. */
export function LearningBody({ content }: { content: LearningContent }) {
  return (
    <>
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
    </>
  )
}

export function LearningPanel({ active }: { active: NavKey }) {
  const learningPanelCollapsed = useUiChromePrefs((s) => s.learningPanelCollapsed)
  const setLearningPanelCollapsed = useUiChromePrefs((s) => s.setLearningPanelCollapsed)
  const hydrated = useUiChromePrefs((s) => s.hydrated)
  const hydrate = useUiChromePrefs((s) => s.hydrate)
  useEffect(() => {
    if (!hydrated) hydrate()
  }, [hydrated, hydrate])

  // `collapsed` boolean logic inverted: open = !collapsed. First paint uses
  // the store's synchronous default (false → open); once hydrate() resolves
  // the persisted value, this re-syncs from disk (one-frame flash accepted,
  // same tradeoff epicsPrefs.ts takes elsewhere).
  const [open, setOpen] = useState<boolean>(() => !learningPanelCollapsed)
  const rootRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (hydrated) setOpen(!learningPanelCollapsed)
    // Only re-sync when hydration resolves — afterwards `open` is owned
    // locally by toggle()/outside-click, which also persist to the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated])

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev
      setLearningPanelCollapsed(!next)
      return next
    })
  }, [setLearningPanelCollapsed])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false)
        setLearningPanelCollapsed(true)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open, setLearningPanelCollapsed])

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
          <LearningBody content={content} />
        </div>
      )}
    </span>
  )
}
