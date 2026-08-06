import type { ReactNode } from 'react'
import { Z } from '../../lib/zLayers'
import { useState } from 'react'

interface Props {
  content: ReactNode
  children: ReactNode
  /** Side of the trigger to anchor on. Defaults to 'bottom-right' since
   *  these tooltips are mostly used on right-aligned header buttons where
   *  centering would clip past the window edge. */
  align?: 'bottom-right' | 'bottom-center'
}

/** Visible-on-hover tooltip — appears immediately, themed to match the
 *  rest of the UI. Native `title` attributes are too subtle on dense
 *  headers; this complements them. Keep `title` on the trigger so screen
 *  readers and keyboard-only users still get the description. */
export function Tooltip({ content, children, align = 'bottom-right' }: Props) {
  const [visible, setVisible] = useState(false)
  const positionClasses = align === 'bottom-right'
    ? 'top-full mt-1 right-0'
    : 'top-full mt-1 left-1/2 -translate-x-1/2'
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      {visible && (
        <span
          role="tooltip"
          className={`absolute ${Z.dialog} ${positionClasses} px-2 py-1 text-[10px] leading-snug text-fg bg-bg-elev border border-line rounded shadow-lg max-w-[18rem] whitespace-normal pointer-events-none`}
        >
          {content}
        </span>
      )}
    </span>
  )
}
