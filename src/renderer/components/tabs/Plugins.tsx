import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState } from '../ui/EmptyState'
import { useHomeDir } from '../../lib/useHomeDir'
import { useConfigDirWatch } from '../../lib/useConfigDirWatch'
import type { DirEntry, SeedStatus } from '../../../preload/api'
import { failedPluginRow, inspectPluginDir, summarizePluginContents, type PluginRow } from '../../lib/pluginContents'
import {
  ConfigFileCard,
  ConfigListRow,
  ConfigListToolbar,
  ConfigWorkbench,
} from '../claudeConfig/ConfigLayout'
import { PluginDetail, type PluginJumpTab } from './plugins/PluginDetail'
import { PluginSwitch } from './plugins/PluginSwitch'
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

const MANIFEST_LABEL = '~/.claude/plugins/installed_plugins.json'
const ENABLED_NOTE = 'On/off is saved in settings.json › enabledPlugins'

/** Without an `onJump` from the hosting page, `Open in Skills →` opens Extensions on that tab through its tab hint. */
const jumpViaLayout = (tab: PluginJumpTab) => useLayout.getState().openPanel('extensions', tab)

/** A plugin matches the filter when its name, manifest name, marketplace or description contains it (case-insensitive). */
function matchesFilter(r: PluginRow, needle: string): boolean {
  return [r.name, r.manifest?.name, r.marketplace, r.manifest?.description].some(
    (s) => typeof s === 'string' && s.toLowerCase().includes(needle),
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** `<marketplace> · 3 commands · 6 agents` — zero counts left out; a non-user install names its scope. */
export function pluginRowMeta(r: PluginRow): string {
  const c = summarizePluginContents(r)
  const parts: string[] = []
  if (r.marketplace) parts.push(r.marketplace)
  if (r.error) parts.push('inspection failed')
  else {
    const kinds = [
      c.commands > 0 ? plural(c.commands, 'command', 'commands') : null,
      c.skills > 0 ? plural(c.skills, 'skill', 'skills') : null,
      c.agents > 0 ? plural(c.agents, 'agent', 'agents') : null,
      c.hooks > 0 ? plural(c.hooks, 'hook', 'hooks') : null,
      c.mcpServers > 0 ? plural(c.mcpServers, 'MCP server', 'MCP servers') : null,
    ].filter((k): k is string => k !== null)
    parts.push(...(kinds.length > 0 ? kinds : ['empty']))
  }
  if (r.scope && r.scope !== 'user') parts.push(`${r.scope} scope`)
  return parts.join(' · ')
}

interface PluginsProps {
  /** Opens the catalog drawer (`+ Add`). */
  onAdd?: () => void
  /** Switches the hosting page's tab for `Open in Skills →`. */
  onJump?: (tab: PluginJumpTab) => void
}

/**
 * Installed plugins come from `~/.claude/plugins/installed_plugins.json` (written by the `claude` CLI; installs
 * happen via the catalog drawer or `claude plugin install`). Laid out on the Claude config workbench
 * (design-mocks/claude-config render 14): a PLUGINS file card, Filter + `+ Add`, one row per install with its
 * enable switch (settings.json enabledPlugins), and a PluginDetail for the selected one — manifest description,
 * what it adds, where it is installed, and a ⋯ menu with Uninstall. Editing a plugin's components would
 * duplicate the Skills/Agents/Hooks tabs — out of scope.
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

  // The detail's ⋯ menu has already confirmed inline; no native confirm here.
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

  const enabledCount = useMemo(() => rows.filter((r) => r.enabled === true).length, [rows])
  const needle = filter.trim().toLowerCase()
  const visibleRows = useMemo(() => (needle ? rows.filter((r) => matchesFilter(r, needle)) : rows), [rows, needle])
  // The picked row while it is still installed and visible; otherwise the first visible row.
  const selectedRow = visibleRows.find((r) => r.path === selected) ?? visibleRows[0] ?? null
  const add = useCallback(() => onAdd?.(), [onAdd])
  const jump = onJump ?? jumpViaLayout
  const isBusy = (r: PluginRow) => busyKey !== null && busyKey === (r.key ?? r.name)

  const list = (
    <>
      <ConfigFileCard eyebrow="PLUGINS" badge={`${enabledCount} on`} path={MANIFEST_LABEL} note={ENABLED_NOTE} />
      <ConfigListToolbar filter={filter} onFilterChange={setFilter} placeholder="Filter" primaryLabel="+ Add" onPrimary={add} />
      {loading && rows.length === 0 ? null : loadError && rows.length === 0 ? null : rows.length === 0 ? (
        <div
          data-testid="plugins-empty"
          className="flex flex-col gap-1 px-3 py-3 border border-dashed border-rule rounded-xl text-[13px] text-fg-dim"
        >
          <span className="font-semibold text-fg">No plugins installed</span>
          <span>
            Use + Add, or run <code className="font-mono text-xs">claude plugin install</code>.
          </span>
        </div>
      ) : visibleRows.length === 0 ? (
        <p className="px-1 text-[13px] text-fg-dim">No plugins match “{filter.trim()}”.</p>
      ) : (
        <div role="listbox" aria-label="Installed plugins" className="flex flex-col gap-1">
          {visibleRows.map((r) => (
            <ConfigListRow
              key={r.path}
              title={r.name}
              meta={pluginRowMeta(r)}
              muted={r.enabled !== true}
              selected={selectedRow?.path === r.path}
              onSelect={() => setSelected(r.path)}
              trailing={
                <PluginSwitch
                  name={r.name}
                  enabled={r.enabled === true}
                  disabled={!r.key || isBusy(r)}
                  onToggle={() => void onToggle(r)}
                />
              }
            />
          ))}
        </div>
      )}
    </>
  )

  const detail = selectedRow ? (
    <PluginDetail
      key={selectedRow.path}
      row={selectedRow}
      home={home}
      busy={isBusy(selectedRow)}
      onToggle={(r) => void onToggle(r)}
      onUninstall={(r) => void onUninstall(r)}
      onJump={jump}
    />
  ) : loading ? (
    <EmptyState title="scanning plugins…" />
  ) : loadError ? null : rows.length === 0 ? (
    <EmptyState title="No plugins installed" hint="+ Add browses the plugin catalog." />
  ) : (
    <EmptyState title="No plugin matches the filter" />
  )

  return (
    <div className="flex flex-col h-full min-h-0">
      {exhaustedSeeders.length > 0 ? (
        <SeedStatusBanner
          seeders={exhaustedSeeders}
          seedStatus={seedStatus!}
          onDismiss={(id) => setDismissedSeeders((prev) => new Set(prev).add(id))}
          onOpenLibrary={add}
        />
      ) : null}
      {loadError ? (
        <div role="alert" className="shrink-0 px-3 py-2 border-b border-line bg-red-950/20 text-xs text-red-300">
          {loadError}
          {rows.length > 0 ? ' — showing the last known list' : null}
        </div>
      ) : null}
      <ConfigWorkbench list={list} detail={detail} />
    </div>
  )
}

// Memoized: hosts pass stable onAdd/onJump callbacks; own data comes from store/IPC hooks inside.
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
