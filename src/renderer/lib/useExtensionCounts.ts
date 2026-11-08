import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClaudeConfigReadInput } from '../../preload/api'
import { listSkillEntries } from './listSkills'
import { useConfigDirWatch } from './useConfigDirWatch'
import { useHomeDir } from './useHomeDir'

/**
 * User-scope totals for the Extensions folder tabs. A count is `null` until
 * its first read lands, or when its latest read failed; a re-count keeps the
 * previous number on screen until the new one resolves (no flicker).
 */
export interface ExtensionCounts {
  skills: number | null
  mcp: number | null
  plugins: number | null
}

type CountKey = keyof ExtensionCounts

const LOADING: ExtensionCounts = { skills: null, mcp: null, plugins: null }

/** The user-scope target McpServers.tsx reads and patches — Library.tsx's `mcpPatchTarget('user', …)`. */
const USER_MCP_TARGET: ClaudeConfigReadInput = { fileId: 'claudeJson', scope: 'user' }

/** The user-scope files each tab body reads, and so the paths whose changes re-count it. */
function sourcesOf(home: string) {
  return {
    skillsDir: `${home}/.claude/skills`, // Skills.tsx roots(): user.skills
    commandsDir: `${home}/.claude/commands`, // Skills.tsx roots(): user.commands
    claudeJson: `${home}/.claude.json`, // McpServers.tsx pathFor('user', …)
    pluginsManifest: `${home}/.claude/plugins/installed_plugins.json`, // Plugins.tsx loadRows + its watch
  }
}

/**
 * User skills (the Skills tab's own walker) plus user commands (every `*.md`
 * file in the commands dir). Plugin-provided items live under the plugins'
 * install dirs and are never walked here. Any listing/read error rejects, so a
 * partial walk is never shown as a real total.
 */
async function countSkills(skillsDir: string, commandsDir: string): Promise<number> {
  const [skills, commands] = await Promise.all([
    listSkillEntries(skillsDir),
    window.api.config.listDir(commandsDir, { filesOnly: true }),
  ])
  const failed = skills.errors[0]
  if (failed) throw new Error(`${failed.path}: ${failed.error}`)
  if (!commands.ok) throw new Error(`${commandsDir}: ${commands.error ?? 'failed to list directory'}`)
  return skills.entries.length + commands.entries.filter((e) => e.name.endsWith('.md')).length
}

async function countMcpServers(): Promise<number> {
  const { data } = await window.api.claudeConfig.read(USER_MCP_TARGET)
  const servers = data?.mcpServers
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers).length : 0
}

async function countPlugins(): Promise<number> {
  return (await window.api.plugins.list()).length
}

/**
 * Counts for every Extensions folder tab at once (Skills, MCP Servers,
 * Plugins), mounted or not, read through the same window.api readers the tab
 * bodies use — no IPC channel of its own. Each count re-reads when
 * `config.onChanged` reports a change to one of its own source paths (watched
 * via useConfigDirWatch, which removes its listener and watch on unmount); a
 * change to an unrelated path re-reads nothing. Errors surface only as `null`:
 * the tab body that owns a source reports the error itself when opened.
 */
export function useExtensionCounts(): ExtensionCounts {
  const home = useHomeDir()
  const [counts, setCounts] = useState<ExtensionCounts>(LOADING)

  // Stale-response guard: one request id per count. Every (re)load bumps its
  // id, and a response is applied only while its id is still the latest — so
  // a slow read can't overwrite a newer one. Effect cleanups bump the ids too,
  // so nothing in flight lands after unmount (or after the sources change).
  const reqIds = useRef<Record<CountKey, number>>({ skills: 0, mcp: 0, plugins: 0 })

  const load = useCallback((key: CountKey, read: () => Promise<number>) => {
    const ids = reqIds.current
    const id = ++ids[key]
    const apply = (n: number | null) => {
      if (ids[key] !== id) return
      setCounts((c) => (c[key] === n ? c : { ...c, [key]: n }))
    }
    read().then(apply, () => apply(null))
  }, [])

  const src = useMemo(() => (home ? sourcesOf(home) : null), [home])

  const reloadSkills = useCallback(() => {
    if (src) load('skills', () => countSkills(src.skillsDir, src.commandsDir))
  }, [src, load])
  const reloadMcp = useCallback(() => load('mcp', countMcpServers), [load])
  const reloadPlugins = useCallback(() => load('plugins', countPlugins), [load])

  useEffect(() => {
    const ids = reqIds.current
    reloadSkills()
    return () => {
      ids.skills++
    }
  }, [reloadSkills])

  // Neither read needs $HOME (main resolves the paths), so they start on mount.
  useEffect(() => {
    const ids = reqIds.current
    reloadMcp()
    reloadPlugins()
    return () => {
      ids.mcp++
      ids.plugins++
    }
  }, [reloadMcp, reloadPlugins])

  useConfigDirWatch(src ? [src.skillsDir, src.commandsDir] : [], reloadSkills)
  useConfigDirWatch(src ? [src.claudeJson] : [], reloadMcp)
  useConfigDirWatch(src ? [src.pluginsManifest] : [], reloadPlugins)

  return counts
}
