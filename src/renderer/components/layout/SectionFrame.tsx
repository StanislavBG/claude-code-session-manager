/**
 * Almanac section frame — wraps a promoted screen (Settings, Skills, etc.)
 * with a small-caps eyebrow + serif heading + optional intro paragraph.
 * Keeps the editorial rhythm of the Home page across every full-page screen
 * so promoted-from-modal tabs don't look like loose, decapitated content.
 *
 * Most inner tab components render their own inner chrome (toolbar, list).
 * `frame={false}` lets them opt out of the editorial header entirely while
 * still inheriting the max-width + padding so they don't bleed edge-to-edge.
 */
interface SectionFrameProps {
  eyebrow?: string
  title?: string
  intro?: string
  /** When false, render only padding + max-width container — no header. */
  frame?: boolean
  children: React.ReactNode
}

export function SectionFrame({ eyebrow, title, intro, frame = true, children }: SectionFrameProps) {
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1100px] px-10 py-9 text-fg">
        {frame && (eyebrow || title || intro) && (
          <header className="mb-7">
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
              <p className="mt-3 text-[14px] text-fg-dim max-w-[640px] leading-[1.55]">
                {intro}
              </p>
            )}
          </header>
        )}
        {children}
      </div>
    </div>
  )
}
