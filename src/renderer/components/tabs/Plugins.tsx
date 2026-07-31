import { useEffect, useState } from 'react'
import { Panel } from '../ui/Panel'
import { KVTable, type Column } from '../ui/KVTable'
import { EmptyState } from '../ui/EmptyState'
import { ProvenanceBadge } from '../ui/ProvenanceBadge'
import { Badge } from '../ui/Badge'
import type { ProvenanceInput } from '../../lib/provenance'
import { useHomeDir } from '../../lib/useHomeDir'
import type { DirEntry } from '../../../preload/api'
import { PluginsLibrary } from './Library'
import { resolveInstalledPluginSkillsDir, listPluginSkills, type PluginSkillEntry } from '../../lib/pluginSkills'
import { parseSkillMeta } from '../../lib/skillFrontmatter'
import { PluginSkillBrowser } from './plugins/PluginSkillBrowser'
import { toast } from '../../state/toast'

type PluginsView = 'installed' | 'library'

interface PluginManifest {
  name?: string
  version?: string
  description?: string
  author?: { name?: string } | string
  homepage?: string
  repository?: string
  license?: string
  mcpServers?: Record<string, unknown>
}

interface PluginRow {
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
  skills: number
  binCount: number
  hasMcp: boolean
  /** Part of the `installed_plugins.json` key after `@`; the marketplace the plugin came from. */
  marketplace?: string
}

interface InstalledPluginEntry {
  scope: string
  installPath: string
  version: string
  installedAt: string
  lastUpdated: string
  gitCommitSha?: string
}

interface InstalledPluginsManifest {
  version: number
  plugins: Record<string, InstalledPluginEntry[]>
}

// Single source for the provenance input so the column + toolbar badges agree.
const pluginProvInput = (r: PluginRow): ProvenanceInput => ({
  type: 'plugin', name: r.name, repository: r.manifest?.repository, homepage: r.manifest?.homepage,
})

/**
 * Plugins are directories under `~/.claude/plugins/<name>/` that bundle skills,
 * subagents, and hooks. We enumerate them and show their manifest + contents
 * as a read-only inspector for now (plugin editing would duplicate the Skills/
 * Subagents/Hooks tabs' UI — out of scope here).
 */
export function Plugins() {
  const home = useHomeDir()
  const [rows, setRows] = useState<PluginRow[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<PluginsView>('installed')

  useEffect(() => {
    if (!home) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const next: PluginRow[] = []
      try {
        const r = await window.api.config.readJson(`${home}/.claude/plugins/installed_plugins.json`)
        if (r.exists && !r.parseError && r.data && typeof r.data === 'object') {
          const manifest = r.data as InstalledPluginsManifest
          for (const [key, entries] of Object.entries(manifest.plugins ?? {})) {
            if (!Array.isArray(entries)) continue
            const name = key.split('@')[0]
            const marketplace = key.split('@')[1]
            for (const entry of entries) {
              if (!entry?.installPath) continue
              const dirEntry: DirEntry = {
                name,
                path: entry.installPath,
                isDirectory: true,
                isFile: false,
                mtimeMs: 0,
                size: 0,
              }
              const row = await inspectPluginDir(dirEntry)
              if (!row.manifest?.version) {
                row.manifest = { ...(row.manifest ?? {}), version: entry.version }
              }
              row.marketplace = marketplace
              next.push(row)
            }
          }
        }
      } catch {
        // Missing/unparseable manifest → empty list, no throw.
      }
      if (cancelled) return
      next.sort((a, b) => a.name.localeCompare(b.name))
      if (!cancelled) {
        setRows(next)
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [home])

  const columns: Column<PluginRow>[] = [
    {
      key: 'name',
      header: 'name',
      render: (r) => (
        <div style={{ maxWidth: '16rem' }}>
          <div className="truncate">{r.name}</div>
          {r.manifest?.description ? (
            <div className="truncate text-fg-faint" title={r.manifest.description}>
              {r.manifest.description}
            </div>
          ) : null}
        </div>
      ),
      width: '16rem',
    },
    {
      key: 'origin',
      header: 'origin',
      render: (r) => <ProvenanceBadge interactive={false} input={pluginProvInput(r)} />,
      width: '7rem',
    },
    {
      key: 'version',
      header: 'version',
      render: (r) => r.manifest?.version ?? <span className="text-fg-faint">—</span>,
      width: '6rem',
    },
    {
      key: 'manifest',
      header: 'manifest',
      render: (r) => (r.hasManifest ? 'plugin.json' : <span className="text-fg-faint">—</span>),
      width: '8rem',
    },
    {
      key: 'contents',
      header: 'contents',
      render: (r) => (
        <span className="font-mono text-fg-faint text-xs">
          {[
            r.agents > 0 ? `${r.agents} agents` : null,
            r.skills > 0 ? `${r.skills} skills` : null,
            r.hooks > 0 ? `${r.hooks} hooks` : null,
            r.monitors > 0 ? `${r.monitors} monitors` : null,
            r.binCount > 0 ? `${r.binCount} bin` : null,
            r.hasLsp ? 'lsp' : null,
            r.hasMcp ? 'mcp' : null,
          ]
            .filter(Boolean)
            .join(' · ') || '—'}
        </span>
      ),
    },
    {
      key: 'path',
      header: 'path',
      render: (r) => <span className="font-mono text-fg-faint truncate">{r.path}</span>,
    },
  ]

  if (view === 'library') {
    return (
      <Panel toolbar={<PluginsViewTabs active={view} onChange={setView} />}>
        <PluginsLibrary />
      </Panel>
    )
  }

  const selectedRow = selected ? rows.find((r) => r.path === selected) ?? null : null

  return (
    <Panel
      toolbar={
        <>
          <PluginsViewTabs active={view} onChange={setView} />
          <span className="mx-2 text-fg-faint">·</span>
          <span className="text-fg-faint">{rows.length} plugins</span>
          <div className="flex-1" />
          <span className="text-fg-faint font-mono truncate">~/.claude/plugins/installed_plugins.json</span>
        </>
      }
    >
      {loading ? (
        <EmptyState title="scanning plugins…" />
      ) : selectedRow ? (
        <PluginHomePage key={selectedRow.path} row={selectedRow} home={home} onBack={() => setSelected(null)} />
      ) : (
        <div className="flex flex-col h-full">
          <div className="flex-1 min-h-0 overflow-auto">
            <KVTable
              columns={columns}
              rows={rows}
              getKey={(r) => r.path}
              activeKey={selected}
              onRowClick={(r) => setSelected(r.path)}
              empty={
                <>
                  no plugins installed
                  <div className="mt-2 text-fg-faint">
                    drop a plugin into <code>~/.claude/plugins/</code>
                  </div>
                </>
              }
            />
          </div>
        </div>
      )}
    </Panel>
  )
}

/**
 * 2-way tab switcher: Installed / Library, matching the ViewSwitcher pattern
 * used by Skills / MCP Servers.
 */
function PluginsViewTabs({
  active,
  onChange,
}: {
  active: PluginsView
  onChange: (v: PluginsView) => void
}) {
  const items: Array<[PluginsView, string]> = [
    ['installed', 'Installed'],
    ['library', 'Library'],
  ]
  return (
    <div className="flex rounded border border-line overflow-hidden" role="tablist" aria-label="Plugins view">
      {items.map(([key, label]) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          role="tab"
          aria-selected={active === key}
          className={`px-2 py-0.5 text-xs ${
            active === key ? 'bg-bg-hi text-fg' : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

interface AgentEntry {
  id: string
  name: string | null
  description: string | null
}

interface McpEntry {
  id: string
  name: string
  description: string | null
}

type SectionKey = 'skills' | 'agents' | 'mcp' | 'hooks' | 'monitors' | 'lsp' | 'files'

/**
 * Full-page plugin drill-in ("mockup 2a"): one-line header, thin meta strip,
 * and a left section index beside a full-height component listing. Replaces
 * the Installed table in place (Plugins.tsx swaps it in on row click).
 */
function PluginHomePage({
  row,
  home,
  onBack,
}: {
  row: PluginRow
  home: string | null
  onBack: () => void
}) {
  const [skills, setSkills] = useState<PluginSkillEntry[]>([])
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [mcpServers, setMcpServers] = useState<McpEntry[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [active, setActive] = useState<SectionKey>('skills')
  const [browsingSkill, setBrowsingSkill] = useState<PluginSkillEntry | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!home) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const [skillsDir, agentFiles, mcpJson, binFiles] = await Promise.all([
          resolveInstalledPluginSkillsDir(row.name, row.path, home),
          listOrEmpty(`${row.path}/agents`, { filesOnly: true }),
          row.hasMcp ? window.api.config.readJson(`${row.path}/.mcp.json`) : Promise.resolve(null),
          listOrEmpty(`${row.path}/bin`, { filesOnly: true }),
        ])

        const skillEntries = skillsDir ? await listPluginSkills(skillsDir) : []

        const agentMdFiles = agentFiles.filter((f) => f.endsWith('.md'))
        const agentReads = await Promise.all(
          agentMdFiles.map((name) => window.api.config.readText(`${row.path}/agents/${name}`)),
        )
        const agentEntries: AgentEntry[] = []
        agentMdFiles.forEach((name, i) => {
          const r = agentReads[i]
          if (!r.exists) return
          const meta = parseSkillMeta(r.text)
          agentEntries.push({ id: name, name: meta.name ?? name.replace(/\.md$/, ''), description: meta.description })
        })

        const mcpEntries: McpEntry[] = []
        if (mcpJson && mcpJson.exists && !mcpJson.parseError && mcpJson.data && typeof mcpJson.data === 'object') {
          const servers = (mcpJson.data as Record<string, unknown>).mcpServers
          if (servers && typeof servers === 'object') {
            for (const [name, def] of Object.entries(servers as Record<string, unknown>)) {
              const command =
                def && typeof def === 'object' ? (def as Record<string, unknown>).command : undefined
              mcpEntries.push({ id: name, name, description: typeof command === 'string' ? command : null })
            }
          }
        }

        if (cancelled) return
        setSkills(skillEntries)
        setAgents(agentEntries)
        setMcpServers(mcpEntries)
        setFiles(binFiles)
        setActive(
          skillEntries.length > 0
            ? 'skills'
            : agentEntries.length > 0
              ? 'agents'
              : mcpEntries.length > 0
                ? 'mcp'
                : row.hooks > 0
                  ? 'hooks'
                  : row.monitors > 0
                    ? 'monitors'
                    : row.hasLsp
                      ? 'lsp'
                      : 'files',
        )
      } catch (err) {
        if (cancelled) return
        toast.error(`Failed to load plugin contents: ${err instanceof Error ? err.message : String(err)}`)
        setSkills([])
        setAgents([])
        setMcpServers([])
        setFiles([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [row.path, row.name, row.hasMcp, row.hooks, row.monitors, row.hasLsp, home])

  const sections: Array<{ key: SectionKey; label: string; count: number }> = [
    { key: 'skills', label: 'Skills', count: skills.length },
    { key: 'agents', label: 'Agents', count: agents.length },
    { key: 'mcp', label: 'MCP server', count: mcpServers.length },
    { key: 'hooks', label: 'Hooks', count: row.hooks },
    { key: 'monitors', label: 'Monitors', count: row.monitors },
    { key: 'lsp', label: 'LSP', count: row.hasLsp ? 1 : 0 },
    { key: 'files', label: 'Bin', count: files.length },
  ]

  const author = row.manifest?.author
    ? typeof row.manifest.author === 'string'
      ? row.manifest.author
      : row.manifest.author.name ?? null
    : null
  const openHomepage = async (url: string) => {
    const result = await window.api.shell.open({ as: 'external', url })
    if (!result.ok) toast.error(result.error ?? `Failed to open ${url}`)
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Header: one row, back link + name + version + description + badges. */}
      <div className="shrink-0 h-11 flex items-baseline gap-3.5 px-3 border-b border-line bg-bg">
        <button type="button" onClick={onBack} className="font-mono text-accent hover:underline shrink-0 text-xs">
          ← Plugins
        </button>
        <span className="font-serif text-[22px] text-fg shrink-0 truncate max-w-[16rem]">
          {row.manifest?.name ?? row.name}
        </span>
        {row.manifest?.version ? (
          <span className="font-mono text-fg-faint text-xs shrink-0">v{row.manifest.version}</span>
        ) : null}
        {row.manifest?.description ? (
          <span className="text-fg-dim text-xs min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {row.manifest.description}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <div className="flex items-center gap-1.5 shrink-0">
          <ProvenanceBadge input={pluginProvInput(row)} />
          {row.hasMcp ? <Badge tone="accent">MCP</Badge> : null}
        </div>
      </div>

      {/* Meta strip: thin muted row, omits keys the manifest lacks. */}
      {row.manifest ? (
        <div className="shrink-0 h-[26px] flex items-center gap-[18px] px-3 bg-bg-elev border-b border-line text-[9px] font-mono uppercase tracking-wide overflow-hidden">
          {author ? (
            <span className="text-fg-dim truncate">
              <span className="text-fg-faint">Author </span>
              {author}
            </span>
          ) : null}
          {row.manifest.license ? (
            <span className="text-fg-dim truncate">
              <span className="text-fg-faint">License </span>
              {row.manifest.license}
            </span>
          ) : null}
          {row.manifest.homepage ? (
            <button
              onClick={() => openHomepage(row.manifest!.homepage!)}
              className="text-accent hover:underline truncate normal-case"
              title={row.manifest.homepage}
            >
              <span className="text-fg-faint uppercase">Homepage </span>
              {row.manifest.homepage}
            </button>
          ) : null}
          <span className="ml-auto text-fg-faint truncate normal-case">{row.path}</span>
        </div>
      ) : (
        <div className="shrink-0 h-[26px] flex items-center px-3 bg-bg-elev border-b border-line text-[9px] font-mono uppercase tracking-wide overflow-hidden">
          <span className="ml-auto text-fg-faint truncate normal-case">{row.path}</span>
        </div>
      )}

      {/* Body: 170px section index + full-height content column. */}
      <div className="flex-1 min-h-0 grid overflow-hidden" style={{ gridTemplateColumns: '170px 1fr' }}>
        <div className="min-h-0 overflow-auto bg-bg-elev border-r border-line py-1">
          {sections.map((s) => (
            <button
              key={s.key}
              type="button"
              disabled={s.count === 0}
              onClick={() => setActive(s.key)}
              className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between ${
                s.count === 0
                  ? 'text-fg-faint opacity-50 cursor-default'
                  : active === s.key
                    ? 'bg-bg-hi text-fg'
                    : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
              }`}
            >
              <span>{s.label}</span>
              {s.count > 0 ? <span className="font-mono text-fg-faint">{s.count}</span> : null}
            </button>
          ))}
        </div>
        <div className="min-h-0 overflow-auto">
          {loading ? (
            <EmptyState title="scanning…" />
          ) : (
            <SectionContent
              active={active}
              row={row}
              skills={skills}
              agents={agents}
              mcpServers={mcpServers}
              files={files}
              onOpenSkill={setBrowsingSkill}
            />
          )}
        </div>
      </div>

      {browsingSkill ? (
        <PluginSkillBrowser
          key={browsingSkill.id}
          skills={skills}
          initialSelectedId={browsingSkill.id}
          onClose={() => setBrowsingSkill(null)}
        />
      ) : null}
    </div>
  )
}

function SectionContent({
  active,
  row,
  skills,
  agents,
  mcpServers,
  files,
  onOpenSkill,
}: {
  active: SectionKey
  row: PluginRow
  skills: PluginSkillEntry[]
  agents: AgentEntry[]
  mcpServers: McpEntry[]
  files: string[]
  onOpenSkill: (skill: PluginSkillEntry) => void
}) {
  if (active === 'skills') {
    if (skills.length === 0) return <EmptyState title="no components" />
    return (
      <div>
        {skills.map((s, i) => (
          <ContentRow
            key={s.id}
            n={i + 1}
            name={s.name ?? s.id}
            description={s.description}
            onClick={() => onOpenSkill(s)}
          />
        ))}
      </div>
    )
  }
  if (active === 'agents') {
    if (agents.length === 0) return <EmptyState title="no components" />
    return (
      <div>
        {agents.map((a, i) => (
          <ContentRow key={a.id} n={i + 1} name={a.name ?? a.id} description={a.description} />
        ))}
      </div>
    )
  }
  if (active === 'mcp') {
    if (mcpServers.length === 0) return <EmptyState title="no components" />
    return (
      <div>
        {mcpServers.map((m, i) => (
          <ContentRow key={m.id} n={i + 1} name={m.name} description={m.description} />
        ))}
      </div>
    )
  }
  if (active === 'hooks') {
    if (row.hooks === 0) return <EmptyState title="no components" />
    return (
      <div>
        <ContentRow
          n={1}
          name={`${row.hooks} ${row.hooks === 1 ? 'hook' : 'hooks'} configured`}
          description={`${row.path}/hooks/hooks.json`}
        />
      </div>
    )
  }
  if (active === 'monitors') {
    if (row.monitors === 0) return <EmptyState title="no components" />
    return (
      <div>
        <ContentRow
          n={1}
          name={`${row.monitors} ${row.monitors === 1 ? 'monitor' : 'monitors'} configured`}
          description={`${row.path}/monitors/monitors.json`}
        />
      </div>
    )
  }
  if (active === 'lsp') {
    if (!row.hasLsp) return <EmptyState title="no components" />
    return (
      <div>
        <ContentRow n={1} name="LSP server enabled" description={`${row.path}/.lsp.json`} />
      </div>
    )
  }
  if (files.length === 0) return <EmptyState title="no components" />
  return (
    <div>
      {files.map((f, i) => (
        <ContentRow key={f} n={i + 1} name={f} description={null} />
      ))}
    </div>
  )
}

function ContentRow({
  n,
  name,
  description,
  onClick,
}: {
  n: number
  name: string
  description: string | null
  onClick?: () => void
}) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      onClick={onClick}
      className={`w-full flex items-baseline gap-2.5 py-[9px] px-3 border-b border-line text-left min-w-0 ${
        onClick ? 'hover:bg-bg-hi cursor-pointer' : ''
      }`}
    >
      <span className="font-serif text-fg-faint text-xs shrink-0 w-6 text-right">
        {String(n).padStart(2, '0')}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-mono font-semibold text-accent truncate">{name}</div>
        {description ? <div className="text-fg-dim text-xs truncate">{description}</div> : null}
      </div>
    </Tag>
  )
}

async function inspectPluginDir(e: DirEntry): Promise<PluginRow> {
  // Docs locate the manifest under `.claude-plugin/plugin.json`; some installs
  // still use root-level `plugin.json` — try both, prefer the canonical path.
  let manifestPath = `${e.path}/.claude-plugin/plugin.json`
  let hasManifest = await window.api.config.exists(manifestPath)
  if (!hasManifest) {
    manifestPath = `${e.path}/plugin.json`
    hasManifest = await window.api.config.exists(manifestPath)
  }
  let manifest: PluginManifest | null = null
  if (hasManifest) {
    const r = await window.api.config.readJson(manifestPath)
    if (r.exists && !r.parseError && r.data && typeof r.data === 'object') {
      manifest = r.data as PluginManifest
    }
  }

  const [hasLsp, hasMcp, hasMonitorsFile, hasHooksFile] = await Promise.all([
    window.api.config.exists(`${e.path}/.lsp.json`),
    window.api.config.exists(`${e.path}/.mcp.json`),
    window.api.config.exists(`${e.path}/monitors/monitors.json`),
    window.api.config.exists(`${e.path}/hooks/hooks.json`),
  ])

  let monitors = 0
  if (hasMonitorsFile) {
    const r = await window.api.config.readJson(`${e.path}/monitors/monitors.json`)
    if (Array.isArray(r.data)) monitors = r.data.length
    else if (r.data && typeof r.data === 'object' && Array.isArray((r.data as Record<string, unknown>).monitors)) {
      monitors = ((r.data as Record<string, unknown>).monitors as unknown[]).length
    }
  }

  let hooks = 0
  if (hasHooksFile) {
    const r = await window.api.config.readJson(`${e.path}/hooks/hooks.json`)
    if (r.data && typeof r.data === 'object') {
      const obj = r.data as Record<string, unknown>
      // hooks.json mirrors settings.json's `hooks` shape: keyed by event.
      hooks = Object.values(obj).reduce<number>((acc, ev) => {
        if (!Array.isArray(ev)) return acc
        return (
          acc +
          ev.reduce<number>(
            (a, g) =>
              a +
              (Array.isArray((g as { hooks?: unknown[] }).hooks)
                ? (g as { hooks: unknown[] }).hooks.length
                : 0),
            0,
          )
        )
      }, 0)
    }
  }

  const [agentsList, binList, skillsList] = await Promise.all([
    listOrEmpty(`${e.path}/agents`, { filesOnly: true }),
    listOrEmpty(`${e.path}/bin`, { filesOnly: true }),
    listOrEmpty(`${e.path}/skills`, { dirsOnly: true }),
  ])
  const agents = agentsList.filter((f) => f.endsWith('.md')).length
  const binCount = binList.length
  const skills = skillsList.length

  return {
    name: e.name,
    path: e.path,
    mtimeMs: e.mtimeMs,
    hasManifest,
    manifest,
    hasLsp,
    monitors,
    hooks,
    agents,
    skills,
    binCount,
    hasMcp,
  }
}

async function listOrEmpty(
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
