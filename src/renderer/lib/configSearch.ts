/**
 * configSearch — the pure core behind the Claude config band's "Search all config" field.
 *
 * - `loadConfigSearchItems` lists every searchable item for one scope (Home = ~/.claude,
 *   Project = <cwd>) through an INJECTED api object — the same window.api readers each tab
 *   body uses, passed in so this file never touches `window`, React, or a store.
 * - `searchConfig` ranks and groups those items per tab, in band order.
 *
 * Each reader is settled on its own: one failing reader drops only its own items.
 */
import type { SessionManagerAPI } from '../../preload/api'
import { SETTINGS_GROUPS, KEY_OWNERS, humanizeKey } from './settingsGroups'
import { parseSkillMeta } from './skillFrontmatter'
import { encodeWorkspace } from './encodeWorkspace'
import { basename } from './basename'

export type ConfigSearchTab = 'memory' | 'claude-md' | 'settings' | 'mcp' | 'skills' | 'plugins' | 'agents'

export interface ConfigSearchItem {
  tab: ConfigSearchTab
  /** Unique across one load: `<tab>:<stable key>`. */
  id: string
  title: string
  detail?: string
  keywords?: string[]
}

export interface ConfigSearchGroup {
  tab: ConfigSearchTab
  /** The best `limitPerTab` matches, best first. */
  items: ConfigSearchItem[]
  /** Every match in this tab, before the limit. */
  total: number
}

/** Result group order — the band's tab order (Project leads with Memory; Home has none). */
export const CONFIG_SEARCH_TAB_ORDER: readonly ConfigSearchTab[] = [
  'memory',
  'claude-md',
  'settings',
  'mcp',
  'skills',
  'plugins',
  'agents',
]

const RANK_EXACT = 0
const RANK_PREFIX = 1
const RANK_TITLE = 2
const RANK_OTHER = 3

/** Rank of an item for `terms`, or null when some term matches none of title/detail/keywords. */
function rankOf(item: ConfigSearchItem, query: string, terms: string[]): number | null {
  const title = item.title.toLowerCase()
  const rest = [item.detail ?? '', ...(item.keywords ?? [])].join('\n').toLowerCase()
  if (!terms.every((t) => title.includes(t) || rest.includes(t))) return null
  if (title === query) return RANK_EXACT
  if (title.startsWith(query)) return RANK_PREFIX
  if (title.includes(query) || terms.every((t) => title.includes(t))) return RANK_TITLE
  return RANK_OTHER
}

/**
 * Case-insensitive search: every whitespace-separated term must match the title, detail or
 * a keyword. Ranked exact title > title prefix > title substring > detail/keyword match (ties
 * keep input order), grouped per tab in CONFIG_SEARCH_TAB_ORDER; tabs with no match are
 * omitted. A blank query returns [].
 */
export function searchConfig(items: ConfigSearchItem[], query: string, limitPerTab = 5): ConfigSearchGroup[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!q) return []
  const terms = q.split(' ')
  const byTab = new Map<ConfigSearchTab, { item: ConfigSearchItem; rank: number; idx: number }[]>()
  items.forEach((item, idx) => {
    const rank = rankOf(item, q, terms)
    if (rank === null) return
    const list = byTab.get(item.tab) ?? []
    list.push({ item, rank, idx })
    byTab.set(item.tab, list)
  })
  const groups: ConfigSearchGroup[] = []
  for (const tab of CONFIG_SEARCH_TAB_ORDER) {
    const hits = byTab.get(tab)
    if (!hits?.length) continue
    hits.sort((a, b) => a.rank - b.rank || a.idx - b.idx)
    groups.push({ tab, items: hits.slice(0, Math.max(0, limitPerTab)).map((h) => h.item), total: hits.length })
  }
  return groups
}

// ───────────────────────────────────────────── loader

type Api = SessionManagerAPI

/** The subset of window.api the loader calls. */
export interface ConfigSearchApi {
  app: Pick<Api['app'], 'homeDir'>
  config: Pick<Api['config'], 'exists' | 'readJson' | 'readText' | 'listDir' | 'parseImports'>
  claudeConfig: Pick<Api['claudeConfig'], 'read'>
  memory: Pick<Api['memory'], 'list'>
  plugins: Pick<Api['plugins'], 'list'>
  agents: Pick<Api['agents'], 'listPersonas'>
}

export interface LoadConfigSearchInput {
  scope: 'home' | 'project'
  /** The project dir; required for `project`, ignored for `home`. */
  cwd: string | null
  api: ConfigSearchApi
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

async function settle(read: () => Promise<ConfigSearchItem[]>): Promise<ConfigSearchItem[]> {
  try {
    return await read()
  } catch {
    return []
  }
}

async function readJsonData(api: ConfigSearchApi, path: string): Promise<unknown> {
  const r = await api.config.readJson(path)
  if (r.error) throw new Error(r.error)
  return r.data
}

/** CLAUDE.md roots that exist, each followed by its @-imports (the workbench's radio rows). */
async function claudeMdItems(api: ConfigSearchApi, roots: string[]): Promise<ConfigSearchItem[]> {
  const exists = await Promise.all(roots.map((p) => api.config.exists(p)))
  const present = roots.filter((_, i) => exists[i])
  const perRoot = await Promise.all(
    present.map(async (root): Promise<ConfigSearchItem[]> => {
      const own: ConfigSearchItem = { tab: 'claude-md', id: `claude-md:${root}`, title: basename(root), detail: root }
      let imports: ConfigSearchItem[] = []
      try {
        const res = await api.config.parseImports(root)
        if (res.ok) {
          imports = res.imports.map((imp) => ({
            tab: 'claude-md' as const,
            id: `claude-md:${root}>${imp.path}`,
            title: basename(imp.path),
            detail: imp.path,
            keywords: ['import', basename(root)],
          }))
        }
      } catch {
        // The root still lists; only its imports are dropped.
      }
      return [own, ...imports]
    }),
  )
  const seen = new Set<string>()
  return perRoot.flat().filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
}

/** Every curated settings.json key, plus any key present on disk that the groups don't list. */
function staticSettingsItems(): ConfigSearchItem[] {
  const items: ConfigSearchItem[] = []
  for (const g of SETTINGS_GROUPS) {
    for (const key of g.keys) {
      items.push({ tab: 'settings', id: `settings:${key}`, title: key, detail: g.title, keywords: [humanizeKey(key), g.summary] })
    }
  }
  for (const o of KEY_OWNERS) {
    for (const key of o.keys) {
      if (items.some((i) => i.title === key)) continue
      items.push({ tab: 'settings', id: `settings:${key}`, title: key, detail: o.label, keywords: [humanizeKey(key)] })
    }
  }
  return items
}

async function presentSettingsItems(api: ConfigSearchApi, files: string[], known: Set<string>): Promise<ConfigSearchItem[]> {
  const keys = new Set<string>()
  for (const data of await Promise.all(files.map((f) => readJsonData(api, f)))) {
    if (isRecord(data)) Object.keys(data).forEach((k) => keys.add(k))
  }
  return [...keys]
    .filter((k) => !known.has(k))
    .map((key) => ({ tab: 'settings' as const, id: `settings:${key}`, title: key, detail: 'Other', keywords: [humanizeKey(key)] }))
}

function mcpItems(servers: unknown, source: string): ConfigSearchItem[] {
  if (!isRecord(servers)) return []
  return Object.entries(servers).map(([name, cfg]) => {
    const keywords = [source]
    if (isRecord(cfg)) {
      for (const k of ['command', 'url', 'type'] as const) if (typeof cfg[k] === 'string') keywords.push(cfg[k] as string)
    }
    return { tab: 'mcp' as const, id: `mcp:${name}`, title: name, detail: 'MCP server', keywords }
  })
}

/** The Skills tab's walk (lib/listSkills rules: <root>/<name>/SKILL.md or one namespace deeper) via the injected api. */
async function skillItems(api: ConfigSearchApi, skillsDir: string, commandsDir: string): Promise<ConfigSearchItem[]> {
  const dirs = async (path: string) => {
    const r = await api.config.listDir(path, { dirsOnly: true })
    if (!r.ok) throw new Error(r.error ?? `failed to list ${path}`)
    return r.entries
  }
  const skillAt = async (name: string, dir: string): Promise<ConfigSearchItem | null> => {
    const path = `${dir}/SKILL.md`
    const r = await api.config.readText(path)
    if (!r.exists) return null
    const meta = parseSkillMeta(r.text)
    return { tab: 'skills', id: `skills:${path}`, title: meta.name ?? name, detail: meta.description ?? undefined, keywords: ['skill', path] }
  }
  const skills = (
    await Promise.all(
      (await dirs(skillsDir)).map(async (e): Promise<(ConfigSearchItem | null)[]> => {
        const direct = await skillAt(e.name, e.path)
        if (direct) return [direct]
        return Promise.all((await dirs(e.path)).map((ne) => skillAt(ne.name, ne.path)))
      }),
    )
  )
    .flat()
    .filter((x): x is ConfigSearchItem => x !== null)

  // Commands are optional: a missing commands dir lists no commands but keeps the skills.
  let commands: ConfigSearchItem[] = []
  try {
    const cmds = await api.config.listDir(commandsDir, { filesOnly: true })
    if (cmds.ok) {
      commands = cmds.entries
        .filter((e) => e.name.endsWith('.md'))
        .map((e) => ({
          tab: 'skills' as const,
          id: `skills:${e.path}`,
          title: e.name.replace(/\.md$/, ''),
          detail: 'Command',
          keywords: ['command', `/${e.name.replace(/\.md$/, '')}`, e.path],
        }))
    }
  } catch {
    // dropped alone
  }
  return [...skills, ...commands]
}

/**
 * Every searchable config item for one scope, read through `api` (the subset of window.api
 * the tab bodies use). Home: ~/.claude/CLAUDE.md + imports, user settings, user MCP
 * (~/.claude.json), user skills + commands, plugins, agents. Project: memory files,
 * <cwd>/CLAUDE.md + CLAUDE.local.md + imports, project/local settings, <cwd>/.mcp.json,
 * project skills + commands. Each reader fails alone — its items are dropped, the rest remain.
 */
export async function loadConfigSearchItems({ scope, cwd, api }: LoadConfigSearchInput): Promise<ConfigSearchItem[]> {
  const staticSettings = staticSettingsItems()
  const known = new Set(staticSettings.map((i) => i.title))

  if (scope === 'home') {
    let home: string
    try {
      home = await api.app.homeDir()
    } catch {
      return staticSettings
    }
    const claude = `${home}/.claude`
    const groups = await Promise.all([
      settle(() => claudeMdItems(api, [`${claude}/CLAUDE.md`])),
      settle(() => presentSettingsItems(api, [`${claude}/settings.json`], known)),
      settle(async () => mcpItems((await api.claudeConfig.read({ fileId: 'claudeJson', scope: 'user' })).data?.mcpServers, `${home}/.claude.json`)),
      settle(() => skillItems(api, `${claude}/skills`, `${claude}/commands`)),
      settle(async () =>
        (await api.plugins.list()).map((p) => ({
          tab: 'plugins' as const,
          id: `plugins:${p.key}`,
          title: p.name,
          detail: p.marketplace,
          keywords: [p.key, p.enabled ? 'enabled' : 'disabled'],
        })),
      ),
      settle(async () =>
        (await api.agents.listPersonas()).map((a) => ({
          tab: 'agents' as const,
          id: `agents:${a.name}`,
          title: a.name,
          detail: a.description ?? undefined,
          keywords: a.tags,
        })),
      ),
    ])
    const [claudeMd, presentSettings, ...rest] = groups
    return [...claudeMd, ...staticSettings, ...presentSettings, ...rest.flat()]
  }

  if (!cwd) return []
  const groups = await Promise.all([
    settle(async () => {
      const r = await api.memory.list({ workspace: encodeWorkspace(cwd), cwd })
      if (r.error) throw new Error(r.error)
      return r.entries.map((e) => ({ tab: 'memory' as const, id: `memory:${e.path}`, title: e.name, detail: e.path }))
    }),
    settle(() => claudeMdItems(api, [`${cwd}/CLAUDE.md`, `${cwd}/CLAUDE.local.md`])),
    settle(() => presentSettingsItems(api, [`${cwd}/.claude/settings.json`, `${cwd}/.claude/settings.local.json`], known)),
    settle(async () => {
      const data = await readJsonData(api, `${cwd}/.mcp.json`)
      return mcpItems(isRecord(data) ? data.mcpServers : undefined, `${cwd}/.mcp.json`)
    }),
    settle(() => skillItems(api, `${cwd}/.claude/skills`, `${cwd}/.claude/commands`)),
  ])
  const [memory, claudeMd, presentSettings, ...rest] = groups
  return [...memory, ...claudeMd, ...staticSettings, ...presentSettings, ...rest.flat()]
}
