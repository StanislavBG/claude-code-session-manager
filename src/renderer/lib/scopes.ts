/**
 * Scope resolution for Claude Code config files.
 *
 * Each config surface has a set of scopes it supports, each resolving to an
 * absolute path. Precedence (applied at read-time, not here): Managed > CLI >
 * Local > Project > User.
 */

export type Scope = 'user' | 'project' | 'local'

export interface ScopePath {
  scope: Scope
  path: string
  /** Human label for the UI. */
  label: string
  /** Where it lives, for tooltips. */
  hint: string
}

/** Expand `~` at the start of a path using the provided home dir. */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return `${home}/${p.slice(2)}`
  return p
}

export interface ScopeSpec {
  /** Which scopes this config supports. */
  scopes: Scope[]
  /** Resolve scope → absolute path. cwd may be null if no tab is active. */
  resolve: (scope: Scope, home: string, cwd: string | null) => string | null
}

/** Join path segments without needing node's `path` in the renderer. */
function join(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .join('/')
}

export const SETTINGS_SCOPES: ScopeSpec = {
  scopes: ['user', 'project', 'local'],
  resolve: (scope, home, cwd) => {
    if (scope === 'user') return join(home, '.claude', 'settings.json')
    if (!cwd) return null
    if (scope === 'project') return join(cwd, '.claude', 'settings.json')
    return join(cwd, '.claude', 'settings.local.json')
  },
}

export const CLAUDE_MD_SCOPES: ScopeSpec = {
  scopes: ['user', 'project', 'local'],
  resolve: (scope, home, cwd) => {
    if (scope === 'user') return join(home, '.claude', 'CLAUDE.md')
    if (!cwd) return null
    if (scope === 'project') return join(cwd, 'CLAUDE.md')
    return join(cwd, 'CLAUDE.local.md')
  },
}

/**
 * Permissions live inside settings.json under the `permissions` key — there is
 * no separate file. The Permissions tab edits the same files as Settings but
 * through a structured UI over that one subtree.
 */
export const PERMISSIONS_SCOPES: ScopeSpec = SETTINGS_SCOPES

export const SCOPE_LABELS: Record<Scope, { label: string; hint: string }> = {
  user: { label: 'User', hint: '~/.claude/ — applies to all projects' },
  project: { label: 'Project', hint: '<cwd>/.claude/ — checked into git' },
  local: { label: 'Local', hint: '<cwd>/.claude/…local — gitignored, per-machine' },
}
