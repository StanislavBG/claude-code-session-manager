/**
 * "Reveal in File Explorer" — the app's own File Explorer page (NavKey
 * 'projects'), not the OS file manager.
 *
 * `revealInFileExplorer` opens that page through the layout store's
 * openPanel / usePanelTabHint channel with a `reveal:<absPath>` hint.
 * ProjectsWorkspace consumes the hint: it picks the File Explorer root that
 * contains the path (the active face's root first, then the other face's),
 * and FileTree expands the folders down to it, selects it and scrolls it into
 * view. A path outside every root the File Explorer can show falls back to the
 * OS file manager (`shell.open({ as: 'revealPath' })`) — never a silent no-op.
 */
import { useLayout } from '../state/layout'

export const REVEAL_HINT_PREFIX = 'reveal:'

export function revealInFileExplorer(absPath: string): void {
  useLayout.getState().openPanel('projects', REVEAL_HINT_PREFIX + absPath)
}

/** The path a `reveal:<path>` hint carries, or null for any other hint. */
export function parseRevealHint(hint: string): string | null {
  if (!hint.startsWith(REVEAL_HINT_PREFIX)) return null
  return hint.slice(REVEAL_HINT_PREFIX.length) || null
}

const DRIVE = /^[A-Za-z]:$/

/** `p` with '/' separators, no empty / '.' segments, '..' resolved, no trailing separator. */
function normalize(p: string): string {
  const s = p.replace(/\\/g, '/')
  const out: string[] = []
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      // Never climb above the root ('/' or a drive letter).
      if (out.length > (DRIVE.test(out[0] ?? '') ? 1 : 0)) out.pop()
      continue
    }
    out.push(seg)
  }
  return (s.startsWith('/') ? '/' : '') + out.join('/')
}

/**
 * Segments of `path` below `root` — [] when they are the same folder, null when
 * `path` is not inside `root`. Separator-insensitive ('/' and '\\').
 */
export function relativeSegments(path: string, root: string): string[] | null {
  const p = normalize(path)
  const r = normalize(root)
  if (p === r) return []
  const prefix = r.endsWith('/') ? r : `${r}/`
  if (!p.startsWith(prefix)) return null
  return p.slice(prefix.length).split('/')
}
