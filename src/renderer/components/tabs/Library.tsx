import { useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState } from '../ui/EmptyState'
import { Badge } from '../ui/Badge'
import { useHomeDir } from '../../lib/useHomeDir'
import { toast } from '../../state/toast'
import {
  CATALOG_MCP,
  CATALOG_SKILLS,
  CATALOG_PLUGINS,
  CATALOG_HOOKS,
  CATALOG_AGENTS,
  CATALOG_PERMS_PRESETS,
  CATALOG_PROMPT_PRESETS,
  type CatalogMcp,
  type CatalogHook,
  type CatalogAgent,
  type CatalogPermissionPreset,
  type CatalogPromptPreset,
  type PromptPresetCategory,
} from '../../data/catalog'
import {
  readActivePresetIds,
  togglePreset,
  conflictingSectionCount,
  findUnmanagedConflicts,
  stripUnmanagedSections,
} from '../../lib/presetBlock'

/**
 * Library browser panels for installable extensions. Embedded inside the
 * Skills / Plugins / McpServers tabs behind a view toggle — catalog data
 * lives alongside the "installed" views so there's one home per concept.
 */

function matches(q: string, ...fields: string[]): boolean {
  if (!q.trim()) return true
  const needle = q.toLowerCase()
  return fields.some((f) => f.toLowerCase().includes(needle))
}

/* ----------------------------------------------------------- MCP library */

export function McpLibrary() {
  const home = useHomeDir()
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const refresh = async () => {
    if (!home) return
    const r = await window.api.config.readJson(`${home}/.claude.json`)
    const servers = (r.data as { mcpServers?: Record<string, unknown> } | null)?.mcpServers ?? {}
    setInstalled(new Set(Object.keys(servers)))
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home])

  const items = useMemo(
    () => CATALOG_MCP.filter((m) => matches(query, m.id, m.name, m.description)),
    [query]
  )

  const install = async (m: CatalogMcp) => {
    if (!home) return
    setBusy(m.id)
    setError(null)
    const path = `${home}/.claude.json`
    const r = await window.api.config.readJson(path)
    const full = (r.data && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : {}) ?? {}
    const servers = { ...((full.mcpServers as Record<string, unknown>) ?? {}) }
    servers[m.id] = { ...('command' in m.config ? { type: 'stdio' } : {}), ...m.config }
    const write = await window.api.config.writeJson(path, { ...full, mcpServers: servers })
    setBusy(null)
    if (!write.ok) {
      setError(write.error ?? 'write failed')
      return
    }
    setFlash(`installed ${m.id} — switch to Installed to edit placeholders`)
    setTimeout(() => setFlash(null), 4000)
    refresh()
  }

  const uninstall = async (id: string) => {
    if (!home) return
    setBusy(id)
    setError(null)
    const path = `${home}/.claude.json`
    const r = await window.api.config.readJson(path)
    const full = (r.data && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : {}) ?? {}
    const servers = { ...((full.mcpServers as Record<string, unknown>) ?? {}) }
    delete servers[id]
    const write = await window.api.config.writeJson(path, { ...full, mcpServers: servers })
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
    const r = await window.api.config.listDir(`${home}/.claude/skills`, { dirsOnly: true })
    setInstalled(new Set(r.entries.map((e) => e.name)))
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const refresh = async () => {
    if (!home) return
    const ids = new Set<string>()
    // Legacy signal: a top-level dir under ~/.claude/plugins named for the id.
    const r = await window.api.config.listDir(`${home}/.claude/plugins`, { dirsOnly: true })
    for (const e of r.entries) ids.add(e.name)
    // Authoritative signal: settings.json `enabledPlugins` keyed `id@marketplace`.
    try {
      const s = await window.api.config.readJson(`${home}/.claude/settings.json`)
      const enabled = (s.data as { enabledPlugins?: Record<string, boolean> })?.enabledPlugins
      if (enabled) {
        for (const [key, on] of Object.entries(enabled)) {
          if (on) ids.add(key.split('@')[0])
        }
      }
    } catch {
      /* settings.json absent/unreadable — dir signal still stands */
    }
    setInstalled(ids)
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home])

  const items = useMemo(
    () => CATALOG_PLUGINS.filter((p) => matches(query, p.id, p.name, p.description)),
    [query]
  )

  if (!home) return <EmptyState title="loading…" />

  return (
    <div className="h-full flex flex-col">
      <LibraryToolbar
        query={query}
        onQueryChange={setQuery}
        count={items.length}
        total={CATALOG_PLUGINS.length}
      />
      <div className="flex-1 overflow-auto divide-y divide-line">
        {items.map((p) => {
          const on = installed.has(p.id)
          // Plugins from a non-official marketplace need a one-time
          // `/plugin marketplace add <repo>` before install; the official
          // catalog marketplace is pre-registered, so it's install-only.
          // `bundled` ships inside this app — the in-app Install button wires
          // the marketplace add automatically, so the copy form is install-only.
          const mktName = p.marketplace?.name ?? 'anthropics/claude-plugins-official'
          const installLine = `/plugin install ${p.id}@${mktName}`
          const installCmd =
            p.marketplace && p.marketplace.add !== 'bundled'
              ? `/plugin marketplace add ${p.marketplace.add}\n${installLine}`
              : installLine
          return (
            <div key={p.id} className="px-4 py-3 flex items-start gap-3 hover:bg-bg-elev/50">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-fg text-xs font-medium">{p.name}</span>
                  {p.official && <Badge>official</Badge>}
                  {on && <Badge tone="accent">installed</Badge>}
                  {p.bundles.map((b) => (
                    <Badge key={b} tone="dim">
                      {b}
                    </Badge>
                  ))}
                </div>
                <div className="text-fg-dim text-xs mt-0.5">{p.description}</div>
                <div className="text-fg-faint text-[10px] font-mono mt-1 truncate">{installLine}</div>
              </div>
              <div className="flex gap-1 shrink-0 items-start">
                <LinkBtn href={p.source}>source</LinkBtn>
                <CopyBtn text={installCmd} label="copy" />
                <InstallBtn
                  id={p.id}
                  marketplace={p.marketplace}
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

/* ----------------------------------------------------------- Agents library */

export function AgentsLibrary() {
  const home = useHomeDir()
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const refresh = async () => {
    if (!home) return
    const r = await window.api.config.listDir(`${home}/.claude/agents`, { filesOnly: true })
    const names = new Set<string>()
    for (const e of r.entries) {
      if (e.name.endsWith('.md')) names.add(e.name.replace(/\.md$/, ''))
    }
    setInstalled(names)
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home])

  const items = useMemo(
    () => CATALOG_AGENTS.filter((a) => matches(query, a.id, a.name, a.description)),
    [query]
  )

  const install = async (a: CatalogAgent) => {
    if (!home) return
    setBusy(a.id)
    setError(null)
    const path = `${home}/.claude/agents/${a.id}.md`
    const write = await window.api.config.writeText(path, a.content)
    setBusy(null)
    if (!write.ok) {
      setError(write.error ?? 'write failed')
      return
    }
    setFlash(`installed ${a.id}`)
    setTimeout(() => setFlash(null), 2500)
    refresh()
  }

  if (!home) return <EmptyState title="loading…" />

  return (
    <div className="h-full flex flex-col">
      <LibraryToolbar query={query} onQueryChange={setQuery} count={items.length} total={CATALOG_AGENTS.length} />
      {(flash || error) && (
        <div className={`px-4 py-2 text-xs border-b border-line ${error ? 'text-red-400 bg-red-950/20' : 'text-accent bg-bg-elev'}`}>
          {error ?? flash}
        </div>
      )}
      <div className="flex-1 overflow-auto divide-y divide-line">
        {items.map((a) => {
          const on = installed.has(a.id)
          return (
            <div key={a.id} className="px-4 py-3 flex items-start gap-3 hover:bg-bg-elev/50">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-fg text-xs font-medium">{a.name}</span>
                  {a.tools && <Badge tone="dim">{a.tools.split(',').length} tools</Badge>}
                  {on && <Badge tone="accent">installed</Badge>}
                </div>
                <div className="text-fg-dim text-xs mt-0.5">{a.description}</div>
                <div className="text-fg-faint text-[10px] font-mono mt-1 truncate">~/.claude/agents/{a.id}.md</div>
              </div>
              <div className="flex gap-1 shrink-0">
                <button disabled={busy === a.id} onClick={() => install(a)} className="px-2 py-0.5 text-xs border border-accent rounded text-accent hover:bg-accent hover:text-bg">{busy === a.id ? '…' : on ? 'overwrite' : 'install'}</button>
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

/* --------------------------------------------- System-prompt presets library */

const CATEGORY_LABELS: Record<PromptPresetCategory, string> = {
  communication: 'Communication',
  'working-style': 'Working style',
  security: 'Security',
  testing: 'Testing',
  review: 'Code review',
  documentation: 'Documentation',
  debugging: 'Debugging',
  architecture: 'Architecture',
  refactoring: 'Refactoring',
  performance: 'Performance',
  collaboration: 'Collaboration',
  domain: 'Domain / stack',
}

export function PromptPresetsLibrary() {
  const home = useHomeDir()
  const [existing, setExisting] = useState<string>('')
  const [busy, setBusy] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const path = home ? `${home}/.claude/CLAUDE.md` : null

  const refresh = async () => {
    if (!path) return
    const r = await window.api.config.readText(path)
    setExisting(r.text)
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  const activeIds = useMemo(() => new Set(readActivePresetIds(existing)), [existing])
  const unmanagedConflicts = useMemo(
    () => findUnmanagedConflicts(existing, CATALOG_PROMPT_PRESETS),
    [existing]
  )

  const cleanupUnmanaged = async () => {
    if (!path || unmanagedConflicts.length === 0) return
    setError(null)
    const next = stripUnmanagedSections(existing, unmanagedConflicts)
    const write = await window.api.config.writeText(path, next)
    if (!write.ok) {
      setError(write.error ?? 'write failed')
      return
    }
    setFlash(`removed ${unmanagedConflicts.length} unmanaged section(s)`)
    setTimeout(() => setFlash(null), 3000)
    refresh()
  }

  const items = useMemo(
    () =>
      CATALOG_PROMPT_PRESETS.filter((p) =>
        matches(query, p.id, p.name, p.description, p.section, ...(p.tags ?? []))
      ),
    [query]
  )

  const grouped = useMemo(() => {
    const out = new Map<PromptPresetCategory, CatalogPromptPreset[]>()
    for (const p of items) {
      const list = out.get(p.category) ?? []
      list.push(p)
      out.set(p.category, list)
    }
    return out
  }, [items])

  const toggle = async (p: CatalogPromptPreset) => {
    if (!path) return
    setBusy(p.id)
    setError(null)
    const next = togglePreset(existing, p.id, CATALOG_PROMPT_PRESETS)
    const write = await window.api.config.writeText(path, next)
    setBusy(null)
    if (!write.ok) {
      setError(write.error ?? 'write failed')
      return
    }
    const nowActive = !activeIds.has(p.id)
    setFlash(nowActive ? `enabled "${p.name}"` : `disabled "${p.name}"`)
    setTimeout(() => setFlash(null), 2500)
    refresh()
  }

  if (!home) return <EmptyState title="loading…" />

  const activeCount = activeIds.size
  const catOrder: PromptPresetCategory[] = [
    'communication',
    'working-style',
    'testing',
    'review',
    'security',
    'debugging',
    'architecture',
    'refactoring',
    'performance',
    'documentation',
    'collaboration',
    'domain',
  ]

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 border-b border-line bg-bg-elev px-3 py-1.5 flex items-center gap-2 text-xs">
        <span className="text-fg-faint">
          {activeCount > 0 ? (
            <>
              <span className="text-fg-dim font-medium">{activeCount}</span> active · managed in{' '}
              <code className="text-fg-faint">~/.claude/CLAUDE.md</code>
            </>
          ) : (
            <>nothing active — toggle presets below to stack them in your CLAUDE.md</>
          )}
        </span>
        <div className="flex-1" />
        <span className="text-fg-faint">
          {items.length === CATALOG_PROMPT_PRESETS.length
            ? `${CATALOG_PROMPT_PRESETS.length} available`
            : `${items.length} of ${CATALOG_PROMPT_PRESETS.length}`}
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search presets…"
          className="bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg w-56"
        />
      </div>
      {(flash || error) && (
        <div
          className={`px-4 py-2 text-xs border-b border-line ${
            error ? 'text-red-400 bg-red-950/20' : 'text-accent bg-bg-elev'
          }`}
        >
          {error ?? flash}
        </div>
      )}
      {unmanagedConflicts.length > 0 && (
        <div className="px-4 py-2 text-xs border-b border-line bg-yellow-950/20 flex items-start gap-3">
          <div className="flex-1 text-yellow-500/90">
            <div className="font-medium">Your CLAUDE.md has unmanaged sections that will collide with presets:</div>
            <div className="text-yellow-500/70 mt-0.5">
              {unmanagedConflicts.map((h) => `# ${h}`).join(' · ')}
            </div>
            <div className="text-fg-faint mt-1">
              These were probably added before presets were toggleable. Clean them out so the managed block owns those sections.
            </div>
          </div>
          <button
            onClick={cleanupUnmanaged}
            className="shrink-0 px-3 py-1 text-xs border border-yellow-600/60 rounded text-yellow-400 hover:bg-yellow-600 hover:text-bg"
          >
            remove {unmanagedConflicts.length} section{unmanagedConflicts.length > 1 ? 's' : ''}
          </button>
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {catOrder
          .map((cat) => ({ cat, presets: grouped.get(cat) ?? [] }))
          .filter((g) => g.presets.length > 0)
          .map(({ cat, presets }) => (
            <PresetCategorySection
              key={cat}
              title={CATEGORY_LABELS[cat]}
              presets={presets}
              activeIds={activeIds}
              existing={existing}
              busy={busy}
              onToggle={toggle}
            />
          ))}
        {items.length === 0 && <EmptyState title="no matches" />}
      </div>
    </div>
  )
}

function PresetCategorySection({
  title,
  presets,
  activeIds,
  existing,
  busy,
  onToggle,
}: {
  title: string
  presets: CatalogPromptPreset[]
  activeIds: Set<string>
  existing: string
  busy: string | null
  onToggle: (p: CatalogPromptPreset) => void
}) {
  const [open, setOpen] = useState(true)
  const activeInCat = presets.filter((p) => activeIds.has(p.id)).length
  return (
    <section className="border-b border-line">
      <header
        className="px-4 py-2 bg-bg-elev/40 cursor-pointer hover:bg-bg-elev flex items-center gap-3"
        onClick={() => setOpen(!open)}
      >
        <span className="text-fg-faint w-3">{open ? '▾' : '▸'}</span>
        <h2 className="text-fg text-sm font-medium flex-1">{title}</h2>
        <span className="text-fg-faint text-xs">
          {activeInCat > 0 ? `${activeInCat}/${presets.length} active` : `${presets.length}`}
        </span>
      </header>
      {open && (
        <div className="divide-y divide-line/60">
          {presets.map((p) => {
            const on = activeIds.has(p.id)
            const conflicts = conflictingSectionCount(existing, p, CATALOG_PROMPT_PRESETS)
            return (
              <div key={p.id} className="px-4 py-3 flex items-start gap-3 hover:bg-bg-elev/20">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-fg text-sm">{p.name}</span>
                    {on && <Badge tone="accent">active</Badge>}
                    <span className="text-[10px] px-1 py-0 rounded border border-line bg-bg-elev text-fg-faint uppercase tracking-wide">
                      → # {p.section}
                    </span>
                    {!on && conflicts > 0 && (
                      <span className="text-[10px] px-1 py-0 rounded border border-yellow-900/40 bg-yellow-950/30 text-yellow-500/80 uppercase tracking-wide">
                        merges with {conflicts}
                      </span>
                    )}
                  </div>
                  <div className="text-fg-dim text-xs mt-0.5">{p.description}</div>
                  <ul className="text-fg-faint text-[11px] mt-1 space-y-0.5 list-disc list-inside">
                    {p.bullets.slice(0, 2).map((b, i) => (
                      <li key={i} className="truncate">
                        {b}
                      </li>
                    ))}
                    {p.bullets.length > 2 && (
                      <li className="text-fg-faint italic">+{p.bullets.length - 2} more</li>
                    )}
                  </ul>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button
                    disabled={busy === p.id}
                    onClick={() => onToggle(p)}
                    className={`px-3 py-0.5 text-xs rounded border transition-colors ${
                      on
                        ? 'bg-accent text-bg border-accent hover:bg-transparent hover:text-fg-dim'
                        : 'bg-bg-elev text-fg-dim border-line hover:text-fg hover:bg-bg-hi'
                    }`}
                    title={on ? 'remove from CLAUDE.md' : 'add to CLAUDE.md'}
                  >
                    {busy === p.id ? '…' : on ? 'on' : 'off'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------- shared UI */

/** "Installed | Library" pill toggle used by all three tabs. */
export function ViewSwitcher({
  active,
  onChange,
  installedLabel = 'Installed',
  libraryLabel = 'Library',
}: {
  active: 'installed' | 'library'
  onChange: (v: 'installed' | 'library') => void
  installedLabel?: string
  libraryLabel?: string
}) {
  return (
    <div className="flex rounded border border-line overflow-hidden">
      {(
        [
          ['installed', installedLabel],
          ['library', libraryLabel],
        ] as const
      ).map(([key, label]) => (
        <button
          key={key}
          onClick={() => onChange(key)}
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
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      className="px-2 py-0.5 text-xs border border-accent/50 rounded text-accent hover:bg-accent hover:text-bg"
    >
      {copied ? 'copied!' : label}
    </button>
  )
}
