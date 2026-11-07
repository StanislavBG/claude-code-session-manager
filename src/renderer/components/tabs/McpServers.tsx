import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Panel } from '../ui/Panel'
import { ListDetail } from '../ui/ListDetail'
import { SaveBar } from '../ui/SaveBar'
import { EmptyState } from '../ui/EmptyState'
import { ProvenanceBadge } from '../ui/ProvenanceBadge'
import { Badge } from '../ui/Badge'
import { StatusDot } from '../ui/StatusDot'
import type { ProvenanceInput } from '../../lib/provenance'
import { useConfig } from '../../state/config'
import { useActiveTab } from '../../lib/useActiveTab'
import { useHomeDir } from '../../lib/useHomeDir'
import type { Scope } from '../../lib/scopes'
import { mcpPatchTarget } from './Library'
import { toast, useToast } from '../../state/toast'
import { distinctPlaceholders } from '../../lib/mcpPlaceholders'
import { deriveMcpConnectionState, type McpConnectionInfo } from '../../lib/mcpConnectionState'
import type { McpStatusResult } from '../../../preload/api'

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
  /** Not a Claude Code config field — session-manager-only, user-set purpose blurb. */
  description?: string
  /** Per-server tool denylist surfaced in /mcp. */
  disabledTools?: string[]
  permissions?: {
    tools?: 'allow' | 'deny' | string[]
  }
}

// Single source for the provenance input so the row + toolbar badges agree.
const mcpProvInput = (name: string, s: McpServer): ProvenanceInput => ({
  type: 'mcp', name, command: s.command, args: s.args, url: s.url,
})

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
/** Claude Code has no per-server `enabled` field; drop a stale one on write. */
export function serialize(full: Record<string, unknown>, servers: Record<string, McpServer>): string {
  const clean: Record<string, McpServer> = {}
  for (const [k, v] of Object.entries(servers)) {
    const { enabled: _drop, ...rest } = v as McpServer & { enabled?: unknown }
    void _drop
    clean[k] = rest
  }
  return JSON.stringify({ ...full, mcpServers: clean }, null, 2) + '\n'
}

export interface ServerPatch { name: string; value: McpServer | undefined }

/**
 * Per-key patches turning the on-disk `mcpServers` into the draft: changed/added
 * first, removals last — so a rename patches the new name, then the old name to undefined.
 */
export function diffServerPatches(disk: Record<string, McpServer>, draft: Record<string, McpServer>): ServerPatch[] {
  const out: ServerPatch[] = []
  for (const [name, srv] of Object.entries(draft)) {
    if (JSON.stringify(srv) === JSON.stringify(disk[name])) continue
    const { enabled: _drop, ...rest } = srv as McpServer & { enabled?: unknown }
    void _drop
    out.push({ name, value: rest })
  }
  for (const name of Object.keys(disk)) if (!(name in draft)) out.push({ name, value: undefined })
  return out
}

/**
 * Next default name for a new server — `server-N` where N starts at
 * count+1 and increments until it doesn't collide with an existing key.
 * A plain count+1 can collide after a deletion (e.g. delete server-1 out
 * of {server-1, server-2}; count+1 recomputes to server-2 and silently
 * overwrites it), so this walks forward until it finds an unused name.
 */
export function nextServerName(servers: Record<string, McpServer>): string {
  let n = Object.keys(servers).length + 1
  let name = `server-${n}`
  while (servers[name]) {
    n += 1
    name = `server-${n}`
  }
  return name
}

export interface McpAddContext { scope: Scope; cwd: string | null }

function McpServersComponent({ onAdd, scope = 'user' }: { onAdd?: (ctx: McpAddContext) => void; scope?: Scope } = {}) {
  const home = useHomeDir()
  const activeTab = useActiveTab()
  const cwd = activeTab?.cwd ?? null

  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const path = useMemo(() => (home ? pathFor(scope, home, cwd) : null), [home, scope, cwd])

  const files = useConfig((s) => s.files)
  const loadJson = useConfig((s) => s.loadJson)
  const setDraft = useConfig((s) => s.setDraft)
  const revert = useConfig((s) => s.revert)
  const watchFile = useConfig((s) => s.watchFile)
  const unwatchFile = useConfig((s) => s.unwatchFile)

  useEffect(() => {
    if (!path) return
    if (!files[path]) loadJson(path)
    watchFile(path)
    return () => unwatchFile(path)
  }, [path])

  const [saveError, setSaveError] = useState<string | null>(null)

  const [probe, setProbe] = useState<McpStatusResult | null>(null)
  const [probing, setProbing] = useState(false)
  // Guards against an in-flight probe (mount fetch or a prior manual refresh)
  // resolving after a newer one and clobbering fresher state; also skips
  // setState once the tab has unmounted.
  const probeRequestId = useRef(0)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const refreshStatus = async () => {
    const requestId = ++probeRequestId.current
    setProbing(true)
    try {
      const r = await window.api.mcp.status()
      if (!mounted.current || requestId !== probeRequestId.current) return
      setProbe(r)
      if (!r.ok) toast.error(r.error ?? 'MCP status probe failed')
    } catch (e) {
      if (!mounted.current || requestId !== probeRequestId.current) return
      setProbe(null)
      toast.error((e as Error).message || 'MCP status probe failed')
    } finally {
      if (mounted.current && requestId === probeRequestId.current) setProbing(false)
    }
  }
  useEffect(() => {
    refreshStatus()
  }, [])

  if (!home) return <EmptyState title="loading…" />
  if (scope === 'project' && !cwd) {
    return (
      <Panel
        toolbar={
          <>
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
    const name = nextServerName(servers)
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
          <span className="ml-3 px-1.5 py-0.5 text-[10px] rounded border border-line text-fg-faint">
            {names.length} server{names.length === 1 ? '' : 's'}
          </span>
          <span className="ml-2 text-fg-faint truncate">{path}</span>
          <div className="flex-1" />
          {selectedName && selected && (
            <ProvenanceBadge scope={scope} input={mcpProvInput(selectedName, selected)} className="mr-2" />
          )}
          <button
            onClick={refreshStatus}
            disabled={probing}
            className="px-2 py-0.5 text-xs border border-line rounded text-fg-dim hover:text-fg hover:bg-bg-hi disabled:opacity-50 mr-2"
          >
            {probing ? 'checking…' : '⟳ test connections'}
          </button>
          <button
            onClick={() => onAdd?.({ scope, cwd })}
            className="px-2 py-0.5 text-xs border border-line rounded text-fg-dim hover:text-fg hover:bg-bg-hi mr-2"
          >
            Add…
          </button>
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
              // Refuse to persist a new/changed server that still has a literal `<token>`.
              // Unchanged servers are exempt so a pre-existing broken entry can't block fixing/removing others.
              const disk = (file.diskData as { mcpServers?: Record<string, unknown> } | null)?.mcpServers ?? {}
              for (const [n, srv] of Object.entries(servers)) {
                if (JSON.stringify(srv) === JSON.stringify(disk[n])) continue
                const ph = distinctPlaceholders(srv)
                if (ph.length > 0) {
                  useToast.getState().show('error', `Not saved: "${n}" still contains placeholder ${ph.map((p) => p.token).join(', ')} — replace it with a real value`)
                  return
                }
              }
              try {
                for (const p of diffServerPatches(disk as Record<string, McpServer>, servers)) {
                  await window.api.claudeConfig.patch({
                    ...mcpPatchTarget(scope, cwd),
                    keyPath: ['mcpServers', p.name],
                    value: p.value,
                  })
                }
                await loadJson(path)
              } catch (e) {
                setSaveError((e as Error).message || 'save failed')
              }
            }}
            onRevert={() => {
              setSaveError(null)
              revert(path)
            }}
          />
        ) : null
      }
    >
      {scope === 'project' && cwd && <McpProjectGating cwd={cwd} names={names} />}
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
              names.filter((n) => !filter || n.toLowerCase().includes(filter.toLowerCase())).map((n) => {
                const conn = deriveMcpConnectionState(n, probe)
                const description = servers[n].description?.trim()
                return (
                  <button
                    key={n}
                    onClick={() => setSelectedName(n)}
                    className={`w-full text-left px-3 py-1 text-xs flex flex-col gap-0.5 ${
                      selectedName === n
                        ? 'bg-bg-hi text-fg'
                        : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
                    }`}
                  >
                    <span className="flex items-center gap-2 justify-between w-full">
                      <span className="flex items-center gap-2 min-w-0">
                        <StatusDot state={conn.dotState} title={conn.label} />
                        <span className="truncate">{n}</span>
                      </span>
                      <span className="ml-2 flex items-center gap-2 shrink-0">
                        {(() => {
                          const ph = distinctPlaceholders(servers[n])
                          return ph.length > 0 ? (
                            <Badge tone="warn" title={`${scope} scope · ${path}`}>
                              unconfigured placeholder: {ph.map((p) => p.token).join(', ')}
                            </Badge>
                          ) : null
                        })()}
                        <Badge tone={conn.badgeTone}>{conn.label}</Badge>
                        <ProvenanceBadge interactive={false} scope={scope} input={mcpProvInput(n, servers[n])} />
                        <span className="text-fg-faint">{servers[n].type ?? 'stdio'}</span>
                      </span>
                    </span>
                    {description ? (
                      <span className="pl-5 text-fg-faint truncate" title={description}>
                        {description}
                      </span>
                    ) : null}
                  </button>
                )
              })
            )}
          </div>
        }
        detail={
          selectedName && selected ? (
            <McpServerEditor
              name={selectedName}
              server={selected}
              connection={deriveMcpConnectionState(selectedName, probe)}
              onTestConnection={refreshStatus}
              testing={probing}
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

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const McpServers = memo(McpServersComponent)

function McpServerEditor({
  name,
  server,
  connection,
  onTestConnection,
  testing,
  onRename,
  onChange,
  onRemove,
}: {
  name: string
  server: McpServer
  connection: McpConnectionInfo
  onTestConnection: () => void
  testing: boolean
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
        <StatusDot state={connection.dotState} size="md" title={connection.label} />
        <Badge tone={connection.badgeTone}>{connection.label}</Badge>
        <button
          onClick={onTestConnection}
          disabled={testing}
          className="ml-auto px-2 py-0.5 text-xs border border-line rounded text-fg-dim hover:text-fg hover:bg-bg-hi disabled:opacity-50"
        >
          {testing ? 'checking…' : 'test connection'}
        </button>
      </div>
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
      <Field
        label="description"
        value={server.description ?? ''}
        onChange={(v) => onChange({ ...server, description: v || undefined })}
        placeholder="what this server does…"
      />
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

/**
 * Project gating for .mcp.json servers: `disabledMcpjsonServers` (per server)
 * and `enableAllProjectMcpServers`, both in <cwd>/.claude/settings.json,
 * written through claudeConfig.patch (key-scoped, never a whole-file write).
 */
function McpProjectGating({ cwd, names }: { cwd: string; names: string[] }) {
  const target = { fileId: 'settings' as const, scope: 'project' as const, cwd }
  const [disabled, setDisabled] = useState<string[]>([])
  const [enableAll, setEnableAll] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const load = () =>
      window.api.claudeConfig
        .read(target)
        .then((r) => {
          if (!alive) return
          const d = r.data as { disabledMcpjsonServers?: unknown; enableAllProjectMcpServers?: unknown } | null
          setDisabled(Array.isArray(d?.disabledMcpjsonServers) ? (d!.disabledMcpjsonServers as string[]) : [])
          setEnableAll(d?.enableAllProjectMcpServers === true)
        })
        .catch(() => {})
    load()
    const off = window.api.config?.onChanged?.(() => { load() })
    return () => { alive = false; off?.() }
  }, [cwd])

  const patch = async (key: string, value: unknown) => {
    setBusy(true)
    try {
      await window.api.claudeConfig.patch({ ...target, keyPath: [key], value })
    } catch (e) {
      toast.error((e as Error).message || 'save failed')
    } finally {
      setBusy(false)
    }
  }
  const toggleServer = async (n: string, on: boolean) => {
    const next = on ? disabled.filter((d) => d !== n) : [...new Set([...disabled, n])]
    setDisabled(next)
    await patch('disabledMcpjsonServers', next.length ? next : undefined)
  }

  return (
    <div className="px-3 py-1 text-xs text-fg-faint border-b border-line flex flex-wrap items-center gap-x-4 gap-y-1" data-testid="mcp-gating">
      <span>Gating · {cwd}/.claude/settings.json</span>
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          data-testid="mcp-enable-all"
          checked={enableAll}
          disabled={busy}
          onChange={(e) => { setEnableAll(e.target.checked); patch('enableAllProjectMcpServers', e.target.checked ? true : undefined) }}
        />
        enableAllProjectMcpServers
      </label>
      {names.map((n) => (
        <label key={n} className="flex items-center gap-1">
          <input
            type="checkbox"
            data-testid={`mcp-gate-${n}`}
            checked={!disabled.includes(n)}
            disabled={busy}
            onChange={(e) => toggleServer(n, e.target.checked)}
          />
          {n}
        </label>
      ))}
    </div>
  )
}
