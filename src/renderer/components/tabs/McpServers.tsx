import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Panel } from '../ui/Panel'
import { ListDetail } from '../ui/ListDetail'
import { SaveBar } from '../ui/SaveBar'
import { EmptyState } from '../ui/EmptyState'
import { ProvenanceBadge } from '../ui/ProvenanceBadge'
import { ExtensionsToolbar, type ExtensionsToolbarMenuItem } from './extensions/ExtensionsToolbar'
import { McpServerDetail, MCP_CHECK_LABEL, MCP_DOT_CLASS, type McpCheckState } from './extensions/McpServerDetail'
import {
  classifyProvenance,
  provenanceKey,
  PROVENANCE_LABEL,
  type Provenance,
  type ProvenanceInput,
} from '../../lib/provenance'
import { useConfig } from '../../state/config'
import { useProvenance } from '../../state/provenance'
import { mcpCheckKey, selectMcpChecking, selectMcpCheckResults, useMcpChecks } from '../../state/mcpChecks'
import { useActiveTab } from '../../lib/useActiveTab'
import { useHomeDir } from '../../lib/useHomeDir'
import type { Scope } from '../../lib/scopes'
import { mcpPatchTarget } from './Library'
import { toast, useToast } from '../../state/toast'
import { distinctPlaceholders } from '../../lib/mcpPlaceholders'
import { listPluginMcpServers } from '../../lib/pluginContents'
import type { InstalledPlugin, McpCheckRequest, McpCheckResult } from '../../../preload/api'

/**
 * MCP servers are stored in ~/.claude.json (user scope) under `mcpServers`,
 * or in .mcp.json at the project root (project scope). Both share the same
 * shape.
 *
 * Docs (code.claude.com/docs/en/mcp, 2026-05): transports stdio/http/sse/ws/
 * streamable-http; v2.1.121 added `alwaysLoad`; reserved name `workspace`
 * cannot be used (v2.1.128).
 *
 * The list is the Extensions 3a design (design-mocks/extensions-3a/DESIGN_SPEC.md §2, §4):
 * the shared ExtensionsToolbar, one status dot per server from the mcpChecks store (checks
 * run only on Check all / Check again — never on mount), and a server always selected. The
 * selected server opens in the 3a detail (extensions/McpServerDetail.tsx); its Edit JSON shows
 * today's full per-server form (McpServerEditor below) in the detail's body.
 *
 * User scope adds FROM PLUGINS (spec §4): the servers each enabled plugin adds (its .mcp.json, read
 * by pluginContents.ts's listPluginMcpServers), read-only — transport `plugin`, line 2
 * `via the <plugin> plugin · <status>`. They are checked (source 'plugin' + the plugin key) and
 * counted like any other server, but open in a read-only detail with no SaveBar.
 */
type ServerType = 'stdio' | 'http' | 'sse' | 'ws' | 'streamable-http'
export interface McpServer {
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

/** One server an enabled plugin adds — listed read-only under FROM PLUGINS. */
interface PluginMcpServer {
  /** Row / selection id: `<pluginKey>/<name>`. */
  id: string
  /** `name@marketplace` — the McpCheckRequest's pluginKey. */
  pluginKey: string
  /** The plugin's name as line 2 names it: `via the <plugin> plugin`. */
  plugin: string
  name: string
  /** What the plugin's entry declares, as COMMAND shows it (a URL = a remote server). */
  server: McpServer
}

const pluginCheckRequest = (p: PluginMcpServer): McpCheckRequest => ({ source: 'plugin', name: p.name, pluginKey: p.pluginKey })

/**
 * The servers every enabled plugin adds, sorted by plugin then server. A plugin whose contents can't
 * be read is skipped and named in one error toast; the rest still list.
 */
async function loadPluginMcpServers(): Promise<PluginMcpServer[]> {
  const installed: InstalledPlugin[] = (await window.api.plugins?.list?.()) ?? []
  const enabled = installed.filter((p): p is InstalledPlugin & { installPath: string } => p.enabled && !!p.installPath)
  const settled = await Promise.allSettled(enabled.map((p) => listPluginMcpServers(p.installPath)))
  const out: PluginMcpServer[] = []
  const unreadable: string[] = []
  settled.forEach((r, i) => {
    const p = enabled[i]
    if (r.status === 'rejected') {
      unreadable.push(p.name)
      return
    }
    for (const e of r.value) {
      const decl = e.description ?? ''
      const server: McpServer = /^[a-z][a-z0-9+.-]*:\/\//i.test(decl) ? { type: 'http', url: decl } : { command: decl || undefined }
      out.push({ id: `${p.key}/${e.name}`, pluginKey: p.key, plugin: p.name, name: e.name, server })
    }
  })
  if (unreadable.length > 0) toast.error(`Could not read the MCP servers of plugin ${unreadable.join(', ')}`)
  return out.sort((a, b) => a.plugin.localeCompare(b.plugin) || a.name.localeCompare(b.name))
}

// Row line 2's origin word: Anthropic accent-dark, Community honey-dark, Local in the line's own faint.
const ORIGIN_CLASS: Record<Provenance, string> = {
  anthropic: 'text-accent-dark',
  community: 'text-honey-dark',
  local: '',
}

/** Row line 2's status: `not checked` | `connected · <n> tool(s)` | `failed` | `needs auth`. */
function checkStatusText(result: McpCheckResult | undefined): string {
  if (!result) return 'not checked'
  if (result.status === 'connected') {
    const n = result.tools.length
    return `connected · ${n} tool${n === 1 ? '' : 's'}`
  }
  return result.status === 'needs-auth' ? 'needs auth' : 'failed'
}

/**
 * The mcpChecks request for one server of this list, or null with no project to check in.
 * A user server carries no cwd — main starts it in ~ whatever project is open — so its result
 * is shared by every project; a project server is keyed by its project.
 */
function checkRequestFor(scope: Scope, cwd: string | null, name: string): McpCheckRequest | null {
  if (scope === 'user') return { source: 'user', name }
  return cwd ? { source: 'project', name, cwd } : null
}

/** The 8px status dot; pulses while a check of the server is in flight. */
function McpCheckDot({ result, checking, testId }: { result: McpCheckResult | undefined; checking: boolean; testId?: string }) {
  const state: McpCheckState = result?.status ?? 'unchecked'
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      data-status={state}
      title={result && !result.ok ? `${MCP_CHECK_LABEL[state]}: ${result.error}` : MCP_CHECK_LABEL[state]}
      className={`w-2 h-2 shrink-0 box-border rounded-full ${MCP_DOT_CLASS[state]}${checking ? ' animate-pulse' : ''}`}
    />
  )
}

function McpServersComponent({ onAdd, scope = 'user' }: { onAdd?: (ctx: McpAddContext) => void; scope?: Scope } = {}) {
  const home = useHomeDir()
  const activeTab = useActiveTab()
  const cwd = activeTab?.cwd ?? null

  const [selectedName, setSelectedName] = useState<string | null>(null)
  // The FROM PLUGINS row picked (its PluginMcpServer id), or null when a config server is.
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  // The server whose Edit JSON form is open in the detail, or null for the 3a detail.
  const [jsonFor, setJsonFor] = useState<string | null>(null)
  // The pane the SaveBar's Ctrl/Cmd+S saves from.
  const paneRef = useRef<HTMLDivElement>(null)

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

  // FROM PLUGINS is user scope only: enabled plugins are a user-scope setting.
  const [pluginServers, setPluginServers] = useState<PluginMcpServer[]>([])
  useEffect(() => {
    if (scope !== 'user') {
      setPluginServers([])
      return
    }
    let alive = true
    loadPluginMcpServers()
      .then((list) => {
        if (alive) setPluginServers(list)
      })
      .catch((e: unknown) => {
        if (alive) toast.error(`Could not list plugin MCP servers: ${e instanceof Error ? e.message : String(e)}`)
      })
    return () => {
      alive = false
    }
  }, [scope])

  // Statuses are the stored results of on-demand checks (Check all / Check); nothing probes on mount.
  const checkResults = useMcpChecks(selectMcpCheckResults)
  const checking = useMcpChecks(selectMcpChecking)
  const checkAll = useMcpChecks((s) => s.checkAll)

  // Row line 2 names each server's origin — a manual override from the provenance sidecar, else
  // the auto-classified one (the same resolution ProvenanceBadge shows).
  const provenanceOverrides = useProvenance((s) => s.overrides)
  const loadProvenance = useProvenance((s) => s.load)
  useEffect(() => {
    if (home) void loadProvenance(home)
  }, [home, loadProvenance])

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
  const needle = filter.trim().toLowerCase()
  const listed = needle ? names.filter((n) => n.toLowerCase().includes(needle)) : names
  const listedPlugins = needle ? pluginServers.filter((p) => p.name.toLowerCase().includes(needle)) : pluginServers
  // A server is always selected: the picked one while it exists, else the first listed (the
  // first overall when the filter hides every row) — a config server before a plugin one. Null
  // only when there are no servers at all.
  const pickedPlugin = selectedPluginId !== null ? pluginServers.find((p) => p.id === selectedPluginId) ?? null : null
  const pickedName = selectedName !== null && names.includes(selectedName) ? selectedName : null
  const fallbackName = listed[0] ?? (listedPlugins.length > 0 ? null : names[0] ?? null)
  const selectedPlugin: PluginMcpServer | null =
    pickedPlugin ?? (pickedName === null && fallbackName === null ? listedPlugins[0] ?? pluginServers[0] ?? null : null)
  const selected = selectedPlugin ? null : (pickedName ?? fallbackName)

  const requestFor = (n: string) => checkRequestFor(scope, cwd, n)
  const resultFor = (n: string): McpCheckResult | undefined => {
    const req = requestFor(n)
    return req ? checkResults[mcpCheckKey(req)] : undefined
  }
  const isChecking = (n: string): boolean => {
    const req = requestFor(n)
    return req ? checking[mcpCheckKey(req)] === true : false
  }
  const pluginKeyOf = (p: PluginMcpServer) => mcpCheckKey(pluginCheckRequest(p))
  const listedRequests = [
    ...listed.map(requestFor).filter((r): r is McpCheckRequest => r !== null),
    ...listedPlugins.map(pluginCheckRequest),
  ]
  const totalCount = names.length + pluginServers.length
  const checkedCount =
    names.filter((n) => resultFor(n) !== undefined).length + pluginServers.filter((p) => checkResults[pluginKeyOf(p)] !== undefined).length
  const checkingListed = listed.some(isChecking) || listedPlugins.some((p) => checking[pluginKeyOf(p)] === true)
  // The scope's file as the page names it — list header, detail key path and SaveBar alike.
  const fileName = scope === 'user' ? '~/.claude.json' : '.mcp.json'

  const updateServers = (next: Record<string, McpServer>) => {
    setSaveError(null)
    setDraft(path, serialize(full, next))
  }

  const addServer = () => {
    const name = nextServerName(servers)
    updateServers({ ...servers, [name]: { type: 'stdio', command: '', args: [] } })
    setSelectedName(name)
    setSelectedPluginId(null)
    // A blank server has nothing to show in the 3a body yet: open it in the form.
    setJsonFor(name)
  }
  const selectServer = (name: string) => {
    if (name !== selected) setJsonFor(null)
    setSelectedName(name)
    setSelectedPluginId(null)
  }
  const selectPluginServer = (id: string) => {
    setJsonFor(null)
    setSelectedPluginId(id)
  }
  const removeServer = (name: string) => {
    // Select the row that moves up into the removed one's place, or the new last row.
    const order = listed.includes(name) ? listed : names
    const at = order.indexOf(name)
    const rest = order.filter((n) => n !== name)
    const next = { ...servers }
    delete next[name]
    updateServers(next)
    setSelectedName(rest[Math.min(at, rest.length - 1)] ?? null)
    setJsonFor(null)
  }
  const renameServer = (oldName: string, newName: string) => {
    if (!newName || newName === oldName || servers[newName]) return
    const next: Record<string, McpServer> = {}
    for (const k of Object.keys(servers)) next[k === oldName ? newName : k] = servers[k]
    updateServers(next)
    setSelectedName(newName)
    // A rename from the form keeps the form open on the renamed server.
    setJsonFor((open) => (open === oldName ? newName : open))
  }
  const updateServer = (name: string, srv: McpServer) => {
    updateServers({ ...servers, [name]: srv })
  }

  const addItems: ExtensionsToolbarMenuItem[] = [{ label: 'New server', testId: 'mcp-new-server', onSelect: addServer }]
  if (onAdd) addItems.push({ label: 'Browse catalog…', testId: 'mcp-browse-catalog', onSelect: () => onAdd({ scope, cwd }) })

  return (
    <div ref={paneRef} className="h-full flex flex-col">
      <ExtensionsToolbar
        filter={filter}
        onFilterChange={setFilter}
        placeholder="Filter servers"
        summary={`${totalCount} server${totalCount === 1 ? '' : 's'} · ${checkedCount} checked`}
        primary={{ label: '+ Add server', testId: 'mcp-add-server', items: addItems }}
      >
        <button
          type="button"
          data-testid="mcp-check-all"
          onClick={() => void checkAll(listedRequests)}
          disabled={listedRequests.length === 0 || checkingListed}
          className="shrink-0 h-7 inline-flex items-center px-[11px] bg-bg-hi border border-line rounded-md text-[12.5px] text-fg hover:border-rule disabled:opacity-50 disabled:hover:border-line"
        >
          {checkingListed ? 'Checking…' : 'Check all'}
        </button>
      </ExtensionsToolbar>
      <div className="flex-1 min-h-0">
        <Panel
          footer={
            // A plugin server is read-only: nothing of it is saved here.
            file && !selectedPlugin ? (
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
                cleanLabel={`Saved — matches ${fileName}`}
                shortcutHint
                scopeRef={paneRef}
              />
            ) : null
          }
        >
          {scope === 'project' && cwd && <McpProjectGating cwd={cwd} names={names} />}
          <ListDetail
            sidebarWidth="300px"
            sidebar={
              <div className="flex flex-col gap-0.5 px-2 py-1">
                {/* Renders IN ~/.CLAUDE.JSON / IN .MCP.JSON — `uppercase` keeps the real file name in the DOM. */}
                <div
                  data-testid="mcp-list-header"
                  className="flex items-center gap-2 mx-1.5 mt-3 mb-1 text-[11px] font-semibold tracking-[.06em] uppercase text-fg-faint"
                >
                  {`In ${fileName}`}
                  <span className="font-mono font-medium tracking-normal text-fg-faint/60">{listed.length}</span>
                </div>
                {names.length === 0 ? (
                  <div className="mx-1.5 py-1 text-xs text-fg-faint">{pluginServers.length > 0 ? `No servers in ${fileName} yet.` : 'No servers yet.'}</div>
                ) : listed.length === 0 ? (
                  <div className="mx-1.5 py-1 text-xs text-fg-faint">No servers match “{filter.trim()}”.</div>
                ) : (
                  listed.map((n) => {
                    const srv = servers[n]
                    const isSelected = n === selected
                    const result = resultFor(n)
                    const inFlight = isChecking(n)
                    const origin: Provenance =
                      provenanceOverrides[provenanceKey('mcp', scope, n)] ?? classifyProvenance(mcpProvInput(n, srv)).provenance
                    const placeholders = distinctPlaceholders(srv).map((p) => p.token).join(', ')
                    return (
                      <button
                        key={n}
                        type="button"
                        data-testid={`mcp-row-${n}`}
                        aria-current={isSelected ? 'true' : undefined}
                        title={srv.description?.trim() || undefined}
                        onClick={() => selectServer(n)}
                        className={`w-full text-left grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-x-2.5 px-2.5 py-1.5 rounded-[7px] border ${
                          isSelected ? 'bg-bg-hi border-line' : 'border-transparent hover:bg-bg-hi/60'
                        }`}
                      >
                        <McpCheckDot result={result} checking={inFlight} testId={`mcp-dot-${n}`} />
                        <span className={`truncate text-[13px] text-fg${isSelected ? ' font-semibold' : ''}`}>{n}</span>
                        <span className="font-mono text-[10.5px] text-fg-faint/80">{srv.type ?? 'stdio'}</span>
                        <span data-testid={`mcp-status-${n}`} className="col-start-2 col-span-2 truncate text-[11px] text-fg-faint">
                          <span className={ORIGIN_CLASS[origin]}>{PROVENANCE_LABEL[origin]}</span>
                          {' · '}
                          {inFlight ? 'checking…' : checkStatusText(result)}
                        </span>
                        {placeholders ? (
                          <span
                            className="col-start-2 col-span-2 truncate text-[11px] text-honey-dark"
                            title={`${scope} scope · ${path} — replace ${placeholders} with a real value; Save refuses it until then`}
                          >
                            ⚠ unconfigured placeholder: {placeholders}
                          </span>
                        ) : null}
                      </button>
                    )
                  })
                )}
                {pluginServers.length > 0 ? (
                  <>
                    <div
                      data-testid="mcp-plugins-header"
                      className="flex items-center gap-2 mx-1.5 mt-3 mb-1 text-[11px] font-semibold tracking-[.06em] uppercase text-fg-faint"
                    >
                      From plugins
                      <span data-testid="mcp-plugins-count" className="font-mono font-medium tracking-normal text-fg-faint/60">
                        {listedPlugins.length}
                      </span>
                      <span
                        data-testid="mcp-plugins-readonly"
                        className="ml-auto px-[5px] border border-line rounded-[3px] text-[9.5px] font-medium tracking-normal text-fg-faint/80"
                      >
                        READ-ONLY
                      </span>
                    </div>
                    {listedPlugins.length === 0 ? (
                      <div className="mx-1.5 py-1 text-xs text-fg-faint">No plugin servers match “{filter.trim()}”.</div>
                    ) : (
                      listedPlugins.map((p) => {
                        const isSelected = selectedPlugin?.id === p.id
                        const key = pluginKeyOf(p)
                        const result = checkResults[key]
                        const inFlight = checking[key] === true
                        return (
                          <button
                            key={p.id}
                            type="button"
                            data-testid={`mcp-plugin-row-${p.id}`}
                            aria-current={isSelected ? 'true' : undefined}
                            onClick={() => selectPluginServer(p.id)}
                            className={`w-full text-left grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-x-2.5 px-2.5 py-1.5 rounded-[7px] border ${
                              isSelected ? 'bg-bg-hi border-line' : 'border-transparent hover:bg-bg-hi/60'
                            }`}
                          >
                            <McpCheckDot result={result} checking={inFlight} testId={`mcp-plugin-dot-${p.id}`} />
                            <span className={`truncate text-[13px] text-fg${isSelected ? ' font-semibold' : ''}`}>{p.name}</span>
                            <span className="font-mono text-[10.5px] text-fg-faint/80">plugin</span>
                            <span data-testid={`mcp-plugin-status-${p.id}`} className="col-start-2 col-span-2 truncate text-[11px] text-fg-faint">
                              via the {p.plugin} plugin · {inFlight ? 'checking…' : checkStatusText(result)}
                            </span>
                          </button>
                        )
                      })
                    )}
                  </>
                ) : null}
              </div>
            }
            detail={
              selectedPlugin ? (
                <McpServerDetail
                  key={`plugin:${selectedPlugin.id}`}
                  name={selectedPlugin.name}
                  server={selectedPlugin.server}
                  scope="user"
                  plugin={selectedPlugin.plugin}
                  checkRequest={pluginCheckRequest(selectedPlugin)}
                  provenance={mcpProvInput(selectedPlugin.name, selectedPlugin.server)}
                />
              ) : selected !== null ? (
                // Keyed by name: another server — or a rename — starts with every value masked again.
                <McpServerDetail
                  key={selected}
                  name={selected}
                  server={servers[selected]}
                  scope={scope}
                  fileLabel={fileName}
                  checkRequest={requestFor(selected)}
                  provenance={mcpProvInput(selected, servers[selected])}
                  onChange={(s) => updateServer(selected, s)}
                  editing={jsonFor === selected}
                  onEditingChange={(on) => setJsonFor(on ? selected : null)}
                  editor={
                    jsonFor === selected ? (
                      <McpServerEditor
                        name={selected}
                        server={servers[selected]}
                        scope={scope}
                        onRename={(n) => renameServer(selected, n)}
                        onChange={(s) => updateServer(selected, s)}
                        onRemove={() => removeServer(selected)}
                      />
                    ) : null
                  }
                />
              ) : (
                <EmptyState
                  title="No MCP servers yet"
                  hint={onAdd ? '+ Add server starts a new one or browses the catalog.' : '+ Add server starts a new one.'}
                />
              )
            }
          />
        </Panel>
      </div>
    </div>
  )
}

// Memoized: own data comes from store/IPC hooks inside the component.
export const McpServers = memo(McpServersComponent)

/**
 * Today's full per-server form — every field of the entry (name, description, type, command/args/
 * env or url/headers, alwaysLoad, disabledTools, permissions) plus the origin override — shown by
 * the 3a detail's Edit JSON (DESIGN_SPEC §7.2). The detail's header above it carries the status
 * and Check again. The name input is uncontrolled, so the form is remounted under the detail's
 * per-name key.
 */
function McpServerEditor({
  name,
  server,
  scope,
  onRename,
  onChange,
  onRemove,
}: {
  name: string
  server: McpServer
  scope: Scope
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
    <div data-testid="mcp-json-form" className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-2">
        <span className="text-xs text-fg-faint w-20">origin</span>
        <ProvenanceBadge scope={scope} input={mcpProvInput(name, server)} />
        <span className="text-xs text-fg-faint">click to change</span>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs text-fg-faint w-20">name</label>
        <input
          aria-label="Server name"
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
