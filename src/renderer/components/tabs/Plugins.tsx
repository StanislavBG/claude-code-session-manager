import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Panel } from '../ui/Panel'
import { KVTable, type Column } from '../ui/KVTable'
import { EmptyState } from '../ui/EmptyState'
import { ProvenanceBadge } from '../ui/ProvenanceBadge'
import { Badge } from '../ui/Badge'
import type { ProvenanceInput } from '../../lib/provenance'
import { useHomeDir } from '../../lib/useHomeDir'
import { useConfigDirWatch } from '../../lib/useConfigDirWatch'
import type { DirEntry, SeedStatus } from '../../../preload/api'
import { PluginsLibrary } from './Library'
import { resolveInstalledPluginSkillsDir, listPluginSkills, type PluginSkillEntry } from '../../lib/pluginSkills'
import { parseSkillMeta } from '../../lib/skillFrontmatter'
import { SkillHomePage } from './plugins/PluginSkillBrowser'
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
  /** Component declarations: a relative path, an array of paths, or (hooks/mcpServers) an inline object. */
  commands?: unknown
  agents?: unknown
  hooks?: unknown
  mcpServers?: unknown
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
  commands: number
  skills: number
  binCount: number
  hasMcp: boolean
  /** Part of the `installed_plugins.json` key after `@`; the marketplace the plugin came from. */
  marketplace?: string
  /** Set when inspecting this plugin's directory threw; the row is listed with this marker instead of failing the list. */
  error?: string
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
function PluginsComponent() {
  const home = useHomeDir()
  const [rows, setRows] = useState<PluginRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<PluginsView>('installed')
  const [seedStatus, setSeedStatus] = useState<SeedStatus | null>(null)
  const [dismissedSeeders, setDismissedSeeders] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    window.api.app
      .seedStatus?.()
      .then((s) => {
        if (!cancelled) setSeedStatus(s)
      })
      .catch(() => {
        /* no seed status available — banner simply stays hidden */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Callable both on mount/home-resolve and from the manifest-file watch
  // below (Plugins.tsx used to only read once at mount — an external edit to
  // installed_plugins.json, e.g. `claude plugin install` run outside this
  // app, was invisible until reload).
  const loadSeq = useRef(0)
  const hasRows = useRef(false)
  const loadRows = useCallback(async () => {
    // Bumped before the early return too, so a still-in-flight call from a
    // since-unset `home` can never win a race against a later valid call.
    const seq = ++loadSeq.current
    if (!home) return
    // Only the first load (no rows yet) blanks the page; a refresh keeps the
    // current rows and any open drill-in mounted until the new list resolves.
    if (!hasRows.current) setLoading(true)
    const manifestPath = `${home}/.claude/plugins/installed_plugins.json`
    let next: PluginRow[] = []
    let failure: string | null = null
    try {
      const r = await window.api.config.readJson(manifestPath)
      if (r.exists && r.parseError) {
        failure = `could not parse installed_plugins.json${r.error ? `: ${r.error}` : ''}`
      } else if (r.exists && r.data && typeof r.data === 'object') {
        const manifest = r.data as InstalledPluginsManifest
        const jobs: Array<{ name: string; marketplace: string | undefined; entry: InstalledPluginEntry }> = []
        for (const [key, entries] of Object.entries(manifest.plugins ?? {})) {
          if (!Array.isArray(entries)) continue
          const [name, marketplace] = key.split('@')
          for (const entry of entries) {
            if (!entry?.installPath) continue
            jobs.push({ name, marketplace, entry })
          }
        }
        next = await mapWithConcurrency(jobs, INSPECT_CONCURRENCY, async ({ name, marketplace, entry }) => {
          const dirEntry: DirEntry = {
            name,
            path: entry.installPath,
            isDirectory: true,
            isFile: false,
            mtimeMs: 0,
            size: 0,
          }
          let row: PluginRow
          try {
            row = await inspectPluginDir(dirEntry)
          } catch (err) {
            row = failedPluginRow(dirEntry, err instanceof Error ? err.message : String(err))
          }
          if (!row.manifest?.version) {
            row.manifest = { ...(row.manifest ?? {}), version: entry.version }
          }
          row.marketplace = marketplace
          return row
        })
      }
    } catch (err) {
      failure = `could not read installed_plugins.json: ${err instanceof Error ? err.message : String(err)}`
    }
    if (loadSeq.current !== seq) return
    setLoadError(failure)
    if (failure) {
      toast.error(`Plugins: ${failure}`)
    } else {
      next.sort((a, b) => a.name.localeCompare(b.name))
      hasRows.current = next.length > 0
      setRows(next)
    }
    setLoading(false)
  }, [home])

  useEffect(() => { void loadRows() }, [loadRows])

  // Invalidate any still-in-flight loadRows on actual unmount — the seq bump
  // above only covers a NEW call superseding an old one; nothing else calls
  // loadRows after the component is gone.
  useEffect(() => () => { loadSeq.current += 1 }, [])

  useConfigDirWatch(home ? [`${home}/.claude/plugins/installed_plugins.json`] : [], loadRows)

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
            r.commands > 0 ? `${r.commands} commands` : null,
            r.skills > 0 ? `${r.skills} skills` : null,
            r.hooks > 0 ? `${r.hooks} hooks` : null,
            r.monitors > 0 ? `${r.monitors} monitors` : null,
            r.binCount > 0 ? `${r.binCount} bin` : null,
            r.hasLsp ? 'lsp' : null,
            r.hasMcp ? 'mcp' : null,
            r.error ? 'inspection failed' : null,
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

  const exhaustedSeeders = useMemo(() => {
    if (!seedStatus) return []
    return (Object.keys(seedStatus) as Array<keyof SeedStatus>).filter(
      (id) => seedStatus[id].status === 'exhausted' && !dismissedSeeders.has(id),
    )
  }, [seedStatus, dismissedSeeders])

  const seedBanner =
    exhaustedSeeders.length > 0 ? (
      <SeedStatusBanner
        seeders={exhaustedSeeders}
        seedStatus={seedStatus!}
        onDismiss={(id) => setDismissedSeeders((prev) => new Set(prev).add(id))}
        onOpenLibrary={() => setView('library')}
      />
    ) : null

  if (view === 'library') {
    return (
      <Panel toolbar={<PluginsViewTabs active={view} onChange={setView} />}>
        {seedBanner}
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
      {seedBanner}
      {loadError ? (
        <div role="alert" className="shrink-0 px-3 py-2 border-b border-line bg-red-950/20 text-xs text-red-300">
          {loadError}
          {rows.length > 0 ? ' — showing the last known list' : null}
        </div>
      ) : null}
      {loading && rows.length === 0 ? (
        <EmptyState title="scanning plugins…" />
      ) : loadError && rows.length === 0 ? null : selectedRow ? (
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

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const Plugins = memo(PluginsComponent)

const SEEDER_LABELS: Record<keyof SeedStatus, string> = {
  'dev-plugin': 'session-manager-dev plugin',
  'scheduler-mcp': 'Scheduler MCP server',
  'agent-personas': 'Agent personas (Architect, Dev Lead)',
}

/**
 * Dismissible warning banner for a first-boot seeder that gave up after
 * MAX_ATTEMPTS. Dismissal is in-memory only (component state) — the marker
 * files stay the single source of truth for seed state, so reloading the tab
 * (or restarting the app) re-shows the banner until the manual fix is applied.
 */
function SeedStatusBanner({
  seeders,
  seedStatus,
  onDismiss,
  onOpenLibrary,
}: {
  seeders: Array<keyof SeedStatus>
  seedStatus: SeedStatus
  onDismiss: (id: keyof SeedStatus) => void
  onOpenLibrary: () => void
}) {
  return (
    <div className="shrink-0 flex flex-col gap-1.5 px-3 py-2 border-b border-line bg-yellow-950/20">
      {seeders.map((id) => (
        <div key={id} className="flex items-start gap-2 text-xs text-yellow-300">
          <div className="flex-1 min-w-0">
            <div className="font-medium">{SEEDER_LABELS[id]} setup failed after retrying — manual fix needed</div>
            {id === 'dev-plugin' ? (
              <div className="text-yellow-400/80 mt-0.5">
                Click <button onClick={onOpenLibrary} className="underline hover:no-underline">here</button> to open the
                Library tab, then click Install next to "session-manager-dev".
              </div>
            ) : (
              <div className="text-yellow-400/80 mt-0.5 font-mono">{seedStatus[id].fix}</div>
            )}
          </div>
          <button
            onClick={() => onDismiss(id)}
            className="shrink-0 text-yellow-400/70 hover:text-yellow-300"
            aria-label={`Dismiss ${SEEDER_LABELS[id]} warning`}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
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

const DETAIL_RELOAD_DEBOUNCE_MS = 250
/** Plugin component locations (relative to the install path) that feed the drill-in. */
const COMPONENT_WATCH_SUFFIXES = [
  'hooks/hooks.json',
  '.mcp.json',
  '.lsp.json',
  'agents',
  'skills',
  'commands',
  '.claude-plugin/plugin.json',
] as const

type SectionKey = 'skills' | 'agents' | 'commands' | 'mcp' | 'hooks' | 'monitors' | 'lsp' | 'files'

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
  const [commands, setCommands] = useState<AgentEntry[]>([])
  const [mcpServers, setMcpServers] = useState<McpEntry[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [active, setActive] = useState<SectionKey>('skills')
  const [browsingSkill, setBrowsingSkill] = useState<PluginSkillEntry | null>(null)
  const [loading, setLoading] = useState(true)

  const [watchPaths, setWatchPaths] = useState<string[]>([])
  const loadSeq = useRef(0)
  const activePicked = useRef(false)

  const loadDetail = useCallback(async () => {
    if (!home) return
    const seq = ++loadSeq.current
    try {
      const { manifest } = await readPluginManifest(row.path)
      const [skillsDir, comps, binFiles] = await Promise.all([
        resolveInstalledPluginSkillsDir(row.name, row.path, home),
        resolvePluginComponents(row.path, manifest),
        listOrEmpty(`${row.path}/bin`, { filesOnly: true }),
      ])
      const skillEntries = skillsDir ? await listPluginSkills(skillsDir) : []
      const [agentEntries, commandEntries] = await Promise.all([
        readMdEntries(comps.agentFiles),
        readMdEntries(comps.commandFiles),
      ])
      const mcpEntries: McpEntry[] = comps.mcpServers
      const existing = await Promise.all(
        [...new Set([...COMPONENT_WATCH_SUFFIXES.map((x) => `${row.path}/${x}`), ...comps.sourcePaths])].map(
          async (p) => ((await window.api.config.exists(p)) ? p : null),
        ),
      )

      if (seq !== loadSeq.current) return
      setSkills(skillEntries)
      setAgents(agentEntries)
      setCommands(commandEntries)
      setMcpServers(mcpEntries)
      setFiles(binFiles)
      const nextWatch = existing.filter((p): p is string => p !== null)
      setWatchPaths((prev) => (prev.join('\0') === nextWatch.join('\0') ? prev : nextWatch))
      if (!activePicked.current) {
        activePicked.current = true
        setActive(
          skillEntries.length > 0
            ? 'skills'
            : agentEntries.length > 0
              ? 'agents'
              : commandEntries.length > 0
                ? 'commands'
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
      }
    } catch (err) {
      if (seq !== loadSeq.current) return
      toast.error(`Failed to load plugin contents: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [row.path, row.name, row.hooks, row.monitors, row.hasLsp, home])

  useEffect(() => {
    setLoading(true)
    void loadDetail()
    return () => {
      loadSeq.current += 1
    }
  }, [loadDetail])

  // Coalesce change bursts (250 ms), and never run two reloads at once: a
  // change landing mid-reload queues exactly one trailing reload.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reloading = useRef(false)
  const reloadAgain = useRef(false)
  const runReload = useCallback(async () => {
    if (reloading.current) {
      reloadAgain.current = true
      return
    }
    reloading.current = true
    try {
      do {
        reloadAgain.current = false
        await loadDetail()
      } while (reloadAgain.current)
    } finally {
      reloading.current = false
    }
  }, [loadDetail])
  const onComponentChange = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current)
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null
      void runReload()
    }, DETAIL_RELOAD_DEBOUNCE_MS)
  }, [runReload])
  useEffect(
    () => () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current)
    },
    [],
  )
  useConfigDirWatch(watchPaths, onComponentChange, { depth: 0 })

  const sections: Array<{ key: SectionKey; label: string; count: number }> = [
    { key: 'skills', label: 'Skills', count: skills.length },
    { key: 'agents', label: 'Agents', count: agents.length },
    { key: 'commands', label: 'Commands', count: commands.length },
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

  if (browsingSkill) {
    return (
      <SkillHomePage
        key={browsingSkill.id}
        pluginName={row.manifest?.name ?? row.name}
        skills={skills}
        initialSelectedId={browsingSkill.id}
        onBack={() => setBrowsingSkill(null)}
      />
    )
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
              commands={commands}
              mcpServers={mcpServers}
              files={files}
              onOpenSkill={setBrowsingSkill}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function SectionContent({
  active,
  row,
  skills,
  agents,
  commands,
  mcpServers,
  files,
  onOpenSkill,
}: {
  active: SectionKey
  row: PluginRow
  skills: PluginSkillEntry[]
  agents: AgentEntry[]
  commands: AgentEntry[]
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
  if (active === 'commands') {
    if (commands.length === 0) return <EmptyState title="no components" />
    return (
      <div>
        {commands.map((c, i) => (
          <ContentRow key={c.id} n={i + 1} name={c.name ?? c.id} description={c.description} />
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

const INSPECT_CONCURRENCY = 4

/** Order-preserving map with at most `limit` calls in flight. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

function failedPluginRow(e: DirEntry, error: string): PluginRow {
  return {
    name: e.name, path: e.path, mtimeMs: e.mtimeMs, hasManifest: false, manifest: null, hasLsp: false,
    monitors: 0, hooks: 0, agents: 0, commands: 0, skills: 0, binCount: 0, hasMcp: false, error,
  }
}

async function inspectPluginDir(e: DirEntry): Promise<PluginRow> {
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

  const [comps, binList, skillsList] = await Promise.all([
    resolvePluginComponents(e.path, manifest),
    listOrEmpty(`${e.path}/bin`, { filesOnly: true }),
    listOrEmpty(`${e.path}/skills`, { dirsOnly: true }),
  ])
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
    hooks: comps.hooks,
    agents: comps.agentFiles.length,
    commands: comps.commandFiles.length,
    skills,
    binCount,
    hasMcp: comps.mcpServers.length > 0,
  }
}

/** Docs locate the manifest under `.claude-plugin/plugin.json`; some installs still use root-level `plugin.json`. */
async function readPluginManifest(root: string): Promise<{ hasManifest: boolean; manifest: PluginManifest | null }> {
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

interface ResolvedComponents {
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
async function resolvePluginComponents(root: string, manifest: PluginManifest | null): Promise<ResolvedComponents> {
  const locations = (declared: unknown, fallback: string): string[] => {
    const out = new Set<string>()
    for (const d of declaredPaths(declared)) {
      const p = resolveInRoot(root, d)
      if (p) out.add(p)
    }
    out.add(`${root}/${fallback}`)
    return [...out]
  }
  const mdFiles = async (paths: string[]): Promise<string[]> => {
    const out = new Set<string>()
    for (const p of paths) {
      if (p.endsWith('.md')) out.add(p)
      else for (const n of await listOrEmpty(p, { filesOnly: true })) if (n.endsWith('.md')) out.add(`${p}/${n}`)
    }
    return [...out]
  }
  const readJsonData = async (p: string): Promise<unknown> => {
    try {
      const r = await window.api.config.readJson(p)
      return r.exists && !r.parseError ? r.data : null
    } catch {
      return null
    }
  }

  const commandPaths = locations(manifest?.commands, 'commands')
  const agentPaths = locations(manifest?.agents, 'agents')
  const hookDecl = manifest?.hooks
  const hookPaths = locations(typeof hookDecl === 'string' || Array.isArray(hookDecl) ? hookDecl : undefined, 'hooks/hooks.json')
  const mcpDecl = manifest?.mcpServers
  const mcpPaths = locations(typeof mcpDecl === 'string' || Array.isArray(mcpDecl) ? mcpDecl : undefined, '.mcp.json')

  const [commandFiles, agentFiles, hookBodies, mcpBodies] = await Promise.all([
    mdFiles(commandPaths),
    mdFiles(agentPaths),
    Promise.all(hookPaths.map(readJsonData)),
    Promise.all(mcpPaths.map(readJsonData)),
  ])

  const hooks = [...(isRecord(hookDecl) ? [hookDecl] : []), ...hookBodies].reduce<number>((n, b) => n + countHooks(b), 0)

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

  return {
    commandFiles,
    agentFiles,
    hooks,
    mcpServers: [...servers.values()],
    sourcePaths: [...commandPaths, ...agentPaths, ...hookPaths, ...mcpPaths],
  }
}

/** Name + description of each `.md` component file (name defaults to the file's basename). */
async function readMdEntries(files: string[]): Promise<AgentEntry[]> {
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
