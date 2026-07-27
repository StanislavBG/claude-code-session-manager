import type { MouseEvent } from 'react'

// Same pattern as MarkdownPreview.tsx's onClick: intercept http(s) link clicks
// and route them through the shell instead of letting will-navigate block them
// silently. In-page (#anchor) and relative links fall through harmlessly.
export function handleChatLinkClick(e: MouseEvent): void {
  const a = (e.target as HTMLElement).closest('a')
  if (!a) return
  const href = a.getAttribute('href') || ''
  if (/^https?:\/\//i.test(href)) {
    e.preventDefault()
    window.api.shell.open({ as: 'external', url: href }).catch(() => { /* ignore */ })
  }
}
