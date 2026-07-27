import type { MouseEvent } from 'react'
import { useEditor } from '../state/editor'
import { toast } from '../state/toast'
import { FILE_LINK_ATTR, resolveFileLinkTarget } from './chatFileLinks'

// Same pattern as MarkdownPreview.tsx's onClick: intercept http(s) link clicks
// and route them through the shell instead of letting will-navigate block them
// silently. In-page (#anchor) and relative links fall through harmlessly.
//
// Also handles clicks on file-path tokens linkified by chatFileLinks.ts's
// post-process pass (bare mentions like "docs/README.md" that `marked` never
// turns into a real <a>). `cwd` resolves relative paths the same way
// Terminal.tsx's xterm link provider does.
export async function handleChatLinkClick(e: MouseEvent, cwd = ''): Promise<void> {
  const target = e.target as HTMLElement
  const a = target.closest('a')
  if (a) {
    const href = a.getAttribute('href') || ''
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault()
      window.api.shell.open({ as: 'external', url: href }).catch(() => { /* ignore */ })
    }
    return
  }

  const fileEl = target.closest(`[${FILE_LINK_ATTR}]`)
  if (!fileEl) return
  const raw = fileEl.getAttribute(FILE_LINK_ATTR) ?? ''
  if (!raw) return
  const { absPath, line, col } = resolveFileLinkTarget(raw, cwd)

  // Security: assistant text is untrusted (it can echo content the model read
  // from anywhere — a fetched URL, a file, prior conversation). Validate the
  // resolved path stays inside the home-scoping boundary before ever opening
  // it in the Editor — reuse files:read's existing assertInsideHome check
  // (files.cjs) rather than re-implementing path validation in the renderer.
  const r = await window.api.files.read(absPath)
  if (!r.ok && r.error === 'path outside home') {
    toast.error("That path is outside the project and can't be opened.")
    return
  }

  useEditor.getState().openFile(absPath, { line, col })
  window.dispatchEvent(new CustomEvent('sm:open-editor'))
}
