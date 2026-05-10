import { useEffect, useState } from 'react'
import { Panel } from '../ui/Panel'
import { KVTable, type Column } from '../ui/KVTable'
import { EmptyState } from '../ui/EmptyState'
import { useHomeDir } from '../../lib/useHomeDir'
import type { DirEntry } from '../../../preload/api'
import { PluginsLibrary, ViewSwitcher } from './Library'

interface PluginRow {
  name: string
  path: string
  mtimeMs: number
  hasManifest: boolean
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
  const [view, setView] = useState<'installed' | 'library'>('installed')

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
        const hasManifest = await window.api.config.exists(`${e.path}/plugin.json`)
        next.push({
          name: e.name,
          path: e.path,
          mtimeMs: e.mtimeMs,
          hasManifest,
        })
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
      key: 'manifest',
      header: 'manifest',
      render: (r) => (r.hasManifest ? 'plugin.json' : <span className="text-fg-faint">—</span>),
      width: '8rem',
    },
    {
      key: 'path',
      header: 'path',
      render: (r) => <span className="font-mono text-fg-faint truncate">{r.path}</span>,
    },
  ]

  if (view === 'library') {
    return (
      <Panel toolbar={<ViewSwitcher active={view} onChange={setView} />}>
        <PluginsLibrary />
      </Panel>
    )
  }

  return (
    <Panel
      toolbar={
        <>
          <ViewSwitcher active={view} onChange={setView} />
          <span className="mx-2 text-fg-faint">·</span>
          <span className="text-fg-faint">{rows.length} plugins</span>
          <div className="flex-1" />
          <span className="text-fg-faint font-mono truncate">~/.claude/plugins/</span>
        </>
      }
    >
      {loading ? (
        <EmptyState title="scanning plugins…" />
      ) : (
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
      )}
    </Panel>
  )
}
