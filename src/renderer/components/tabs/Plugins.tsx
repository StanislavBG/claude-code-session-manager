import { useEffect, useMemo, useState } from 'react'
import { Panel } from '../ui/Panel'
import { KVTable, type Column } from '../ui/KVTable'
import { EmptyState } from '../ui/EmptyState'
import { ProvenanceBadge } from '../ui/ProvenanceBadge'
import { useHomeDir } from '../../lib/useHomeDir'
import type { DirEntry } from '../../../preload/api'
import { PluginsLibrary } from './Library'
import { PluginsDiscover } from './plugins/PluginsDiscover'

type PluginsView = 'installed' | 'library' | 'discover'

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
}

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
      const r = await window.api.config.listDir(`${home}/.claude/plugins`, {
        dirsOnly: true,
      })
      if (cancelled) return
      const next: PluginRow[] = []
      for (const e of r.entries as DirEntry[]) {
        const row = await inspectPluginDir(e)
        next.push(row)
      }
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
    { key: 'name', header: 'name', render: (r) => r.name, width: '12rem' },
    {
      key: 'origin',
      header: 'origin',
      render: (r) => (
        <ProvenanceBadge
          interactive={false}
          input={{ type: 'plugin', name: r.name, repository: r.manifest?.repository, homepage: r.manifest?.homepage }}
        />
      ),
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

  const installedSlugs = useMemo(() => new Set(rows.map((r) => r.name)), [rows])

  const reloadInstalled = async () => {
    if (!home) return
    const r = await window.api.config.listDir(`${home}/.claude/plugins`, { dirsOnly: true })
    const next: PluginRow[] = []
    for (const e of r.entries as DirEntry[]) {
      const row = await inspectPluginDir(e)
      next.push(row)
    }
    next.sort((a, b) => a.name.localeCompare(b.name))
    setRows(next)
  }

  if (view === 'library') {
    return (
      <Panel toolbar={<PluginsViewTabs active={view} onChange={setView} />}>
        <PluginsLibrary />
      </Panel>
    )
  }

  if (view === 'discover') {
    return (
      <Panel toolbar={<PluginsViewTabs active={view} onChange={setView} />}>
        <PluginsDiscover
          installedSlugs={installedSlugs}
          onInstalled={() => {
            // Refresh installed list so the row flips to "installed" without
            // requiring a tab switch. Best-effort; ignore errors.
            reloadInstalled().catch(() => { /* */ })
          }}
        />
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
          {selectedRow && (
            <ProvenanceBadge
              input={{ type: 'plugin', name: selectedRow.name, repository: selectedRow.manifest?.repository, homepage: selectedRow.manifest?.homepage }}
              className="mr-2"
            />
          )}
          <span className="text-fg-faint font-mono truncate">~/.claude/plugins/</span>
        </>
      }
    >
      {loading ? (
        <EmptyState title="scanning plugins…" />
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
          {selectedRow ? (
            <PluginDetail row={selectedRow} onClose={() => setSelected(null)} />
          ) : null}
        </div>
      )}
    </Panel>
  )
}

/**
 * 3-way tab switcher: Installed / Discover / Library. ViewSwitcher in
 * Library.tsx is locked to 2-way for the other tabs that use it (Skills,
 * MCP Servers), so Plugins ships its own.
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
    ['discover', 'Discover'],
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

function PluginDetail({ row, onClose }: { row: PluginRow; onClose: () => void }) {
  return (
    <div className="border-t border-line p-3 text-xs space-y-1 bg-bg-elev max-h-64 overflow-auto">
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium text-fg">{row.manifest?.name ?? row.name}</span>
        <button onClick={onClose} className="text-fg-faint hover:text-fg">×</button>
      </div>
      {row.manifest?.description ? (
        <div className="text-fg-dim">{row.manifest.description}</div>
      ) : null}
      <div className="font-mono text-fg-faint">{row.path}</div>
      {row.manifest ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 pt-1">
          {row.manifest.version ? <Kv k="version" v={row.manifest.version} /> : null}
          {row.manifest.license ? <Kv k="license" v={row.manifest.license} /> : null}
          {row.manifest.homepage ? <Kv k="homepage" v={row.manifest.homepage} /> : null}
          {row.manifest.repository ? <Kv k="repository" v={row.manifest.repository} /> : null}
          {row.manifest.author ? (
            <Kv
              k="author"
              v={typeof row.manifest.author === 'string' ? row.manifest.author : row.manifest.author.name ?? ''}
            />
          ) : null}
        </div>
      ) : null}
      <div className="pt-1 text-fg-faint">
        contents — agents: {row.agents} · skills: {row.skills} · hooks: {row.hooks} · monitors:{' '}
        {row.monitors} · bin: {row.binCount} · lsp: {row.hasLsp ? 'yes' : 'no'} · mcp:{' '}
        {row.hasMcp ? 'yes' : 'no'}
      </div>
    </div>
  )
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-fg-faint w-20">{k}</span>
      <span className="text-fg font-mono truncate">{v}</span>
    </div>
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
