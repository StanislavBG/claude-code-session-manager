import { useEffect, useMemo, useState } from 'react'
import { useConfig } from '../../state/config'
import { useHomeDir } from '../../lib/useHomeDir'
import { SETTINGS_SCOPES, CLAUDE_MD_SCOPES } from '../../lib/scopes'
import { listSkillEntries } from '../../lib/listSkills'
import type { NavKey } from '../LeftNav'

/**
 * Global Controls — Home-only quick-link summary over the machine-wide
 * ('user'-scope) state of the six dual-scope config tabs (Settings,
 * Permissions, Hooks, MCP Servers, System Prompt, Skills). Reads through the
 * SAME paths/helpers those tabs already use (settings.json, ~/.claude.json,
 * ~/.claude/CLAUDE.md, ~/.claude/skills) — no new IPC route.
 */

interface HooksConfig {
  [event: string]: { hooks?: unknown[] }[] | undefined
}

interface PermissionsShape {
  allow?: unknown[]
  deny?: unknown[]
  ask?: unknown[]
}

function countHooks(hooks: HooksConfig | undefined): number {
  if (!hooks) return 0
  return Object.values(hooks).reduce(
    (acc, groups) => acc + (groups ?? []).reduce((a, g) => a + (g.hooks?.length ?? 0), 0),
    0,
  )
}

function countPermissions(perms: PermissionsShape | undefined): number {
  if (!perms) return 0
  return (perms.allow?.length ?? 0) + (perms.deny?.length ?? 0) + (perms.ask?.length ?? 0)
}

interface Card {
  key: NavKey
  title: string
  summary: string
}

interface GlobalControlsSectionProps {
  navigate?: (k: NavKey) => void
}

export function GlobalControlsSection({ navigate }: GlobalControlsSectionProps) {
  const home = useHomeDir()

  const files = useConfig((s) => s.files)
  const loadJson = useConfig((s) => s.loadJson)
  const loadText = useConfig((s) => s.loadText)
  const watchFile = useConfig((s) => s.watchFile)
  const unwatchFile = useConfig((s) => s.unwatchFile)

  const settingsPath = home ? SETTINGS_SCOPES.resolve('user', home, null) : null
  const claudeMdPath = home ? CLAUDE_MD_SCOPES.resolve('user', home, null) : null
  const mcpPath = home ? `${home}/.claude.json` : null

  useEffect(() => {
    const jsonPaths = [settingsPath, mcpPath].filter(Boolean) as string[]
    jsonPaths.forEach((p) => {
      if (!files[p]) loadJson(p)
      watchFile(p)
    })
    const textPaths = [claudeMdPath].filter(Boolean) as string[]
    textPaths.forEach((p) => {
      if (!files[p]) loadText(p)
      watchFile(p)
    })
    return () => {
      ;[...jsonPaths, ...textPaths].forEach((p) => unwatchFile(p))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsPath, claudeMdPath, mcpPath])

  const [skillsCount, setSkillsCount] = useState<number | null>(null)

  useEffect(() => {
    if (!home) return
    let cancelled = false
    ;(async () => {
      const entries = await listSkillEntries(`${home}/.claude/skills`)
      if (!cancelled) setSkillsCount(entries.length)
    })()
    return () => {
      cancelled = true
    }
  }, [home])

  const settingsFile = settingsPath ? files[settingsPath] : null
  const mcpFile = mcpPath ? files[mcpPath] : null
  const claudeMdFile = claudeMdPath ? files[claudeMdPath] : null

  const settingsData = useMemo(() => {
    if (!settingsFile?.exists || settingsFile.parseError) return null
    const data = settingsFile.diskData
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return {}
    return data as Record<string, unknown>
  }, [settingsFile])

  const mcpData = useMemo(() => {
    if (!mcpFile?.exists || mcpFile.parseError) return null
    const data = mcpFile.diskData
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return {}
    return data as Record<string, unknown>
  }, [mcpFile])

  const settingsStatus = !settingsFile
    ? 'loading…'
    : settingsFile.parseError
      ? 'invalid JSON'
      : null
  const mcpStatus = !mcpFile ? 'loading…' : mcpFile.parseError ? 'invalid JSON' : null

  const cards: Card[] = [
    {
      key: 'settings',
      title: 'Settings',
      summary:
        settingsStatus ??
        (settingsData
          ? `${Object.keys(settingsData).length} top-level key${Object.keys(settingsData).length === 1 ? '' : 's'} configured`
          : 'not configured'),
    },
    {
      key: 'permissions',
      title: 'Permissions',
      summary:
        settingsStatus ??
        (settingsData
          ? `${countPermissions(settingsData.permissions as PermissionsShape)} rule(s) configured`
          : 'not configured'),
    },
    {
      key: 'hooks',
      title: 'Hooks',
      summary:
        settingsStatus ??
        (settingsData
          ? `${countHooks(settingsData.hooks as HooksConfig)} hook(s) configured`
          : 'not configured'),
    },
    {
      key: 'mcp',
      title: 'MCP Servers',
      summary:
        mcpStatus ??
        (mcpData
          ? `${Object.keys((mcpData.mcpServers as Record<string, unknown>) ?? {}).length} MCP server(s)`
          : 'not configured'),
    },
    {
      key: 'system-prompt',
      title: 'System Prompt',
      summary: claudeMdFile?.exists && claudeMdFile.diskRaw.trim().length > 0
        ? `configured (${claudeMdFile.diskRaw.length.toLocaleString()} chars)`
        : 'not set',
    },
    {
      key: 'skills',
      title: 'Skills',
      summary: skillsCount === null ? 'loading…' : `${skillsCount} skill(s) installed`,
    },
  ]

  return (
    <section className="border border-line rounded-xl bg-bg-hi px-5 py-4">
      <h2 className="m-0 mb-1 font-serif text-[18px] font-semibold text-fg">Global Controls</h2>
      <p className="mt-0 mb-3 text-[13px] text-fg-dim leading-relaxed">
        Machine-wide (user-scope) config state for the tabs that default to global here on Home.
        Read-only summary — open a card to edit.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {cards.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => navigate?.(c.key)}
            className="text-left border border-line rounded-lg bg-bg px-3 py-2.5 hover:border-accent transition-colors"
          >
            <div className="text-[13px] font-medium text-fg">{c.title}</div>
            <div className="mt-0.5 text-[12px] text-fg-dim">{c.summary}</div>
          </button>
        ))}
      </div>
    </section>
  )
}
