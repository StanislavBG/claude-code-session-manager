import { useEffect, useMemo, useState } from 'react'
import { Panel } from '../ui/Panel'
import { ListDetail } from '../ui/ListDetail'
import { SaveBar } from '../ui/SaveBar'
import { EmptyState } from '../ui/EmptyState'
import { ScopeSwitcher } from '../ui/ScopeSwitcher'
import { useConfig } from '../../state/config'
import { useActiveTab } from '../../lib/useActiveTab'
import { useHomeDir } from '../../lib/useHomeDir'
import type { Scope } from '../../lib/scopes'
import { McpLibrary, ViewSwitcher } from './Library'

/**
 * MCP servers are stored in ~/.claude.json (user scope) under `mcpServers`,
 * or in .mcp.json at the project root (project scope). Both share the same
 * shape.
 */
type ServerType = 'stdio' | 'http' | 'sse'
interface McpServer {
  type?: ServerType
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
}

function pathFor(scope: Scope, home: string, cwd: string | null): string | null {
  if (scope === 'user') return `${home}/.claude.json`
  if (!cwd) return null
  return `${cwd}/.mcp.json`
}

interface Shape {
  full: Record<string, unknown>
  servers: Record<string, McpServer>
  err: string | null
}

function parse(raw: string): Shape {
  if (raw.trim() === '') return { full: {}, servers: {}, err: null }
  try {
    const full = JSON.parse(raw) as Record<string, unknown>
    const servers = (full.mcpServers as Record<string, McpServer>) ?? {}
    return { full, servers, err: null }
  } catch (e) {
    return { full: {}, servers: {}, err: (e as Error).message }
  }
}
function serialize(full: Record<string, unknown>, servers: Record<string, McpServer>): string {
  return JSON.stringify({ ...full, mcpServers: servers }, null, 2) + '\n'
}

export function McpServers() {
  const home = useHomeDir()
  const activeTab = useActiveTab()
  const cwd = activeTab?.cwd ?? null
  const [scope, setScope] = useState<Scope>('user')
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [view, setView] = useState<'installed' | 'library'>('installed')
  const [filter, setFilter] = useState('')

  const path = useMemo(() => (home ? pathFor(scope, home, cwd) : null), [home, scope, cwd])

  const files = useConfig((s) => s.files)
  const loadJson = useConfig((s) => s.loadJson)
  const setDraft = useConfig((s) => s.setDraft)
  const saveJson = useConfig((s) => s.saveJson)
  const revert = useConfig((s) => s.revert)
  const watchFile = useConfig((s) => s.watchFile)
  const unwatchFile = useConfig((s) => s.unwatchFile)

  useEffect(() => {
    if (!path) return
    if (!files[path]) loadJson(path)
    watchFile(path)
    return () => unwatchFile(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  const [saveError, setSaveError] = useState<string | null>(null)

  if (!home) return <EmptyState title="loading…" />
  if (view === 'library') {
    return (
      <Panel
        toolbar={
          <ViewSwitcher active={view} onChange={setView} />
        }
      >
        <McpLibrary />
      </Panel>
    )
  }
  if (scope === 'project' && !cwd) {
    return (
      <Panel
        toolbar={
          <>
            <ViewSwitcher active={view} onChange={setView} />
            <span className="mx-2 text-fg-faint">·</span>
            <ScopeSwitcher scopes={['user', 'project']} active={scope} onChange={setScope} />
          </>
        }
      >
        <EmptyState title="no active project" />
      </Panel>
    )
  }
  if (!path) return <EmptyState title="loading…" />

  const file = files[path]
  const { full, servers, err } = file ? parse(file.draftRaw) : { full: {}, servers: {}, err: null }
  const names = Object.keys(servers).sort()
  const selected = selectedName ? servers[selectedName] : null

  const updateServers = (next: Record<string, McpServer>) => {
    setSaveError(null)
    setDraft(path, serialize(full, next))
  }

  const addServer = () => {
    const name = `server-${Object.keys(servers).length + 1}`
    updateServers({ ...servers, [name]: { type: 'stdio', command: '', args: [] } })
    setSelectedName(name)
  }
  const removeServer = (name: string) => {
    const next = { ...servers }
    delete next[name]
    updateServers(next)
    if (selectedName === name) setSelectedName(null)
  }
  const renameServer = (oldName: string, newName: string) => {
    if (!newName || newName === oldName || servers[newName]) return
    const next: Record<string, McpServer> = {}
    for (const k of Object.keys(servers)) next[k === oldName ? newName : k] = servers[k]
    updateServers(next)
    setSelectedName(newName)
  }
  const updateServer = (name: string, srv: McpServer) => {
    updateServers({ ...servers, [name]: srv })
  }

  return (
    <Panel
      toolbar={
        <>
          <ViewSwitcher active={view} onChange={setView} />
          <span className="mx-2 text-fg-faint">·</span>
          <ScopeSwitcher scopes={['user', 'project']} active={scope} onChange={setScope} />
          <span className="ml-3 text-fg-faint truncate">{path}</span>
          <div className="flex-1" />
          <button
            onClick={addServer}
            className="px-2 py-0.5 text-xs border border-line rounded text-fg-dim hover:text-fg hover:bg-bg-hi"
          >
            + new server
          </button>
        </>
      }
      footer={
        file ? (
          <SaveBar
            dirty={file.dirty}
            busy={file.busy}
            parseError={saveError || err || file.parseError}
            lastSavedAt={file.lastSavedAt}
            onSave={async () => {
              setSaveError(null)
              const r = await saveJson(path)
              if (!r.ok) setSaveError(r.error ?? 'save failed')
            }}
            onRevert={() => {
              setSaveError(null)
              revert(path)
            }}
          />
        ) : null
      }
    >
      <ListDetail
        sidebar={
          <div className="py-2">
            <div className="px-2 pb-1">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="filter…"
                className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
              />
            </div>
            {names.length === 0 ? (
              <div className="px-3 py-1 text-xs text-fg-faint italic">no servers</div>
            ) : (
              names.filter((n) => !filter || n.toLowerCase().includes(filter.toLowerCase())).map((n) => (
                <button
                  key={n}
                  onClick={() => setSelectedName(n)}
                  className={`w-full text-left px-3 py-1 text-xs flex items-center justify-between ${
                    selectedName === n
                      ? 'bg-bg-hi text-fg'
                      : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
                  }`}
                >
                  <span className="truncate">{n}</span>
                  <span className="text-fg-faint ml-2 shrink-0">
                    {servers[n].type ?? 'stdio'}
                  </span>
                </button>
              ))
            )}
          </div>
        }
        detail={
          selectedName && selected ? (
            <McpServerEditor
              name={selectedName}
              server={selected}
              onRename={(n) => renameServer(selectedName, n)}
              onChange={(s) => updateServer(selectedName, s)}
              onRemove={() => removeServer(selectedName)}
            />
          ) : (
            <EmptyState title="select a server or click + new" />
          )
        }
      />
    </Panel>
  )
}

function McpServerEditor({
  name,
  server,
  onRename,
  onChange,
  onRemove,
}: {
  name: string
  server: McpServer
  onRename: (n: string) => void
  onChange: (s: McpServer) => void
  onRemove: () => void
}) {
  const type = server.type ?? 'stdio'
  return (
    <div className="p-4 space-y-4 max-w-2xl">
      <div className="flex items-center gap-2">
        <label className="text-xs text-fg-faint w-20">name</label>
        <input
          defaultValue={name}
          onBlur={(e) => onRename(e.target.value.trim())}
          className="flex-1 bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg font-mono"
        />
        <button
          onClick={onRemove}
          className="text-xs text-fg-faint hover:text-red-400 px-2 py-1 border border-line rounded"
        >
          delete
        </button>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs text-fg-faint w-20">type</label>
        <select
          value={type}
          onChange={(e) => onChange({ ...server, type: e.target.value as ServerType })}
          className="bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg"
        >
          <option value="stdio">stdio</option>
          <option value="http">http</option>
          <option value="sse">sse</option>
        </select>
      </div>
      {type === 'stdio' ? (
        <>
          <Field
            label="command"
            value={server.command ?? ''}
            onChange={(v) => onChange({ ...server, command: v })}
            placeholder="npx / node / python …"
          />
          <Field
            label="args"
            value={(server.args ?? []).join(' ')}
            onChange={(v) =>
              onChange({ ...server, args: v.split(/\s+/).filter(Boolean) })
            }
            placeholder="space-separated args"
          />
          <KVEditor
            label="env"
            value={server.env ?? {}}
            onChange={(env) => onChange({ ...server, env })}
          />
        </>
      ) : (
        <>
          <Field
            label="url"
            value={server.url ?? ''}
            onChange={(v) => onChange({ ...server, url: v })}
            placeholder="https://…"
          />
          <KVEditor
            label="headers"
            value={server.headers ?? {}}
            onChange={(headers) => onChange({ ...server, headers })}
          />
        </>
      )}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-fg-faint w-20">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg font-mono"
      />
    </div>
  )
}

function KVEditor({
  label,
  value,
  onChange,
}: {
  label: string
  value: Record<string, string>
  onChange: (v: Record<string, string>) => void
}) {
  const [newKey, setNewKey] = useState('')
  const [newVal, setNewVal] = useState('')
  const entries = Object.entries(value)
  return (
    <div className="flex items-start gap-2">
      <label className="text-xs text-fg-faint w-20 pt-1">{label}</label>
      <div className="flex-1 space-y-1">
        {entries.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <input
              value={k}
              onChange={(e) => {
                const next = { ...value }
                delete next[k]
                next[e.target.value] = v
                onChange(next)
              }}
              className="w-32 bg-bg-elev border border-line rounded px-2 py-0.5 text-xs text-fg font-mono"
            />
            <input
              value={v}
              onChange={(e) => onChange({ ...value, [k]: e.target.value })}
              className="flex-1 bg-bg-elev border border-line rounded px-2 py-0.5 text-xs text-fg font-mono"
            />
            <button
              onClick={() => {
                const next = { ...value }
                delete next[k]
                onChange(next)
              }}
              className="text-fg-faint hover:text-red-400 text-xs px-1"
            >
              ×
            </button>
          </div>
        ))}
        <div className="flex gap-2">
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="key"
            className="w-32 bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg-dim font-mono"
          />
          <input
            value={newVal}
            onChange={(e) => setNewVal(e.target.value)}
            placeholder="value"
            className="flex-1 bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg-dim font-mono"
          />
          <button
            onClick={() => {
              if (!newKey.trim()) return
              onChange({ ...value, [newKey.trim()]: newVal })
              setNewKey('')
              setNewVal('')
            }}
            className="px-2 text-xs border border-line rounded text-fg-dim hover:text-fg hover:bg-bg-hi"
          >
            +
          </button>
        </div>
      </div>
    </div>
  )
}
