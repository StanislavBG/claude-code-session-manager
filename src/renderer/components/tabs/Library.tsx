import { useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState } from '../ui/EmptyState'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { distinctPlaceholders, fillPlaceholders, type Placeholder } from '../../lib/mcpPlaceholders'
import { useHomeDir } from '../../lib/useHomeDir'
import { listSkillEntries } from '../../lib/listSkills'
import { listMarketplacePlugins, type MarketplacePlugin } from '../../lib/pluginMarketplaces'
import { copyText } from '../../lib/clipboard'
import { toast } from '../../state/toast'
import { useConfig } from '../../state/config'
import { Z } from '../../lib/zLayers'
import {
  CATALOG_MCP,
  CATALOG_SKILLS,
  CATALOG_HOOKS,
  CATALOG_PERMS_PRESETS,
  CATALOG_PROMPT_PRESETS,
  type CatalogMcp,
  type CatalogHook,
  type CatalogPermissionPreset,
} from '../../data/catalog'
import {
  readActivePresetIds,
  togglePreset,
  findUnmanagedConflicts,
} from '../../lib/presetBlock'

/**
 * Catalog panels for installable extensions and presets, each mounted by the
 * page that owns the concept: Extensions (Skills / MCP / Plugins tabs),
 * Project config (MCP add), Hooks and Permissions (reference libraries), and
 * System Prompt (Insert preset menu).
 */

function matches(q: string, ...fields: string[]): boolean {
  if (!q.trim()) return true
  const needle = q.toLowerCase()
  return fields.some((f) => f.toLowerCase().includes(needle))
}

/* ----------------------------------------------------------- MCP library */

/** Config-file target for an MCP scope: ~/.claude.json (user) or <cwd>/.mcp.json (project). */
export function mcpPatchTarget(scope: 'user' | 'project' | 'local', cwd: string | null) {
  return scope === 'user'
    ? { fileId: 'claudeJson' as const, scope: 'user' as const }
    : { fileId: 'mcpJson' as const, scope: 'project' as const, cwd }
}

/** Entry written on install: stdio gets type 'stdio', URL entries type 'http' unless the catalog declares one. */
export function buildInstallEntry(config: CatalogMcp['config']): Record<string, unknown> {
  const declared = (config as { type?: string }).type
  if ('command' in config) return { type: 'stdio', ...config }
  return { ...config, type: declared ?? 'http' }
}

export function McpLibrary({ scope = 'user', cwd = null }: { scope?: 'user' | 'project' | 'local'; cwd?: string | null } = {}) {
  const home = useHomeDir()
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // Catalog entry awaiting values for its `<token>` placeholders (nothing written yet).
  const [pending, setPending] = useState<{ m: CatalogMcp; fields: Placeholder[]; values: Record<string, string> } | null>(null)
  const scopeReady = scope === 'user' || !!cwd

  const refresh = async () => {
    if (!home || !scopeReady) {
      setInstalled(new Set())
      return
    }
    try {
      const r = await window.api.claudeConfig.read(mcpPatchTarget(scope, cwd))
      const servers = (r.data as { mcpServers?: Record<string, unknown> } | null)?.mcpServers ?? {}
      setInstalled(new Set(Object.keys(servers)))
    } catch {
      setInstalled(new Set())
    }
  }

  useEffect(() => {
    refresh()
  }, [home, scope, cwd])

  const items = useMemo(
    () => CATALOG_MCP.filter((m) => matches(query, m.id, m.name, m.description)),
    [query]
  )

  const install = (m: CatalogMcp) => {
    const fields = distinctPlaceholders(m.config)
    if (fields.length > 0) {
      setError(null)
      setPending({ m, fields, values: {} })
      return
    }
    return writeInstall(m, m.config)
  }

  const patchServer = async (id: string, value: unknown) => {
    try {
      await window.api.claudeConfig.patch({ ...mcpPatchTarget(scope, cwd), keyPath: ['mcpServers', id], value })
      return null
    } catch (e) {
      return (e as Error).message || 'write failed'
    }
  }

  const writeInstall = async (m: CatalogMcp, config: CatalogMcp['config']) => {
    if (!home || !scopeReady) return
    setBusy(m.id)
    setError(null)
    const err = await patchServer(m.id, buildInstallEntry(config))
    setBusy(null)
    if (err) {
      setError(err)
      return
    }
    setPending(null)
    setFlash(`installed ${m.id} (${scope})`)
    setTimeout(() => setFlash(null), 4000)
    refresh()
  }

  const uninstall = async (id: string) => {
    if (!home || !scopeReady) return
    setBusy(id)
    setError(null)
    const err = await patchServer(id, undefined)
    setBusy(null)
    if (err) {
      setError(err)
      return
    }
    refresh()
  }

  if (!home) return <EmptyState title="loading…" />

  return (
    <div className="h-full flex flex-col">
      <LibraryToolbar
        query={query}
        onQueryChange={setQuery}
        count={items.length}
        total={CATALOG_MCP.length}
      />
      {(flash || error) && (
        <div
          className={`px-4 py-2 text-xs border-b border-line ${
            error ? 'text-red-400 bg-red-950/20' : 'text-accent bg-bg-elev'
          }`}
        >
          {error ?? flash}
        </div>
      )}
      {pending && (
        <div className="px-4 py-3 border-b border-line bg-bg-elev space-y-2" data-testid="mcp-placeholder-form">
          <div className="text-xs text-fg">
            Configure <span className="font-medium">{pending.m.name}</span> — fill in every value before installing
          </div>
          {pending.fields.map((f) => (
            <label key={f.token} className="flex items-center gap-2 text-xs">
              <span className="w-64 shrink-0 text-fg-faint font-mono truncate" title={f.label}>{f.label}</span>
              <input
                required
                aria-label={f.token}
                value={pending.values[f.token] ?? ''}
                onChange={(e) => {
                  const v = e.target.value
                  setPending((p) => (p ? { ...p, values: { ...p.values, [f.token]: v } } : p))
                }}
                placeholder={f.token}
                className="flex-1 bg-bg border border-line rounded px-2 py-1 text-xs text-fg font-mono"
              />
            </label>
          ))}
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={busy === pending.m.id || pending.fields.some((f) => !(pending.values[f.token] ?? '').trim())}
              onClick={() => writeInstall(pending.m, fillPlaceholders(pending.m.config, pending.values))}
            >
              install
            </Button>
            <Button onClick={() => setPending(null)}>cancel</Button>
          </div>
        </div>
      )}
      <div className="flex-1 overflow-auto divide-y divide-line">
        {items.map((m) => {
          const on = installed.has(m.id)
          return (
            <div key={m.id} className="px-4 py-3 flex items-start gap-3 hover:bg-bg-elev/50">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-fg text-xs font-medium">{m.name}</span>
                  {m.official && <Badge>official</Badge>}
                  {on && <Badge tone="accent">installed</Badge>}
                  {m.envVars.length > 0 && <Badge tone="warn">{m.envVars.length} env</Badge>}
                </div>
                <div className="text-fg-dim text-xs mt-0.5">{m.description}</div>
                <div className="text-fg-faint text-[10px] font-mono mt-1 truncate">
                  {'command' in m.config
                    ? `${m.config.command} ${(m.config.args ?? []).join(' ')}`
                    : m.config.url}
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                <LinkBtn href={m.homepage}>docs</LinkBtn>
                {on ? (
                  <button
                    disabled={busy === m.id}
                    onClick={() => uninstall(m.id)}
                    className="px-2 py-0.5 text-xs border border-line rounded text-fg-dim hover:text-red-400"
                  >
                    remove
                  </button>
                ) : (
                  <button
                    disabled={busy === m.id}
                    onClick={() => install(m)}
                    className="px-2 py-0.5 text-xs border border-accent rounded text-accent hover:bg-accent hover:text-bg"
                  >
                    {busy === m.id ? '…' : 'install'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
        {items.length === 0 && <EmptyState title="no matches" />}
      </div>
    </div>
  )
}

/* --------------------------------------------------------- Skills library */

export function SkillsLibrary() {
  const home = useHomeDir()
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')

  const refresh = async () => {
    if (!home) return
    const { entries } = await listSkillEntries(`${home}/.claude/skills`)
    setInstalled(new Set(entries.map((e) => e.name)))
  }

  useEffect(() => {
    refresh()
  }, [home])

  const items = useMemo(
    () => CATALOG_SKILLS.filter((s) => matches(query, s.id, s.name, s.description)),
    [query]
  )

  if (!home) return <EmptyState title="loading…" />

  return (
    <div className="h-full flex flex-col">
      <LibraryToolbar
        query={query}
        onQueryChange={setQuery}
        count={items.length}
        total={CATALOG_SKILLS.length}
      />
      <div className="flex-1 overflow-auto divide-y divide-line">
        {items.map((s) => {
          const on = installed.has(s.id)
          const isLocal = s.source === 'local'
          const installCmd = isLocal
            ? '' // local skills are bundled, no install needed
            : `mkdir -p ~/.claude/skills && cd ~/.claude/skills && git clone --depth 1 --filter=blob:none --sparse https://github.com/anthropics/skills _tmp-${s.id} && cd _tmp-${s.id} && git sparse-checkout set skills/${s.id} && mv skills/${s.id} ../${s.id} && cd .. && rm -rf _tmp-${s.id}`
          return (
            <div key={s.id} className="px-4 py-3 flex items-start gap-3 hover:bg-bg-elev/50">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-fg text-xs font-medium">{s.name}</span>
                  {s.official && <Badge>official</Badge>}
                  {isLocal && <Badge tone="warn">local</Badge>}
                  {on && <Badge tone="accent">installed</Badge>}
                </div>
                <div className="text-fg-dim text-xs mt-0.5">{s.description}</div>
                <div className="text-fg-faint text-[10px] font-mono mt-1 truncate">
                  ~/.claude/skills/{s.id}/
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                {!isLocal && <LinkBtn href={s.source}>source</LinkBtn>}
                {!isLocal && <CopyBtn text={installCmd} label={on ? 'reinstall cmd' : 'copy install'} />}
              </div>
            </div>
          )
        })}
        {items.length === 0 && <EmptyState title="no matches" />}
      </div>
    </div>
  )
}

/* -------------------------------------------------------- Plugins library */

export function PluginsLibrary() {
  const home = useHomeDir()
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState<MarketplacePlugin[]>([])

  const refresh = async () => {
    if (!home) return
    setCatalog(await listMarketplacePlugins(home))
    const ids = new Set<string>()
    // Legacy signal: a top-level dir under ~/.claude/plugins named for the id.
    const r = await window.api.config.listDir(`${home}/.claude/plugins`, { dirsOnly: true })
    for (const e of r.entries) ids.add(e.name)
    // Authoritative signal: plugins.list (installed_plugins.json joined with enabledPlugins).
    try {
      for (const p of (await window.api.plugins?.list?.()) ?? []) {
        if (p.enabled) ids.add(p.name)
      }
    } catch {
      /* list unavailable — dir signal still stands */
    }
    setInstalled(ids)
  }

  useEffect(() => {
    refresh()
  }, [home])

  const items = useMemo(
    () => catalog.filter((p) => matches(query, p.name, p.marketplace, p.description)),
    [catalog, query]
  )

  if (!home) return <EmptyState title="loading…" />

  return (
    <div className="h-full flex flex-col">
      <LibraryToolbar
        query={query}
        onQueryChange={setQuery}
        count={items.length}
        total={catalog.length}
      />
      <div className="flex-1 overflow-auto divide-y divide-line">
        {items.map((p) => {
          const on = installed.has(p.name)
          // Marketplaces come from known_marketplaces.json, so they are already
          // registered; install is `/plugin install <name>@<marketplace>`. The
          // bundled one is resolved by main when the in-app Install button runs.
          const installLine = `/plugin install ${p.name}@${p.marketplace}`
          return (
            <div key={`${p.marketplace}/${p.name}`} className="px-4 py-3 flex items-start gap-3 hover:bg-bg-elev/50">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-fg text-xs font-medium">{p.name}</span>
                  <Badge tone="dim">{p.marketplace}</Badge>
                  {on && <Badge tone="accent">installed</Badge>}
                </div>
                <div className="text-fg-dim text-xs mt-0.5">{p.description}</div>
                <div className="text-fg-faint text-[10px] font-mono mt-1 truncate">{installLine}</div>
              </div>
              <div className="flex gap-1 shrink-0 items-start">
                {/^https?:\/\//.test(p.source) && <LinkBtn href={p.source}>source</LinkBtn>}
                <CopyBtn text={installLine} label="copy" />
                <InstallBtn
                  id={p.name}
                  marketplace={p.marketplace === 'session-manager' ? { add: 'bundled', name: p.marketplace } : undefined}
                  installed={on}
                  onDone={refresh}
                />
              </div>
            </div>
          )
        })}
        {items.length === 0 && <EmptyState title="no matches" />}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ Hooks library */

interface HookRule {
  type: 'command'
  command: string
  timeout?: number
}
interface HookGroup {
  matcher?: string
  hooks: HookRule[]
}

/** Is this preset already installed in settings.json hooks? — matched by command. */
function hookInstalled(
  hooks: Record<string, HookGroup[] | undefined>,
  h: CatalogHook
): boolean {
  const groups = hooks[h.event] ?? []
  return groups.some((g) =>
    (g.hooks ?? []).some((r) => r.type === 'command' && r.command === h.command)
  )
}

export function HooksLibrary() {
  const home = useHomeDir()
  const [hooks, setHooks] = useState<Record<string, HookGroup[] | undefined>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const path = home ? `${home}/.claude/settings.json` : null

  const refresh = async () => {
    if (!path) return
    const r = await window.api.config.readJson(path)
    const full = (r.data && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : {}) ?? {}
    setHooks((full.hooks as Record<string, HookGroup[] | undefined>) ?? {})
  }

  useEffect(() => {
    refresh()
  }, [path])

  const items = useMemo(
    () => CATALOG_HOOKS.filter((h) => matches(query, h.id, h.name, h.description, h.event)),
    [query]
  )

  const install = async (h: CatalogHook) => {
    if (!path) return
    setBusy(h.id)
    setError(null)
    const r = await window.api.config.readJson(path)
    const full = (r.data && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : {}) ?? {}
    const all = { ...((full.hooks as Record<string, HookGroup[] | undefined>) ?? {}) }
    const groups = (all[h.event] ?? []).slice()
    groups.push({
      ...(h.matcher ? { matcher: h.matcher } : {}),
      hooks: [{ type: 'command', command: h.command, ...(h.timeout ? { timeout: h.timeout } : {}) }],
    })
    all[h.event] = groups
    const write = await window.api.config.writeJson(path, { ...full, hooks: all })
    setBusy(null)
    if (!write.ok) {
      setError(write.error ?? 'write failed')
      return
    }
    setFlash(`installed ${h.id}`)
    setTimeout(() => setFlash(null), 2500)
    refresh()
  }

  const uninstall = async (h: CatalogHook) => {
    if (!path) return
    setBusy(h.id)
    setError(null)
    const r = await window.api.config.readJson(path)
    const full = (r.data && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : {}) ?? {}
    const all = { ...((full.hooks as Record<string, HookGroup[] | undefined>) ?? {}) }
    const groups = (all[h.event] ?? [])
      .map((g) => ({
        ...g,
        hooks: (g.hooks ?? []).filter((r) => !(r.type === 'command' && r.command === h.command)),
      }))
      .filter((g) => (g.hooks ?? []).length > 0)
    if (groups.length) all[h.event] = groups
    else delete all[h.event]
    const write = await window.api.config.writeJson(path, { ...full, hooks: all })
    setBusy(null)
    if (!write.ok) {
      setError(write.error ?? 'write failed')
      return
    }
    refresh()
  }

  if (!home) return <EmptyState title="loading…" />

  return (
    <div className="h-full flex flex-col">
      <LibraryToolbar query={query} onQueryChange={setQuery} count={items.length} total={CATALOG_HOOKS.length} />
      {(flash || error) && (
        <div className={`px-4 py-2 text-xs border-b border-line ${error ? 'text-red-400 bg-red-950/20' : 'text-accent bg-bg-elev'}`}>
          {error ?? flash}
        </div>
      )}
      <div className="flex-1 overflow-auto divide-y divide-line">
        {items.map((h) => {
          const on = hookInstalled(hooks, h)
          return (
            <div key={h.id} className="px-4 py-3 flex items-start gap-3 hover:bg-bg-elev/50">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-fg text-xs font-medium">{h.name}</span>
                  <Badge tone="dim">{h.event}</Badge>
                  {h.matcher && <Badge tone="dim">match: {h.matcher}</Badge>}
                  {on && <Badge tone="accent">installed</Badge>}
                </div>
                <div className="text-fg-dim text-xs mt-0.5">{h.description}</div>
                <div className="text-fg-faint text-[10px] font-mono mt-1 truncate">{h.command}</div>
              </div>
              <div className="flex gap-1 shrink-0">
                {on ? (
                  <button disabled={busy === h.id} onClick={() => uninstall(h)} className="px-2 py-0.5 text-xs border border-line rounded text-fg-dim hover:text-red-400">remove</button>
                ) : (
                  <button disabled={busy === h.id} onClick={() => install(h)} className="px-2 py-0.5 text-xs border border-accent rounded text-accent hover:bg-accent hover:text-bg">{busy === h.id ? '…' : 'install'}</button>
                )}
              </div>
            </div>
          )
        })}
        {items.length === 0 && <EmptyState title="no matches" />}
      </div>
    </div>
  )
}

/* ------------------------------------------------ Permission presets library */

export function PermissionsPresetsLibrary() {
  const home = useHomeDir()
  const [current, setCurrent] = useState<string>('')
  const [busy, setBusy] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const path = home ? `${home}/.claude/settings.json` : null

  const refresh = async () => {
    if (!path) return
    const r = await window.api.config.readJson(path)
    const full = (r.data && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : {}) ?? {}
    setCurrent(JSON.stringify(full.permissions ?? {}))
  }

  useEffect(() => {
    refresh()
  }, [path])

  const items = useMemo(
    () => CATALOG_PERMS_PRESETS.filter((p) => matches(query, p.id, p.name, p.description)),
    [query]
  )

  const apply = async (p: CatalogPermissionPreset) => {
    if (!path) return
    setBusy(p.id)
    setError(null)
    const r = await window.api.config.readJson(path)
    const full = (r.data && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : {}) ?? {}
    const write = await window.api.config.writeJson(path, { ...full, permissions: p.permissions })
    setBusy(null)
    if (!write.ok) {
      setError(write.error ?? 'write failed')
      return
    }
    setFlash(`applied ${p.id} — replaces existing permissions block`)
    setTimeout(() => setFlash(null), 3000)
    refresh()
  }

  if (!home) return <EmptyState title="loading…" />

  return (
    <div className="h-full flex flex-col">
      <LibraryToolbar query={query} onQueryChange={setQuery} count={items.length} total={CATALOG_PERMS_PRESETS.length} />
      {(flash || error) && (
        <div className={`px-4 py-2 text-xs border-b border-line ${error ? 'text-red-400 bg-red-950/20' : 'text-accent bg-bg-elev'}`}>
          {error ?? flash}
        </div>
      )}
      <div className="flex-1 overflow-auto divide-y divide-line">
        {items.map((p) => {
          const on = current === JSON.stringify(p.permissions)
          const summary: string[] = []
          if (p.permissions.allow) summary.push(`${p.permissions.allow.length} allow`)
          if (p.permissions.deny) summary.push(`${p.permissions.deny.length} deny`)
          if (p.permissions.ask) summary.push(`${p.permissions.ask.length} ask`)
          if (p.permissions.defaultMode) summary.push(`mode: ${p.permissions.defaultMode}`)
          return (
            <div key={p.id} className="px-4 py-3 flex items-start gap-3 hover:bg-bg-elev/50">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-fg text-xs font-medium">{p.name}</span>
                  {on && <Badge tone="accent">active</Badge>}
                  <Badge tone="warn">replaces permissions</Badge>
                </div>
                <div className="text-fg-dim text-xs mt-0.5">{p.description}</div>
                <div className="text-fg-faint text-[10px] font-mono mt-1 truncate">{summary.join(' · ')}</div>
              </div>
              <div className="flex gap-1 shrink-0">
                <button disabled={busy === p.id} onClick={() => apply(p)} className="px-2 py-0.5 text-xs border border-accent rounded text-accent hover:bg-accent hover:text-bg">{busy === p.id ? '…' : 'apply'}</button>
              </div>
            </div>
          )
        })}
        {items.length === 0 && <EmptyState title="no matches" />}
      </div>
    </div>
  )
}

/* ------------------------------------------- System-prompt Insert preset menu */

/**
 * Toolbar "Insert preset" menu for the System Prompt editor. Toggles a preset's
 * managed block inside the SAME useConfig draft the editor is showing (no
 * separate write path) — the user reviews it and saves with the SaveBar.
 * Locked while unmanaged sections that collide with presets exist.
 */
export function InsertPresetMenu({ path, disabled = false }: { path: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const draft = useConfig((s) => s.files[path]?.draftRaw ?? '')
  const setDraft = useConfig((s) => s.setDraft)
  const activeIds = useMemo(() => new Set(readActivePresetIds(draft)), [draft])
  const conflicts = useMemo(() => findUnmanagedConflicts(draft, CATALOG_PROMPT_PRESETS), [draft])
  const locked = conflicts.length > 0
  const off = disabled || locked

  return (
    <div className="relative" data-testid="insert-preset-menu">
      <button
        type="button"
        data-testid="insert-preset-button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="px-2 py-0.5 text-xs rounded border border-line text-fg-dim hover:text-fg hover:bg-bg-hi disabled:opacity-50"
        title={locked ? 'Locked: unmanaged sections collide with presets' : 'Insert a preset into CLAUDE.md'}
      >
        Insert preset ▾
      </button>
      {open && (
        <div className={`absolute left-0 top-full mt-1 ${Z.dialog} w-80 max-h-96 overflow-auto rounded border border-line bg-bg-elev shadow-lg`}>
          {locked && (
            <div data-testid="insert-preset-locked" className="px-3 py-2 text-[11px] text-yellow-500/90 border-b border-line">
              Locked — unmanaged sections collide with presets: {conflicts.map((h) => `# ${h}`).join(' · ')}.
              Remove them from the document first.
            </div>
          )}
          {CATALOG_PROMPT_PRESETS.map((p) => {
            const on = activeIds.has(p.id)
            return (
              <button
                key={p.id}
                type="button"
                data-testid={`insert-preset-${p.id}`}
                disabled={off}
                onClick={() => setDraft(path, togglePreset(draft, p.id, CATALOG_PROMPT_PRESETS))}
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-bg-hi disabled:opacity-50 disabled:hover:bg-transparent"
                title={p.description}
              >
                <span className="flex-1 truncate text-fg">{p.name}</span>
                <span className={on ? 'text-accent' : 'text-fg-faint'}>{on ? 'on' : 'off'}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- shared UI */

function LibraryToolbar({
  query,
  onQueryChange,
  count,
  total,
}: {
  query: string
  onQueryChange: (v: string) => void
  count: number
  total: number
}) {
  return (
    <div className="shrink-0 border-b border-line bg-bg-elev px-3 py-1.5 flex items-center gap-2 text-xs">
      <span className="text-fg-faint">
        {count === total ? `${total} available` : `${count} of ${total}`}
      </span>
      <div className="flex-1" />
      <input
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="filter…"
        className="bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg w-48"
      />
    </div>
  )
}


function LinkBtn({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="px-2 py-0.5 text-xs border border-line rounded text-fg-dim hover:text-fg hover:bg-bg-hi"
    >
      {children}
    </a>
  )
}

/**
 * One-click plugin install. Runs the real `plugins:install` IPC (hidden pty)
 * which registers `marketplace.add` then installs `<id>@<name>` — the same two
 * commands the copy button used to hand off to the user. Streams progress into
 * an expandable log; toasts the outcome.
 */
function InstallBtn({
  id,
  marketplace,
  installed,
  onDone,
}: {
  id: string
  marketplace?: { add: string; name: string }
  installed: boolean
  onDone: () => void
}) {
  const [status, setStatus] = useState<'idle' | 'running' | 'error'>('idle')
  const [lines, setLines] = useState<string[]>([])
  const [show, setShow] = useState(false)
  // Install resolves asynchronously; the row can unmount (nav away / filter)
  // before then. Guard post-await state writes so they no-op after unmount.
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  useEffect(() => {
    const off = window.api.plugins.onInstallProgress(({ slug, line }) => {
      if (slug !== id) return
      setLines((prev) => {
        const next = [...prev, line]
        return next.length > 200 ? next.slice(next.length - 200) : next
      })
    })
    return () => off()
  }, [id])

  const run = async () => {
    setStatus('running')
    setLines([])
    setShow(true)
    try {
      const r = await window.api.plugins.install({ slug: id, marketplace })
      if (!mounted.current) {
        // Row gone; still surface the outcome via toast + refresh, skip setState.
        if (r.ok) { toast.info(`Installed ${id}`); onDone() }
        else toast.error(`Install failed: ${id} (exit ${r.exitCode})${r.error ? ` — ${r.error}` : ''}`)
        return
      }
      if (r.ok) {
        setStatus('idle')
        toast.info(`Installed ${id}`)
        onDone()
      } else {
        setStatus('error')
        toast.error(`Install failed: ${id} (exit ${r.exitCode})${r.error ? ` — ${r.error}` : ''}`)
      }
    } catch (err) {
      if (!mounted.current) { toast.error(`Install error: ${id} — ${err instanceof Error ? err.message : String(err)}`); return }
      setStatus('error')
      toast.error(`Install error: ${id} — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (installed) {
    return (
      <button
        disabled
        className="px-2 py-0.5 text-xs border border-line rounded text-fg-faint bg-bg-elev cursor-default"
      >
        installed
      </button>
    )
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={run}
        disabled={status === 'running'}
        className={`px-2 py-0.5 text-xs border rounded ${
          status === 'running'
            ? 'border-line text-fg-faint bg-bg-elev cursor-not-allowed'
            : 'border-accent/50 text-accent hover:bg-accent hover:text-bg'
        }`}
      >
        {status === 'running' ? 'installing…' : status === 'error' ? 'retry' : 'install'}
      </button>
      {lines.length > 0 && (
        <button
          onClick={() => setShow((s) => !s)}
          className="text-[10px] text-fg-faint hover:text-fg-dim"
        >
          {show ? 'hide log' : 'show log'}
        </button>
      )}
      {show && lines.length > 0 && (
        <pre className="mt-0.5 max-h-40 w-72 overflow-auto bg-bg-elev border border-line rounded p-2 text-fg-faint font-mono text-[10px] whitespace-pre-wrap text-left">
          {lines.join('\n')}
        </pre>
      )}
    </div>
  )
}

function CopyBtn({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) { toast.error('Copy failed'); return }
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="px-2 py-0.5 text-xs border border-accent/50 rounded text-accent hover:bg-accent hover:text-bg"
    >
      {copied ? 'copied!' : label}
    </button>
  )
}
