import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState } from '../ui/EmptyState'
import { ProvenanceBadge } from '../ui/ProvenanceBadge'
import { Badge } from '../ui/Badge'
import { useHomeDir } from '../../lib/useHomeDir'
import { useConfigDirWatch } from '../../lib/useConfigDirWatch'
import type { DirEntry, SeedStatus } from '../../../preload/api'
import { resolveInstalledPluginSkillsDir, listPluginSkills, type PluginSkillEntry } from '../../lib/pluginSkills'
import {
  failedPluginRow,
  inspectPluginDir,
  listOrEmpty,
  readMdEntries,
  readPluginManifest,
  resolvePluginComponents,
  type AgentEntry,
  type McpEntry,
  type PluginRow,
} from '../../lib/pluginContents'
import { SkillHomePage } from './plugins/PluginSkillBrowser'
import { PluginCard, pluginProvInput, type PluginJumpTab } from './plugins/PluginCard'
import { ExtensionsToolbar } from './extensions/ExtensionsToolbar'
import { useLayout } from '../../state/layout'
import { toast, useToast } from '../../state/toast'

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

const FOOTNOTE = 'Plugin contents also appear, read-only, in Skills and MCP Servers — tagged with the plugin that added them.'

/** Without an `onJump` from the Extensions page, a chip opens that page on the tab through its tab hint. */
const jumpViaLayout = (tab: PluginJumpTab) => useLayout.getState().openPanel('extensions', tab)

/** A plugin matches the filter when its name, manifest name or description contains it (case-insensitive). */
function matchesFilter(r: PluginRow, needle: string): boolean {
  return [r.name, r.manifest?.name, r.manifest?.description].some((s) => typeof s === 'string' && s.toLowerCase().includes(needle))
}

interface PluginsProps {
  /** Opens the catalog drawer (the `+ Add plugin` menu's `Browse catalog…`). */
  onAdd?: () => void
  /** Switches the Extensions tab for a card's `›` chip. */
  onJump?: (tab: PluginJumpTab) => void
}

/**
 * Installed plugins come from `~/.claude/plugins/installed_plugins.json` (written by the `claude` CLI; installs
 * happen via the catalog drawer or `claude plugin install`). Each entry's `installPath` bundles skills,
 * subagents, and hooks. In the 3a design (DESIGN_SPEC §5) each plugin is a PluginCard — enable switch
 * (settings.json enabledPlugins), contents chips that jump to the tab holding them, and a ⋯ menu with
 * Uninstall — under the shared ExtensionsToolbar; the card's name opens the PluginHomePage drill-in.
 * Editing a plugin's components would duplicate the Skills/Subagents/Hooks tabs — out of scope.
 */
function PluginsComponent({ onAdd, onJump }: PluginsProps) {
  const home = useHomeDir()
  const [rows, setRows] = useState<PluginRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [seedStatus, setSeedStatus] = useState<SeedStatus | null>(null)
  const [dismissedSeeders, setDismissedSeeders] = useState<Set<string>>(new Set())
  const showToast = useToast((s) => s.show)
  const [busyKey, setBusyKey] = useState<string | null>(null)

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
        let enabledByKey = new Map<string, boolean>()
        try {
          const listed = (await window.api.plugins?.list?.()) ?? []
          enabledByKey = new Map(listed.map((p) => [p.key, p.enabled]))
        } catch {
          /* enabled flags unavailable — rows render as off until the next list */
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
          row.scope = entry.scope
          row.key = marketplace ? `${name}@${marketplace}` : name
          row.enabled = enabledByKey.get(row.key) === true
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

  const onToggle = async (r: PluginRow) => {
    if (!r.key) return
    setBusyKey(r.key)
    try {
      const res = await window.api.plugins.setEnabled({ key: r.key, enabled: !r.enabled })
      if (!res.ok) showToast('error', `Could not ${r.enabled ? 'disable' : 'enable'} ${r.name}: ${res.error ?? 'unknown error'}`)
    } catch (err) {
      showToast('error', `Could not update ${r.name}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusyKey(null)
      await loadRows()
    }
  }

  // The card's ⋯ menu has already confirmed inline; no native confirm here.
  const onUninstall = async (r: PluginRow) => {
    if (!r.marketplace) return
    setBusyKey(r.key ?? r.name)
    try {
      const res = await window.api.plugins.uninstall({ slug: r.name, marketplaceName: r.marketplace })
      if (!res.ok) showToast('error', `Uninstall ${r.name} failed: ${res.error ?? `exit ${res.exitCode}`}`)
    } catch (err) {
      showToast('error', `Uninstall ${r.name} failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusyKey(null)
      await loadRows()
    }
  }

  const exhaustedSeeders = useMemo(() => {
    if (!seedStatus) return []
    return (Object.keys(seedStatus) as Array<keyof SeedStatus>).filter(
      (id) => (seedStatus[id].status === 'exhausted' || seedStatus[id].status === 'failed') && !dismissedSeeders.has(id),
    )
  }, [seedStatus, dismissedSeeders])

  const seedBanner =
    exhaustedSeeders.length > 0 ? (
      <SeedStatusBanner
        seeders={exhaustedSeeders}
        seedStatus={seedStatus!}
        onDismiss={(id) => setDismissedSeeders((prev) => new Set(prev).add(id))}
        onOpenLibrary={() => onAdd?.()}
      />
    ) : null

  const selectedRow = selected ? rows.find((r) => r.path === selected) ?? null : null

  const enabledCount = useMemo(() => rows.filter((r) => r.enabled === true).length, [rows])
  const needle = filter.trim().toLowerCase()
  const visibleRows = useMemo(() => (needle ? rows.filter((r) => matchesFilter(r, needle)) : rows), [rows, needle])
  const addPrimary = useMemo(
    () => ({
      label: '+ Add plugin',
      testId: 'plugins-add',
      items: [{ label: 'Browse catalog…', testId: 'plugins-add-catalog', onSelect: () => onAdd?.() }],
    }),
    [onAdd],
  )
  const openRow = useCallback((r: PluginRow) => setSelected(r.path), [])
  const jump = onJump ?? jumpViaLayout

  // The drill-in replaces the whole tab body; it carries its own header and `← Plugins` back link.
  if (selectedRow) {
    return <PluginHomePage key={selectedRow.path} row={selectedRow} home={home} onBack={() => setSelected(null)} />
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <ExtensionsToolbar
        filter={filter}
        onFilterChange={setFilter}
        placeholder="Filter plugins"
        summary={`${rows.length} installed · ${enabledCount} enabled`}
        primary={addPrimary}
      />
      {seedBanner}
      {loadError ? (
        <div role="alert" className="shrink-0 px-3 py-2 border-b border-line bg-red-950/20 text-xs text-red-300">
          {loadError}
          {rows.length > 0 ? ' — showing the last known list' : null}
        </div>
      ) : null}
      <div className="flex-1 min-h-0 overflow-auto">
        {loading && rows.length === 0 ? (
          <EmptyState title="scanning plugins…" />
        ) : loadError && rows.length === 0 ? null : (
          <div className="flex flex-col gap-3 p-4">
            {rows.length === 0 ? (
              <div
                data-testid="plugins-empty"
                className="flex flex-col gap-1 px-[18px] py-4 border border-dashed border-rule rounded-[10px] text-[13px] text-fg-dim"
              >
                <span className="font-semibold text-fg">No plugins installed</span>
                <span>
                  Use + Add plugin, or run <code className="font-mono text-xs">claude plugin install</code>.
                </span>
              </div>
            ) : visibleRows.length === 0 ? (
              <p className="px-1 text-[13px] text-fg-dim">No plugins match “{filter.trim()}”.</p>
            ) : (
              visibleRows.map((r) => (
                <PluginCard
                  key={r.path}
                  row={r}
                  home={home}
                  busy={busyKey !== null && busyKey === (r.key ?? r.name)}
                  onToggle={(row) => void onToggle(row)}
                  onOpen={openRow}
                  onUninstall={(row) => void onUninstall(row)}
                  onJump={jump}
                />
              ))
            )}
            <p className="px-1 text-xs text-fg-faint">{FOOTNOTE}</p>
          </div>
        )}
      </div>
    </div>
  )
}

// Memoized: Extensions passes stable onAdd/onJump callbacks; own data comes from store/IPC hooks inside.
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
            <div className="font-medium">{seedStatus[id].status === 'failed'
                ? `${SEEDER_LABELS[id]} setup failed — it will retry on next launch. To fix it now:`
                : `${SEEDER_LABELS[id]} setup failed after retrying — manual fix needed`}
            </div>
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
        resolveInstalledPluginSkillsDir(row.path),
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
