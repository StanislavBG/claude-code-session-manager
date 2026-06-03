/**
 * EditorStatusBar — bottom strip with Google-Docs-style document metrics:
 * word / character count + reading time (derived from the buffer), and, when a
 * Monaco cursor is active, line:col + selection length. Cheap: counts are a
 * single O(n) pass memoized on the buffer string.
 */

import { useMemo } from 'react'

interface CursorInfo {
  line: number
  col: number
  selected: number
}

interface Props {
  text: string
  cursor: CursorInfo | null
  language?: string
}

const WPM = 200

function countWords(s: string): number {
  const m = s.trim()
  if (!m) return 0
  return m.split(/\s+/).length
}

export function EditorStatusBar({ text, cursor, language }: Props) {
  const { words, chars, mins } = useMemo(() => {
    const words = countWords(text)
    return { words, chars: text.length, mins: Math.max(1, Math.ceil(words / WPM)) }
  }, [text])

  return (
    <div className="flex items-center gap-3 px-3 h-6 shrink-0 border-t border-line bg-bg-elev text-[10px] text-fg-faint">
      <span>{words.toLocaleString()} words</span>
      <span>{chars.toLocaleString()} chars</span>
      {words > 0 && <span>{mins} min read</span>}
      <div className="flex-1" />
      {cursor && (
        <>
          {cursor.selected > 0 && <span>{cursor.selected.toLocaleString()} selected</span>}
          <span>Ln {cursor.line}, Col {cursor.col}</span>
        </>
      )}
      {language && <span className="uppercase">{language}</span>}
    </div>
  )
}
