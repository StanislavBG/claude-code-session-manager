import type { MouseEvent } from 'react'
import { useEditor } from '../state/editor'
import { useSessions } from '../state/sessions'
import { toast } from '../state/toast'
import { FILE_LINK_ATTR, resolveFileLinkTarget, isAbsoluteLinkPath, mapGitBashPath, isUnderProject } from './chatFileLinks'

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
 * the given cwd first, then (relative tokens only) each `fallbackCwds` root in
 * order — e.g. an Epic chat passes its live git worktree as `cwd` and the main
 * checkout as the fallback — then other open tabs' cwds.
 */
async function resolveReadableFile(
  raw: string,
  cwd: string,
  fallbackCwds: string[] = [],
): Promise<{ target: ResolvedFile; text: string } | null> {
  const filePath = raw.replace(/(?::\d+)+$/, '')

  const primary = resolveFileLinkTarget(raw, cwd)

  // Security: assistant text is untrusted (it can echo content the model read
  // from anywhere — a fetched URL, a file, prior conversation). Validate the
  // resolved path stays inside the home-scoping boundary before ever opening
  // it in the Editor — reuse files:read's existing assertInsideHome check
  // (files.cjs) rather than re-implementing path validation in the renderer.
  // The same check runs again below for every fallback / cross-tab candidate.
  const primaryRead = await window.api.files.read(primary.absPath)
  if (!primaryRead.ok && primaryRead.error?.startsWith('path outside home') && !isUnderProject(primary.absPath, cwd)) {
    toast.error("That path is outside the project and can't be opened.")
    return null
  }
  if (primaryRead.ok) return { target: primary, text: primaryRead.text }

  let triedFallbacks = 0
  let triedOtherTabs = 0

  // Only relative tokens benefit from another root — an absolute path
  // resolves the same regardless of cwd, so there's nothing to retry.
  if (!isAbsoluteLinkPath(mapGitBashPath(filePath))) {
    const tried = new Set<string>([cwd])
    const tryRoot = async (root: string) => {
      const candidate = resolveFileLinkTarget(raw, root)
      const candidateRead = await window.api.files.read(candidate.absPath)
      // Outside-home or ENOENT — either way this candidate isn't a match.
      return candidateRead.ok ? { target: candidate, text: candidateRead.text } : null
    }

    // Caller-supplied roots first (e.g. the Epic worktree's main checkout).
    for (const root of fallbackCwds) {
      if (!root || tried.has(root)) continue
      tried.add(root)
      triedFallbacks++
      const hit = await tryRoot(root)
      if (hit) return hit
    }

    // A mention like "projectsRegistry.ts" may name a real file that simply
    // lives under a DIFFERENT open tab's cwd than the one the chip was
    // rendered in (the assistant can discuss another project mid-conversation).
    const otherCwds = Array.from(new Set(useSessions.getState().tabs.map((t) => t.cwd)))
    for (const otherCwd of otherCwds) {
      if (!otherCwd || tried.has(otherCwd)) continue
      tried.add(otherCwd)
      triedOtherTabs++
      const hit = await tryRoot(otherCwd)
      if (hit) return hit
    }
  }

  const tabWord = triedOtherTabs === 1 ? 'tab' : 'tabs'
  const fallbackPart = triedFallbacks > 0
    ? `${triedFallbacks} fallback ${triedFallbacks === 1 ? 'root' : 'roots'}, `
    : ''
  toast.error(`${primaryRead.error || 'Not found'} under ${cwd} (tried ${fallbackPart}${triedOtherTabs} other open ${tabWord})`)
  return null
}

/**
 * Opens a linkified file-path token (e.g. "src/foo.ts:42:8") in the Editor.
 * Shared by the inline click handler below and FileCallout's click-to-open
 * (TerminalChat.tsx) so both surfaces validate/resolve identically.
 */
export async function openLinkifiedFilePath(raw: string, cwd = '', fallbackCwds: string[] = []): Promise<void> {
  if (!raw) return
  const resolved = await resolveReadableFile(raw, cwd, fallbackCwds)
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
export async function readLinkifiedFileText(raw: string, cwd = '', fallbackCwds: string[] = []): Promise<string | null> {
  if (!raw) return null
  const resolved = await resolveReadableFile(raw, cwd, fallbackCwds)
  return resolved?.text ?? null
}

export async function handleChatLinkClick(
  e: MouseEvent,
  cwd = '',
  fallbackCwds: string[] = [],
): Promise<void> {
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
  await openLinkifiedFilePath(raw, cwd, fallbackCwds)
}
