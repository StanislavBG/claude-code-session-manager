/**
 * Provenance classifier — labels a Skill / MCP server / Plugin / Subagent /
 * Hook as one of three origins so the UI can badge where it came from:
 *
 *   - 'anthropic'  → native Anthropic (built-in command, official catalog
 *                    entry, or an @anthropic-ai / @modelcontextprotocol package
 *                    / anthropics-org repo).
 *   - 'community'  → found on the internet (a known non-official catalog entry,
 *                    or anything carrying external source metadata — a repo /
 *                    homepage / remote URL / published package invocation).
 *   - 'local'      → self-created (a file/config with no external footprint).
 *
 * Nothing in the on-disk config records origin, so this is a best-effort
 * derivation. The result is always overridable per item via the provenance
 * store (sidecar at ~/.claude/session-manager/provenance.json).
 *
 * Pure + synchronous: the lookup sets below are built once at module load from
 * the bundled catalog, so classifyProvenance is O(1) per item.
 */
import {
  CATALOG_MCP,
  CATALOG_SKILLS,
  CATALOG_PLUGINS,
  CATALOG_HOOKS,
  CATALOG_AGENTS,
} from '../data/catalog'

export type Provenance = 'anthropic' | 'community' | 'local'

export type ProvItemType = 'skill' | 'command' | 'mcp' | 'plugin' | 'subagent' | 'hook'

export interface ProvenanceInput {
  type: ProvItemType
  name: string
  /** stdio command (mcp) or the hook's shell command. */
  command?: string
  args?: string[]
  /** remote endpoint (mcp url / http hook url). */
  url?: string
  /** plugin manifest repository, or a catalog source URL. */
  repository?: string
  /** plugin manifest homepage. */
  homepage?: string
}

export interface ProvenanceVerdict {
  provenance: Provenance
  /** short human reason for the auto-classification (tooltip copy). */
  reason: string
}

const lc = (s: string) => (s ?? '').toLowerCase().trim()

// ---- catalog-derived lookup sets (built once) --------------------------------
const mcpOfficial = new Set<string>()
const mcpCommunity = new Set<string>()
for (const m of CATALOG_MCP) {
  const set = m.official ? mcpOfficial : mcpCommunity
  set.add(lc(m.id))
  set.add(lc(m.name))
}
const skillOfficial = new Set(CATALOG_SKILLS.flatMap((s) => [lc(s.id), lc(s.name)]))
const pluginOfficial = new Set(CATALOG_PLUGINS.filter((p) => p.official).flatMap((p) => [lc(p.id), lc(p.name)]))
const pluginCommunity = new Set(CATALOG_PLUGINS.filter((p) => !p.official).flatMap((p) => [lc(p.id), lc(p.name)]))
const agentCatalog = new Set(CATALOG_AGENTS.flatMap((a) => [lc(a.id), lc(a.name)]))
const hookCatalogIds = new Set(CATALOG_HOOKS.flatMap((h) => [lc(h.id), lc(h.name)]))
const hookCatalogCommands = new Set(CATALOG_HOOKS.map((h) => h.command.trim()))

// Anthropic-native built-in slash commands shipped with the Claude Code CLI (or
// its first-party official plugins). Matched by command/skill NAME — a local
// file named e.g. `code-review` is treated as the Anthropic one, which the user
// can override if they actually authored a same-named command.
const BUILTIN_COMMANDS = new Set([
  'init', 'review', 'security-review', 'pr-comments', 'compact', 'release-notes',
  'add-dir', 'agents', 'memory', 'todos', 'config', 'code-review', 'simplify',
  'context', 'cost', 'doctor', 'login', 'logout', 'mcp', 'resume', 'status',
])

// Package / host signatures that mark a thing as coming from Anthropic.
const ANTHROPIC_SIG = /(@anthropic-ai\/|@modelcontextprotocol\/|modelcontextprotocol\/servers|anthropic\.com|github\.com\/anthropics|github\.com\/modelcontextprotocol)/i
// Published-package launchers — a strong "installed from a registry" signal.
const PKG_MANAGER = /(^|\s)(npx|uvx|pipx|bunx|mcp-remote|deno\s+run|docker\s+run)(\s|$)/i

function blobOf(input: ProvenanceInput): string {
  return [input.command, ...(input.args ?? []), input.url, input.repository, input.homepage]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function anthropicReason(input: ProvenanceInput, name: string, blob: string): string | null {
  if (ANTHROPIC_SIG.test(blob)) return 'Anthropic / MCP package or repo'
  switch (input.type) {
    case 'command':
    case 'skill':
      if (BUILTIN_COMMANDS.has(name)) return 'built-in Claude Code command'
      if (skillOfficial.has(name)) return 'official Anthropic skill'
      return null
    case 'mcp':
      return mcpOfficial.has(name) ? 'official MCP server (catalog)' : null
    case 'plugin':
      return pluginOfficial.has(name) ? 'official Anthropic plugin (catalog)' : null
    case 'subagent':
      return agentCatalog.has(name) ? 'bundled Anthropic subagent (catalog)' : null
    case 'hook':
      if (hookCatalogIds.has(name)) return 'bundled hook (catalog)'
      if (input.command && hookCatalogCommands.has(input.command.trim())) return 'bundled hook (catalog)'
      return null
  }
}

function communityReason(input: ProvenanceInput, name: string, blob: string): string | null {
  if (input.type === 'mcp' && mcpCommunity.has(name)) return 'third-party server (catalog)'
  if (input.type === 'plugin' && pluginCommunity.has(name)) return 'third-party plugin (catalog)'
  if (input.repository) return 'has a source repository'
  if (input.homepage) return 'has a homepage'
  if (input.url) return 'remote endpoint'
  if (PKG_MANAGER.test(blob)) return 'installed from a package registry'
  return null
}

/**
 * Best-effort origin for a single item. Order: Anthropic-native first (most
 * specific), then community/internet, else self-created local.
 */
export function classifyProvenance(input: ProvenanceInput): ProvenanceVerdict {
  const name = lc(input.name)
  const blob = blobOf(input)

  const aReason = anthropicReason(input, name, blob)
  if (aReason) return { provenance: 'anthropic', reason: aReason }

  const cReason = communityReason(input, name, blob)
  if (cReason) return { provenance: 'community', reason: cReason }

  return { provenance: 'local', reason: 'no external source — assumed self-created' }
}

/** Stable key for a per-item manual override in the provenance sidecar. */
export function provenanceKey(type: ProvItemType, scope: string | null | undefined, name: string): string {
  return `${type}:${scope ?? '-'}:${name}`
}

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  anthropic: 'Anthropic',
  community: 'Community',
  local: 'Local',
}
