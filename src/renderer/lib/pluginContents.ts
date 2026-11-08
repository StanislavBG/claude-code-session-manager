/**
 * What an installed plugin contains, read from its own install dir (the `installPath` recorded in
 * `installed_plugins.json`): manifest, commands, agents, hooks, MCP servers and skills. The one reader
 * behind the Plugins tab and every other surface that lists a plugin's contents, so no two of them
 * count differently. Every read goes through `window.api.config`.
 */
import type { DirEntry } from '../../preload/api'
import { parseSkillMeta } from './skillFrontmatter'
import { resolveInstalledPluginSkillsDir, listPluginSkills } from './pluginSkills'

export interface PluginManifest {
  name?: string
  version?: string
  description?: string
  author?: { name?: string } | string
  homepage?: string
  repository?: string
  license?: string
  /** Component declarations: a relative path, an array of paths, or (hooks/mcpServers) an inline object. */
  commands?: unknown
  agents?: unknown
  hooks?: unknown
  mcpServers?: unknown
}

export interface PluginRow {
  name: string
  path: string
  mtimeMs: number
  /** Manifest path is `.claude-plugin/plugin.json` per docs; legacy installs use `plugin.json`. */
  hasManifest: boolean
  manifest: PluginManifest | null
  hasLsp: boolean
  monitors: number
  hooks: number
  agents: number
  commands: number
  skills: number
  binCount: number
  hasMcp: boolean
  /** Number of MCP servers the plugin adds; `hasMcp` is `mcpServers > 0`. */
  mcpServers: number
  /** Part of the `installed_plugins.json` key after `@`; the marketplace the plugin came from. */
  marketplace?: string
  /** `scope` of this install in `installed_plugins.json` (user / project / local). */
  scope?: string
  /** `name@marketplace` key shared with `plugins.list` / settings.json `enabledPlugins`. */
  key?: string
  /** User-scope enabled flag from `window.api.plugins.list`. */
  enabled?: boolean
  /** Set when inspecting this plugin's directory threw; the row is listed with this marker instead of failing the list. */
  error?: string
}

export interface AgentEntry {
  id: string
  name: string | null
  description: string | null
}

export interface McpEntry {
  id: string
  name: string
  description: string | null
}

/** Per-kind counts of what a plugin contains. */
export interface PluginContentsSummary {
  skills: number
  commands: number
  agents: number
  hooks: number
  mcpServers: number
}

/** The row listed in place of a plugin whose inspectPluginDir threw: zero counts plus the `error` marker. */
export function failedPluginRow(e: DirEntry, error: string): PluginRow {
  return {
    name: e.name, path: e.path, mtimeMs: e.mtimeMs, hasManifest: false, manifest: null, hasLsp: false,
    monitors: 0, hooks: 0, agents: 0, commands: 0, skills: 0, binCount: 0, hasMcp: false, mcpServers: 0, error,
  }
}

/** One Plugins-table row for a plugin install dir: its manifest plus a count of each component kind. */
export async function inspectPluginDir(e: DirEntry): Promise<PluginRow> {
  const { hasManifest, manifest } = await readPluginManifest(e.path)

  const [hasLsp, hasMonitorsFile] = await Promise.all([
    window.api.config.exists(`${e.path}/.lsp.json`),
    window.api.config.exists(`${e.path}/monitors/monitors.json`),
  ])

  let monitors = 0
  if (hasMonitorsFile) {
    const r = await window.api.config.readJson(`${e.path}/monitors/monitors.json`)
    if (Array.isArray(r.data)) monitors = r.data.length
    else if (r.data && typeof r.data === 'object' && Array.isArray((r.data as Record<string, unknown>).monitors)) {
      monitors = ((r.data as Record<string, unknown>).monitors as unknown[]).length
    }
  }

  const [comps, binList, skillsDir] = await Promise.all([
    resolvePluginComponents(e.path, manifest),
    listOrEmpty(`${e.path}/bin`, { filesOnly: true }),
    resolveInstalledPluginSkillsDir(e.path),
  ])
  const binCount = binList.length
  const skills = skillsDir ? (await listPluginSkills(skillsDir)).length : 0

  return {
    name: e.name,
    path: e.path,
    mtimeMs: e.mtimeMs,
    hasManifest,
    manifest,
    hasLsp,
    monitors,
    hooks: comps.hooks,
    agents: comps.agentFiles.length,
    commands: comps.commandFiles.length,
    skills,
    binCount,
    hasMcp: comps.mcpServers.length > 0,
    mcpServers: comps.mcpServers.length,
  }
}

/**
 * The counts the Plugins table's contents column shows for an inspectPluginDir row (`mcpServers` counts the
 * servers behind its `mcp` flag) — the one place every plugin-contents surface takes its numbers from.
 */
export function summarizePluginContents(
  row: Pick<PluginRow, 'skills' | 'commands' | 'agents' | 'hooks' | 'mcpServers'>,
): PluginContentsSummary {
  return { skills: row.skills, commands: row.commands, agents: row.agents, hooks: row.hooks, mcpServers: row.mcpServers }
}

/** Docs locate the manifest under `.claude-plugin/plugin.json`; some installs still use root-level `plugin.json`. */
export async function readPluginManifest(root: string): Promise<{ hasManifest: boolean; manifest: PluginManifest | null }> {
  let manifestPath = `${root}/.claude-plugin/plugin.json`
  let hasManifest = await window.api.config.exists(manifestPath)
  if (!hasManifest) {
    manifestPath = `${root}/plugin.json`
    hasManifest = await window.api.config.exists(manifestPath)
  }
  if (!hasManifest) return { hasManifest, manifest: null }
  const r = await window.api.config.readJson(manifestPath)
  const ok = r.exists && !r.parseError && r.data && typeof r.data === 'object' && !Array.isArray(r.data)
  return { hasManifest, manifest: ok ? (r.data as PluginManifest) : null }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Resolve a manifest-declared relative path against the plugin root. Returns null (one console.warn) when it
 * escapes the root; absolute paths are accepted only inside the root.
 */
function resolveInRoot(root: string, declared: string): string | null {
  const rel = declared.startsWith('/') ? (declared.startsWith(`${root}/`) ? declared.slice(root.length + 1) : null) : declared
  if (rel === null) return warnEscape(declared)
  const parts: string[] = []
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg !== '..') parts.push(seg)
    else if (parts.pop() === undefined) return warnEscape(declared)
  }
  return parts.length > 0 ? `${root}/${parts.join('/')}` : root
}

function warnEscape(declared: string): null {
  console.warn(`[plugins] ignoring manifest path outside the plugin root: ${declared}`)
  return null
}

/** A manifest component value as a list of path strings; wrong-typed values (and non-string items) yield none. */
function declaredPaths(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Server map from `{ mcpServers: {...} }` or a bare map whose every value has a `command` or `url`. */
function parseMcpServers(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data)) return null
  if (isRecord(data.mcpServers)) return data.mcpServers
  const values = Object.values(data)
  const bare = values.length > 0 && values.every((d) => isRecord(d) && (typeof d.command === 'string' || typeof d.url === 'string'))
  return bare ? data : null
}

/** Hook-event map from a `hooks.json` body, with or without a wrapping `hooks` key. */
function countHooks(data: unknown): number {
  if (!isRecord(data)) return 0
  const events = isRecord(data.hooks) ? data.hooks : data
  return Object.values(events).reduce<number>((acc, ev) => {
    if (!Array.isArray(ev)) return acc
    return acc + ev.reduce<number>((a, g) => a + (isRecord(g) && Array.isArray(g.hooks) ? g.hooks.length : 0), 0)
  }, 0)
}

/** One component kind's locations: the manifest's declared paths (resolved inside the root), then the default; deduped. */
function componentLocations(root: string, declared: unknown, fallback: string): string[] {
  const out = new Set<string>()
  for (const d of declaredPaths(declared)) {
    const p = resolveInRoot(root, d)
    if (p) out.add(p)
  }
  out.add(`${root}/${fallback}`)
  return [...out]
}

async function readJsonData(p: string): Promise<unknown> {
  try {
    const r = await window.api.config.readJson(p)
    return r.exists && !r.parseError ? r.data : null
  } catch {
    return null
  }
}

/** `.mcp.json` locations: the manifest's declared path(s) (an inline server object declares none), then the default. */
function mcpServerPaths(root: string, mcpDecl: unknown): string[] {
  return componentLocations(root, typeof mcpDecl === 'string' || Array.isArray(mcpDecl) ? mcpDecl : undefined, '.mcp.json')
}

/** Servers from an inline manifest object first, then each file in `mcpPaths` order; a name's first definition wins. */
async function readMcpServers(mcpDecl: unknown, mcpPaths: string[]): Promise<McpEntry[]> {
  const mcpBodies = await Promise.all(mcpPaths.map(readJsonData))
  const servers = new Map<string, McpEntry>()
  for (const body of [...(isRecord(mcpDecl) ? [mcpDecl] : []), ...mcpBodies]) {
    for (const [name, def] of Object.entries(parseMcpServers(body) ?? {})) {
      if (servers.has(name)) continue
      const command = isRecord(def) ? def.command : undefined
      const url = isRecord(def) ? def.url : undefined
      servers.set(name, {
        id: name,
        name,
        description: typeof command === 'string' ? command : typeof url === 'string' ? url : null,
      })
    }
  }
  return [...servers.values()]
}

export interface ResolvedComponents {
  commandFiles: string[]
  agentFiles: string[]
  hooks: number
  mcpServers: McpEntry[]
  /** Every location consulted, for the live-reload watch. */
  sourcePaths: string[]
}

/**
 * Components from the manifest's own declarations first, then the default locations, deduped by resolved path.
 * Parses defensively: a malformed manifest value is ignored, never thrown.
 */
export async function resolvePluginComponents(root: string, manifest: PluginManifest | null): Promise<ResolvedComponents> {
  const mdFiles = async (paths: string[]): Promise<string[]> => {
    const out = new Set<string>()
    for (const p of paths) {
      if (p.endsWith('.md')) out.add(p)
      else for (const n of await listOrEmpty(p, { filesOnly: true })) if (n.endsWith('.md')) out.add(`${p}/${n}`)
    }
    return [...out]
  }

  const commandPaths = componentLocations(root, manifest?.commands, 'commands')
  const agentPaths = componentLocations(root, manifest?.agents, 'agents')
  const hookDecl = manifest?.hooks
  const hookPaths = componentLocations(root, typeof hookDecl === 'string' || Array.isArray(hookDecl) ? hookDecl : undefined, 'hooks/hooks.json')
  const mcpDecl = manifest?.mcpServers
  const mcpPaths = mcpServerPaths(root, mcpDecl)

  const [commandFiles, agentFiles, hookBodies, mcpServers] = await Promise.all([
    mdFiles(commandPaths),
    mdFiles(agentPaths),
    Promise.all(hookPaths.map(readJsonData)),
    readMcpServers(mcpDecl, mcpPaths),
  ])

  const hooks = [...(isRecord(hookDecl) ? [hookDecl] : []), ...hookBodies].reduce<number>((n, b) => n + countHooks(b), 0)

  return {
    commandFiles,
    agentFiles,
    hooks,
    mcpServers,
    sourcePaths: [...commandPaths, ...agentPaths, ...hookPaths, ...mcpPaths],
  }
}

/**
 * The MCP servers a plugin adds, read from its install dir exactly as resolvePluginComponents reads them —
 * without listing its command/agent dirs or reading its hooks.
 */
export async function listPluginMcpServers(installPath: string): Promise<McpEntry[]> {
  const { manifest } = await readPluginManifest(installPath)
  const mcpDecl = manifest?.mcpServers
  return readMcpServers(mcpDecl, mcpServerPaths(installPath, mcpDecl))
}

/** Name + description of each `.md` component file (name defaults to the file's basename). */
export async function readMdEntries(files: string[]): Promise<AgentEntry[]> {
  const reads = await Promise.all(files.map((f) => window.api.config.readText(f)))
  const out: AgentEntry[] = []
  files.forEach((f, i) => {
    if (!reads[i].exists) return
    const base = f.slice(f.lastIndexOf('/') + 1)
    const meta = parseSkillMeta(reads[i].text)
    out.push({ id: f, name: meta.name ?? base.replace(/\.md$/, ''), description: meta.description })
  })
  return out
}

export async function listOrEmpty(
  path: string,
  opts: { filesOnly?: boolean; dirsOnly?: boolean },
): Promise<string[]> {
  try {
    const r = await window.api.config.listDir(path, opts)
    return r.entries.map((x) => x.name)
  } catch {
    return []
  }
}
