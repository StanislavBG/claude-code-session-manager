import type { MouseEvent } from 'react'
import { useEditor } from '../state/editor'
import { useSessions } from '../state/sessions'
import { useBrowserState } from '../state/browser'
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
type ResolvedFile = ReturnType<typeof resolveFileLinkTarget>

/**
 * Resolves a linkified file-path token to an actually-existing file, reading
 * its text along the way — shared by openLinkifiedFilePath (opens in the
 * Editor) and readLinkifiedFileText (read-only, for inline preview). Tries
 * the given cwd first, then falls back to other open tabs' cwds for a
 * relative token, exactly as before this was split out.
 */
async function resolveReadableFile(
  raw: string,
  cwd: string,
): Promise<{ target: ResolvedFile; text: string } | null> {
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
    return null
  }
  if (primaryRead.ok) return { target: primary, text: primaryRead.text }

  let triedOtherTabs = 0

  // A mention like "projectsRegistry.ts" may name a real file that simply
  // lives under a DIFFERENT open tab's cwd than the one the chip was rendered
  // in (the assistant can discuss another project mid-conversation). Only
  // relative tokens benefit — an absolute path resolves the same regardless
  // of cwd, so there's nothing to retry.
  if (!filePath.startsWith('/')) {
    const otherCwds = Array.from(
      new Set(useSessions.getState().tabs.map((t) => t.cwd).filter((c) => c && c !== cwd)),
    )
    for (const otherCwd of otherCwds) {
      const candidate = resolveFileLinkTarget(raw, otherCwd)
      const candidateRead = await window.api.files.read(candidate.absPath)
      triedOtherTabs++
      if (candidateRead.ok) return { target: candidate, text: candidateRead.text }
      // Outside-home or ENOENT — either way this candidate isn't a match;
      // move on to the next open tab's cwd.
    }
  }

  const tabWord = triedOtherTabs === 1 ? 'tab' : 'tabs'
  toast.error(`${primaryRead.error || 'Not found'} under ${cwd} (tried ${triedOtherTabs} other open ${tabWord})`)
  return null
}

/**
 * Opens a linkified file-path token (e.g. "src/foo.ts:42:8") in the Editor.
 * Shared by the inline click handler below and FileCallout's click-to-open
 * (TerminalChat.tsx) so both surfaces validate/resolve identically.
 */
export async function openLinkifiedFilePath(raw: string, cwd = ''): Promise<void> {
  if (!raw) return
  const resolved = await resolveReadableFile(raw, cwd)
  if (!resolved) return
  useEditor.getState().openFile(resolved.target.absPath, { line: resolved.target.line, col: resolved.target.col })
  window.dispatchEvent(new CustomEvent('sm:open-editor'))
}

/**
 * Read-only counterpart to openLinkifiedFilePath — resolves + reads the same
 * way, but returns the file's text instead of opening a full Editor tab.
 * Used by PromptSessionConversation's inline reference preview (PRD 805),
 * which renders the result through MarkdownPreview rather than navigating
 * away from the scoped conversation.
 */
export async function readLinkifiedFileText(raw: string, cwd = ''): Promise<string | null> {
  if (!raw) return null
  const resolved = await resolveReadableFile(raw, cwd)
  return resolved?.text ?? null
}

/**
 * Opens a URL in the embedded Browser (state/browser.ts) instead of the OS
 * browser, then switches the app to the Browser screen — the same 'sm:navigate'
 * plumbing AlmanacFooter/TerminalChat use for cross-screen navigation, and the
 * same openTab() call Browser.tsx itself uses for a new sub-tab. Used by
 * PromptSessionConversation (PRD 805) so links clicked from the scoped
 * conversation stay inside the app rather than shelling out via
 * shell.openExternal.
 */
export function openUrlInBrowserTab(url: string): void {
  useBrowserState.getState().openTab({ url })
  window.dispatchEvent(new CustomEvent('sm:navigate', { detail: 'browser' }))
}

export async function handleChatLinkClick(
  e: MouseEvent,
  cwd = '',
  linkTarget: 'external' | 'browser' = 'external',
): Promise<void> {
  const target = e.target as HTMLElement
  const a = target.closest('a')
  if (a) {
    const href = a.getAttribute('href') || ''
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault()
      if (linkTarget === 'browser') {
        openUrlInBrowserTab(href)
      } else {
        window.api.shell.open({ as: 'external', url: href }).catch(() => { /* ignore */ })
      }
    }
    return
  }

  const fileEl = target.closest(`[${FILE_LINK_ATTR}]`)
  if (!fileEl) return
  const raw = fileEl.getAttribute(FILE_LINK_ATTR) ?? ''
  await openLinkifiedFilePath(raw, cwd)
}
