import type { MouseEvent } from 'react'
import { useEditor } from '../state/editor'
import { useSessions } from '../state/sessions'
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
/**
 * Opens a linkified file-path token (e.g. "src/foo.ts:42:8") in the Editor.
 * Shared by the inline click handler below and FileCallout's click-to-open
 * (TerminalChat.tsx) so both surfaces validate/resolve identically.
 */
export async function openLinkifiedFilePath(raw: string, cwd = ''): Promise<void> {
  if (!raw) return
  const filePath = raw.replace(/(?::\d+)+$/, '')

  const primary = resolveFileLinkTarget(raw, cwd)

  // Security: assistant text is untrusted (it can echo content the model read
  // from anywhere — a fetched URL, a file, prior conversation). Validate the
  // resolved path stays inside the home-scoping boundary before ever opening
  // it in the Editor — reuse files:read's existing assertInsideHome check
  // (files.cjs) rather than re-implementing path validation in the renderer.
  // The same check runs again below for every cross-tab fallback candidate.
  const primaryRead = await window.api.files.read(primary.absPath)
  if (!primaryRead.ok && primaryRead.error === 'path outside home') {
    toast.error("That path is outside the project and can't be opened.")
    return
  }

  let target = primaryRead.ok ? primary : null
  let triedOtherTabs = 0

  // A mention like "projectsRegistry.ts" may name a real file that simply
  // lives under a DIFFERENT open tab's cwd than the one the chip was rendered
  // in (the assistant can discuss another project mid-conversation). Only
  // relative tokens benefit — an absolute path resolves the same regardless
  // of cwd, so there's nothing to retry.
  if (!target && !filePath.startsWith('/')) {
    const otherCwds = Array.from(
      new Set(useSessions.getState().tabs.map((t) => t.cwd).filter((c) => c && c !== cwd)),
    )
    for (const otherCwd of otherCwds) {
      const candidate = resolveFileLinkTarget(raw, otherCwd)
      const candidateRead = await window.api.files.read(candidate.absPath)
      triedOtherTabs++
      if (candidateRead.ok) {
        target = candidate
        break
      }
      // Outside-home or ENOENT — either way this candidate isn't a match;
      // move on to the next open tab's cwd.
    }
  }

  if (!target) {
    const tabWord = triedOtherTabs === 1 ? 'tab' : 'tabs'
    toast.error(`${primaryRead.error || 'Not found'} under ${cwd} (tried ${triedOtherTabs} other open ${tabWord})`)
    return
  }

  useEditor.getState().openFile(target.absPath, { line: target.line, col: target.col })
  window.dispatchEvent(new CustomEvent('sm:open-editor'))
}

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
  await openLinkifiedFilePath(raw, cwd)
}
