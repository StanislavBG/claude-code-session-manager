import type { NavKey } from '../../lib/navKey'
import { LearningPanel } from '../LearningPanel'

/**
 * Almanac section frame — wraps a promoted screen (Settings, Skills, etc.)
 * with a small-caps eyebrow + serif heading + optional intro paragraph.
 *
 * Layout contract: the OUTER container is a vertical flex column that fills
 * the pane (Terminal + AgentView do the same). The optional editorial header
 * is `shrink-0`; the children container is `flex-1 min-h-0` so child
 * components that use `h-full` / `flex-1` (Panel, MarkdownEditor, lists with
 * sticky toolbars) get a real height to lay out against.
 *
 * `frame={false}` lets a screen opt out of the editorial header entirely
 * while still inheriting the consistent padding + flex column.
 *
 * `hideTitle` is the Extensions 3a header (design-mocks/extensions-3a/DESIGN_SPEC.md
 * §1): no h1 (the sidebar already names the page) — eyebrow, an 8px spacer, then
 * the subtitle, with Learn kept top-right. The header drops its bottom padding,
 * so the page's own first row sets the gap below the subtitle.
 */
interface SectionFrameProps {
  eyebrow?: string
  title?: string
  intro?: string
  /** When false, render only padding — no header. */
  frame?: boolean
  /** When set (and a header renders), shows a "Learn" trigger top-right of the header. */
  learnKey?: NavKey
  /** Renders no h1 — an 8px spacer between eyebrow and subtitle instead (the 3a header). */
  hideTitle?: boolean
  children: React.ReactNode
}

export function SectionFrame({ eyebrow, title, intro, frame = true, learnKey, hideTitle = false, children }: SectionFrameProps) {
  const hasHeader = frame && (eyebrow || title || intro)
  return (
    <div className="h-full w-full flex flex-col bg-bg text-fg">
      {hasHeader && (
        <header className={`shrink-0 px-8 pt-7 flex items-start justify-between gap-4 ${hideTitle ? 'pb-0' : 'pb-5'}`}>
          <div className="max-w-[820px]">
            {eyebrow && (
              <div className={`text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-faint${hideTitle ? '' : ' mb-2'}`}>
                {eyebrow}
              </div>
            )}
            {hideTitle ? (
              <div aria-hidden="true" className="h-2" data-testid="section-frame-title-spacer" />
            ) : title && (
              <h1 className="font-serif text-[34px] font-medium leading-[1.1] text-fg m-0">
                {title}
              </h1>
            )}
            {intro && (
              <p className={`text-[14px] text-fg-dim leading-[1.55]${hideTitle ? '' : ' mt-3'}`}>
                {intro}
              </p>
            )}
          </div>
          {learnKey && <LearningPanel active={learnKey} />}
        </header>
      )}
      <div className={`flex-1 min-h-0 ${hasHeader ? 'px-8 pb-7' : 'p-8'}`}>
        {children}
      </div>
    </div>
  )
}
