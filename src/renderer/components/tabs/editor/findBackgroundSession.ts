/**
 * Pure selectors backing the "resume a background chat session" doc-edit path
 * (PRD 680). No IO — both functions take already-fetched store state.
 */

import type { SessionTab } from '../../../state/sessions'

/**
 * Resolve the "project cwd" for an open file. The app has no existing
 * file→project-root resolution to reuse (checked EditorView.tsx and the
 * Files sidebar — neither tracks one), so this is a pragmatic stand-in:
 * the longest tab `cwd` that is a prefix of `path`, on the assumption that
 * a project's session tabs are launched at or below its root. Returns null
 * when no tab's cwd prefixes the path at all.
 */
export function resolveProjectCwd(path: string, tabs: SessionTab[]): string | null {
  let best: string | null = null
  for (const tab of tabs) {
    const cwd = tab.cwd
    if (!cwd) continue
    const matches = path === cwd || path.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`)
    if (!matches) continue
    if (best === null || cwd.length > best.length) best = cwd
  }
  return best
}

/**
 * Pick the single best dormant tab for the given project cwd to append a
 * silent, resumed doc-edit turn onto: the dormant tab (no live pty attached)
 * with the most recent transcript activity. Ties keep the first tab in
 * array order. Returns null when no dormant tab matches the cwd.
 */
export function findBackgroundSession(
  targetCwd: string,
  tabs: SessionTab[],
  liveTabs: Record<string, { lastEventAt?: number }>,
): SessionTab | null {
  let best: SessionTab | null = null
  let bestLastEventAt = -Infinity
  for (const tab of tabs) {
    if (tab.cwd !== targetCwd || tab.status !== 'dormant') continue
    const lastEventAt = liveTabs[tab.id]?.lastEventAt ?? 0
    if (best === null || lastEventAt > bestLastEventAt) {
      best = tab
      bestLastEventAt = lastEventAt
    }
  }
  return best
}
