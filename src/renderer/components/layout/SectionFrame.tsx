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
 */
interface SectionFrameProps {
  eyebrow?: string
  title?: string
  intro?: string
  /** When false, render only padding — no header. */
  frame?: boolean
  children: React.ReactNode
}

export function SectionFrame({ eyebrow, title, intro, frame = true, children }: SectionFrameProps) {
  const hasHeader = frame && (eyebrow || title || intro)
  return (
    <div className="h-full w-full flex flex-col bg-bg text-fg">
      {hasHeader && (
        <header className="shrink-0 px-8 pt-7 pb-5">
          <div className="max-w-[820px]">
            {eyebrow && (
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-faint mb-2">
                {eyebrow}
              </div>
            )}
            {title && (
              <h1 className="font-serif text-[34px] font-medium leading-[1.1] text-fg m-0">
                {title}
              </h1>
            )}
            {intro && (
              <p className="mt-3 text-[14px] text-fg-dim leading-[1.55]">
                {intro}
              </p>
            )}
          </div>
        </header>
      )}
      <div className={`flex-1 min-h-0 ${hasHeader ? 'px-8 pb-7' : 'p-8'}`}>
        {children}
      </div>
    </div>
  )
}
