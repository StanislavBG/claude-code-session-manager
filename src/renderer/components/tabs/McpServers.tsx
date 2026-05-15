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
 *
 * Docs (code.claude.com/docs/en/mcp, 2026-05): transports stdio/http/sse/ws/
 * streamable-http; v2.1.121 added `alwaysLoad`; reserved name `workspace`
 * cannot be used (v2.1.128).
 */
type ServerType = 'stdio' | 'http' | 'sse' | 'ws' | 'streamable-http'
interface McpServer {
  type?: ServerType
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  /** v2.1.121: bypass tool-search deferral, always load the server. */
  alwaysLoad?: boolean
  /** Hide this server without removing it. */
  enabled?: boolean
  /** Per-server tool denylist surfaced in /mcp. */
  disabledTools?: string[]
  permissions?: {
    tools?: 'allow' | 'deny' | string[]
  }
}

const SERVER_TYPES: ServerType[] = ['stdio', 'http', 'streamable-http', 'sse', 'ws']
// `workspace` is the only doc-reserved name as of v2.1.128; `ide`/`tasks` are
// project-supplied conventions other tools collide with — warn but allow.
const RESERVED_NAMES = new Set(['workspace'])
const CAUTION_NAMES = new Set(['ide', 'tasks'])

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
  const isReserved = RESERVED_NAMES.has(name)
  const isCaution = CAUTION_NAMES.has(name)
  const isHttp = type === 'http' || type === 'streamable-http' || type === 'sse' || type === 'ws'
  const permTools = server.permissions?.tools
  const permMode: 'inherit' | 'allow' | 'deny' | 'list' =
    permTools === undefined
      ? 'inherit'
      : permTools === 'allow'
        ? 'allow'
        : permTools === 'deny'
          ? 'deny'
          : 'list'
  const permList = Array.isArray(permTools) ? permTools : []
  const disabledToolsText = (server.disabledTools ?? []).join(', ')

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
      {isReserved ? (
        <div className="text-xs px-2 py-1 border border-red-500/50 rounded text-red-300 bg-red-500/5">
          ⚠ <span className="font-mono">{name}</span> is a reserved name — Claude Code will refuse to load this server (v2.1.128+).
        </div>
      ) : isCaution ? (
        <div className="text-xs px-2 py-1 border border-yellow-600/50 rounded text-yellow-200 bg-yellow-500/5">
          ⚠ <span className="font-mono">{name}</span> collides with a commonly-bundled MCP name; expect surprises in other tools.
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <label className="text-xs text-fg-faint w-20">type</label>
        <select
          value={type}
          onChange={(e) => onChange({ ...server, type: e.target.value as ServerType })}
          className="bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg"
        >
          {SERVER_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        {type === 'sse' ? (
          <span className="text-xs text-yellow-400/80">sse is deprecated — prefer streamable-http</span>
        ) : null}
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
      <div className="flex items-center gap-2">
        <label className="text-xs text-fg-faint w-20">alwaysLoad</label>
        <label className="flex items-center gap-2 text-xs text-fg">
          <input
            type="checkbox"
            checked={server.alwaysLoad === true}
            onChange={(e) => onChange({ ...server, alwaysLoad: e.target.checked || undefined })}
          />
          <span className="text-fg-dim">bypass tool-search deferral (v2.1.121+)</span>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs text-fg-faint w-20">enabled</label>
        <label className="flex items-center gap-2 text-xs text-fg">
          <input
            type="checkbox"
            checked={server.enabled !== false}
            onChange={(e) =>
              onChange({ ...server, enabled: e.target.checked ? undefined : false })
            }
          />
          <span className="text-fg-dim">load this server in new sessions</span>
        </label>
      </div>
      <Field
        label="disabledTools"
        value={disabledToolsText}
        onChange={(v) => {
          const arr = v.split(',').map((s) => s.trim()).filter(Boolean)
          onChange({ ...server, disabledTools: arr.length ? arr : undefined })
        }}
        placeholder="comma-separated tool names to hide"
      />
      <div className="flex items-start gap-2">
        <label className="text-xs text-fg-faint w-20 pt-1">permissions</label>
        <div className="flex-1 space-y-1">
          <select
            value={permMode}
            onChange={(e) => {
              const m = e.target.value as typeof permMode
              const next = { ...server }
              if (m === 'inherit') {
                if (next.permissions) {
                  const { tools: _drop, ...rest } = next.permissions
                  void _drop
                  next.permissions = Object.keys(rest).length ? rest : undefined
                }
              } else if (m === 'list') {
                next.permissions = { ...(next.permissions ?? {}), tools: [] }
              } else {
                next.permissions = { ...(next.permissions ?? {}), tools: m }
              }
              onChange(next)
            }}
            className="bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg"
          >
            <option value="inherit">inherit (default)</option>
            <option value="allow">allow all tools</option>
            <option value="deny">deny all tools</option>
            <option value="list">allowlist…</option>
          </select>
          {permMode === 'list' ? (
            <input
              value={permList.join(', ')}
              onChange={(e) => {
                const arr = e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
                onChange({ ...server, permissions: { ...(server.permissions ?? {}), tools: arr } })
              }}
              placeholder="comma-separated tool names"
              className="w-full bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg font-mono"
            />
          ) : null}
        </div>
      </div>
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
