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
// Catalog skills carry an `official` flag — split it (the 'local' template
// skills are official:false and must NOT read as Anthropic).
const skillOfficial = new Set(CATALOG_SKILLS.filter((s) => s.official).flatMap((s) => [lc(s.id), lc(s.name)]))
const skillCommunity = new Set(CATALOG_SKILLS.filter((s) => !s.official).flatMap((s) => [lc(s.id), lc(s.name)]))
const pluginOfficial = new Set(CATALOG_PLUGINS.filter((p) => p.official).flatMap((p) => [lc(p.id), lc(p.name)]))
const pluginCommunity = new Set(CATALOG_PLUGINS.filter((p) => !p.official).flatMap((p) => [lc(p.id), lc(p.name)]))
const agentCatalog = new Set(CATALOG_AGENTS.flatMap((a) => [lc(a.id), lc(a.name)]))
const hookCatalogIds = new Set(CATALOG_HOOKS.flatMap((h) => [lc(h.id), lc(h.name)]))
const hookCatalogCommands = new Set(CATALOG_HOOKS.map((h) => h.command.trim()))

// Anthropic-native built-in slash command names. Deliberately conservative:
// only distinctive, hyphenated Claude Code command names that are unlikely to
// collide with a user-authored command/skill. Generic single words (memory,
// config, review, status, …) are intentionally excluded — they'd false-positive
// on plausible local files. Matched by NAME; the user can override either way.
const BUILTIN_COMMANDS = new Set([
  'security-review', 'pr-comments', 'release-notes', 'add-dir', 'code-review', 'simplify',
])

// Host / package signatures unique to Anthropic. NOTE: @modelcontextprotocol is
// intentionally NOT here — that org ships community + archived servers too, so
// the curated catalog (which knows official vs not) is the authority for MCP.
const ANTHROPIC_SIG = /(@anthropic-ai\/|anthropic\.com|github\.com\/anthropics)/i
// Published-package launchers — a strong "installed from a registry" signal.
const PKG_MANAGER = /(^|\s)(npx|uvx|pipx|bunx|mcp-remote|deno\s+run|docker\s+run)(\s|$)/i

function blobOf(input: ProvenanceInput): string {
  return [input.command, ...(input.args ?? []), input.url, input.repository, input.homepage]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

const A = (reason: string): ProvenanceVerdict => ({ provenance: 'anthropic', reason })
const C = (reason: string): ProvenanceVerdict => ({ provenance: 'community', reason })

// The curated catalog is authoritative: a known entry's official flag wins over
// every heuristic (so an official:false server launched via an @-scoped package
// stays Community, and an official one stays Anthropic).
function catalogVerdict(type: ProvItemType, name: string, command?: string): ProvenanceVerdict | null {
  switch (type) {
    case 'mcp':
      if (mcpOfficial.has(name)) return A('official MCP server (catalog)')
      if (mcpCommunity.has(name)) return C('third-party server (catalog)')
      return null
    case 'skill':
    case 'command':
      if (skillOfficial.has(name)) return A('official Anthropic skill (catalog)')
      if (skillCommunity.has(name)) return C('third-party skill (catalog)')
      return null
    case 'plugin':
      if (pluginOfficial.has(name)) return A('official Anthropic plugin (catalog)')
      if (pluginCommunity.has(name)) return C('third-party plugin (catalog)')
      return null
    case 'subagent':
      return agentCatalog.has(name) ? A('bundled Anthropic subagent (catalog)') : null
    case 'hook':
      if (hookCatalogIds.has(name)) return A('bundled hook (catalog)')
      if (command && hookCatalogCommands.has(command.trim())) return A('bundled hook (catalog)')
      return null
  }
}

function communityReason(input: ProvenanceInput, blob: string): string | null {
  if (input.repository) return 'has a source repository'
  if (input.homepage) return 'has a homepage'
  if (input.url) return 'remote endpoint'
  if (PKG_MANAGER.test(blob)) return 'installed from a package registry'
  return null
}

/**
 * Best-effort origin for a single item. Precedence:
 *   1. curated catalog (authoritative — official flag wins over heuristics)
 *   2. Anthropic built-in name or @anthropic-ai/anthropics signature
 *   3. community/internet footprint (repo / homepage / remote URL / registry)
 *   4. self-created local
 */
export function classifyProvenance(input: ProvenanceInput): ProvenanceVerdict {
  const name = lc(input.name)
  const blob = blobOf(input)

  const cat = catalogVerdict(input.type, name, input.command)
  if (cat) return cat

  if ((input.type === 'command' || input.type === 'skill') && BUILTIN_COMMANDS.has(name)) {
    return A('built-in Claude Code command')
  }
  if (ANTHROPIC_SIG.test(blob)) return A('Anthropic package or repo')

  const cReason = communityReason(input, blob)
  if (cReason) return C(cReason)

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
