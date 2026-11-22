/**
 * PluginDetail — the detail side of Claude config ▸ Plugins (design-mocks/claude-config render 14):
 * eyebrow `PLUGIN · <MARKETPLACE> · V<version> · <SCOPE> SCOPE`, the mono name, the Enabled switch and
 * the ⋯ menu; then three cards — the manifest description, what the plugin adds (one row per command,
 * skill, agent, hook and MCP server, with its description) and where it is installed — and the saved line.
 *
 * Contents are read from the plugin's own install dir (lib/pluginContents) and re-read when any of its
 * component files change (debounced, never two reloads at once). A skill row opens the read-only
 * SkillHomePage in place of the detail.
 *
 * WHAT IT ADDS keeps the plugin's own order within each kind: manifest-declared component paths first, in
 * the order the manifest lists them, then the default folder in the order its listing returns — nothing
 * here re-sorts rows.
 *
 * The header's `Up to date` / `Update available` control compares the installed manifest version with the
 * `version` the plugin's marketplace.json entry records, read by the same reader the catalog uses
 * (lib/pluginMarketplaces, local files only — no network). With no readable version on either side the
 * control is omitted rather than faked (DESIGN_SPEC §5.4).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { EmptyState } from '../../ui/EmptyState'
import { shortenHome } from '../../ui/SourceChip'
import { useConfigDirWatch } from '../../../lib/useConfigDirWatch'
import { revealInFileExplorer } from '../../../lib/revealInFileExplorer'
import { resolveInstalledPluginSkillsDir, listPluginSkills, type PluginSkillEntry } from '../../../lib/pluginSkills'
import {
  readMdEntries,
  readPluginManifest,
  resolvePluginComponents,
  type AgentEntry,
  type McpEntry,
  type PluginManifest,
  type PluginRow,
} from '../../../lib/pluginContents'
import { toast } from '../../../state/toast'
import { listMarketplacePlugins } from '../../../lib/pluginMarketplaces'
import { ConfigCard, ConfigDetailHeader, ConfigSavedLine } from '../../claudeConfig/ConfigLayout'
import { SkillHomePage } from './PluginSkillBrowser'
import { PluginMenu } from './PluginMenu'
import { PluginSwitch } from './PluginSwitch'

/** The Extensions / Claude config tabs a plugin can hand the user to. */
export type PluginJumpTab = 'skills' | 'mcp'

export const SAVED_TEXT = 'Saved — matches settings.json › enabledPlugins'

const DETAIL_RELOAD_DEBOUNCE_MS = 250
/** Plugin component locations (relative to the install path) that feed the detail. */
const COMPONENT_WATCH_SUFFIXES = ['hooks/hooks.json', '.mcp.json', 'agents', 'skills', 'commands', '.claude-plugin/plugin.json'] as const

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** `PLUGIN · CLAUDE-PLUGINS-OFFICIAL · V1.0.0 · USER SCOPE`, leaving out what the install does not record. */
export function pluginEyebrow(row: PluginRow): string {
  const parts = ['PLUGIN']
  if (row.marketplace) parts.push(row.marketplace.toUpperCase())
  if (row.manifest?.version) parts.push(`V${row.manifest.version.toUpperCase()}`)
  parts.push(`${(row.scope ?? 'user').toUpperCase()} SCOPE`)
  return parts.join(' · ')
}

/** Numeric dotted-version compare (`1.10.0` > `1.9.2`); null when either side is not plain `x.y.z`-style. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => {
    const core = v.trim().replace(/^v/i, '').split(/[-+]/)[0]
    const parts = core.split('.')
    return parts.every((x) => /^\d+$/.test(x)) ? parts.map(Number) : null
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return null
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  return 0
}

export type UpdateState = 'up-to-date' | 'update-available'

/** `update-available` only when the marketplace records a newer version than the installed one; null when unknown. */
export function pluginUpdateState(installed: string | null | undefined, latest: string | null | undefined): UpdateState | null {
  if (!installed || !latest) return null
  const cmp = compareVersions(latest, installed)
  if (cmp === null) return latest.trim() === installed.trim() ? 'up-to-date' : 'update-available'
  return cmp > 0 ? 'update-available' : 'up-to-date'
}

/** The plugin's name as its marketplace lists it: the `name@marketplace` key's name, else the row name. */
const marketplaceName = (row: PluginRow) => (row.key && row.key.includes('@') ? row.key.slice(0, row.key.lastIndexOf('@')) : row.name)

export interface AddedItem {
  kind: 'command' | 'skill' | 'agent' | 'hook' | 'mcp'
  id: string
  name: string
  description: string | null
  skill?: PluginSkillEntry
}

interface HookItem {
  id: string
  name: string
  description: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** One row per configured hook command: `<Event> · <matcher>` and the command it runs. */
export function hookItems(data: unknown, source: string): HookItem[] {
  if (!isRecord(data)) return []
  const events = isRecord(data.hooks) ? data.hooks : data
  const out: HookItem[] = []
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue
    groups.forEach((g, gi) => {
      if (!isRecord(g) || !Array.isArray(g.hooks)) return
      const matcher = typeof g.matcher === 'string' && g.matcher ? ` · ${g.matcher}` : ''
      g.hooks.forEach((h, hi) => {
        const cmd = isRecord(h) ? (typeof h.command === 'string' ? h.command : typeof h.prompt === 'string' ? h.prompt : null) : null
        out.push({ id: `${source}:${event}:${gi}:${hi}`, name: `${event}${matcher}`, description: cmd })
      })
    })
  }
  return out
}

/** hooks.json bodies: the manifest's inline object, its declared relative path(s) inside the root, then the default file. */
async function readHookItems(root: string, manifest: PluginManifest | null): Promise<HookItem[]> {
  const decl = manifest?.hooks
  const declared = typeof decl === 'string' ? [decl] : Array.isArray(decl) ? decl.filter((d): d is string => typeof d === 'string') : []
  const paths = new Set<string>()
  for (const d of declared) {
    if (d.startsWith('/') || d.split('/').includes('..')) continue
    paths.add(`${root}/${d.replace(/^\.\//, '')}`)
  }
  paths.add(`${root}/hooks/hooks.json`)
  const bodies = await Promise.all(
    [...paths].map(async (p) => {
      const r = await window.api.config.readJson(p)
      return { p, data: r.exists && !r.parseError ? r.data : null }
    }),
  )
  return [...(isRecord(decl) ? hookItems(decl, 'manifest') : []), ...bodies.flatMap(({ p, data }) => hookItems(data, p))]
}

export interface PluginDetailProps {
  row: PluginRow
  home: string | null
  busy: boolean
  onToggle: (row: PluginRow) => void
  onUninstall: (row: PluginRow) => void
  onJump: (tab: PluginJumpTab) => void
}

export function PluginDetail({ row, home, busy, onToggle, onUninstall, onJump }: PluginDetailProps) {
  const [items, setItems] = useState<AddedItem[]>([])
  const [skills, setSkills] = useState<PluginSkillEntry[]>([])
  const [browsingSkill, setBrowsingSkill] = useState<PluginSkillEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [watchPaths, setWatchPaths] = useState<string[]>([])
  const loadSeq = useRef(0)
  const [latestVersion, setLatestVersion] = useState<string | null>(null)

  const pluginMarketplace = row.marketplace
  const pluginName = marketplaceName(row)
  useEffect(() => {
    setLatestVersion(null)
    if (!home || !pluginMarketplace) return
    let live = true
    void listMarketplacePlugins(home, { quiet: true }).then((all) => {
      if (!live) return
      const hit = all.find((p) => p.marketplace === pluginMarketplace && p.name === pluginName)
      setLatestVersion(hit?.version ?? null)
    })
    return () => {
      live = false
    }
  }, [home, pluginMarketplace, pluginName])

  const loadDetail = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const { manifest } = await readPluginManifest(row.path)
      const [skillsDir, comps, hooks] = await Promise.all([
        resolveInstalledPluginSkillsDir(row.path),
        resolvePluginComponents(row.path, manifest),
        readHookItems(row.path, manifest),
      ])
      const skillEntries = skillsDir ? await listPluginSkills(skillsDir) : []
      const [agentEntries, commandEntries] = await Promise.all([readMdEntries(comps.agentFiles), readMdEntries(comps.commandFiles)])
      const existing = await Promise.all(
        [...new Set([...COMPONENT_WATCH_SUFFIXES.map((x) => `${row.path}/${x}`), ...comps.sourcePaths])].map(async (p) =>
          (await window.api.config.exists(p)) ? p : null,
        ),
      )
      if (seq !== loadSeq.current) return
      const md = (kind: 'command' | 'agent', e: AgentEntry): AddedItem => ({
        kind,
        id: e.id,
        name: kind === 'command' ? `/${e.name ?? e.id}` : e.name ?? e.id,
        description: e.description,
      })
      setItems([
        ...commandEntries.map((e) => md('command', e)),
        ...skillEntries.map((s): AddedItem => ({ kind: 'skill', id: s.id, name: s.name ?? s.id, description: s.description, skill: s })),
        ...agentEntries.map((e) => md('agent', e)),
        ...hooks.map((h): AddedItem => ({ kind: 'hook', ...h })),
        ...comps.mcpServers.map((m: McpEntry): AddedItem => ({ kind: 'mcp', id: m.id, name: m.name, description: m.description })),
      ])
      setSkills(skillEntries)
      const nextWatch = existing.filter((p): p is string => p !== null)
      setWatchPaths((prev) => (prev.join('\0') === nextWatch.join('\0') ? prev : nextWatch))
    } catch (err) {
      if (seq !== loadSeq.current) return
      toast.error(`Failed to load plugin contents: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [row.path])

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

  const enabled = row.enabled === true
  const installedVersion = row.manifest?.version ?? null
  const updateState = pluginUpdateState(installedVersion, latestVersion)
  const description = row.manifest?.description
  const count = (k: AddedItem['kind']) => items.filter((i) => i.kind === k).length
  const kinds: Array<[AddedItem['kind'], string, string]> = [
    ['command', 'COMMAND', 'COMMANDS'],
    ['skill', 'SKILL', 'SKILLS'],
    ['agent', 'AGENT', 'AGENTS'],
    ['hook', 'HOOK', 'HOOKS'],
    ['mcp', 'MCP SERVER', 'MCP SERVERS'],
  ]
  const addsNote = kinds
    .filter(([k]) => count(k) > 0)
    .map(([k, one, many]) => plural(count(k), one, many))
    .join(' · ')
  const hasSkillsTabItems = count('skill') + count('command') > 0

  return (
    <div data-testid="plugin-detail" className="flex flex-col min-h-0">
      <ConfigDetailHeader
        eyebrow={pluginEyebrow(row)}
        title={row.name}
        actions={
          <>
            <label className="flex items-center gap-2 text-[13.5px] text-fg-dim">
              <PluginSwitch
                name={row.name}
                enabled={enabled}
                disabled={!row.key || busy}
                onToggle={() => onToggle(row)}
                testId="plugin-detail-switch"
              />
              Enabled
            </label>
            {updateState && (
              <span
                data-testid="plugin-update-state"
                data-state={updateState}
                title={`Installed v${installedVersion} · ${row.marketplace} lists v${latestVersion}`}
                className={`h-7 inline-flex items-center px-3 bg-bg border rounded-md text-[13px] font-semibold ${
                  updateState === 'update-available' ? 'border-accent text-accent' : 'border-line text-fg-dim'
                }`}
              >
                {updateState === 'update-available' ? 'Update available' : 'Up to date'}
              </span>
            )}
            <PluginMenu row={row} busy={busy} onUninstall={onUninstall} />
          </>
        }
      />
      <div className="px-9 py-6 flex flex-col gap-4 max-w-[1100px]">
        <ConfigCard label="DESCRIPTION" labelNote="FROM THE PLUGIN'S MANIFEST">
          <span data-testid="plugin-description" className={description ? undefined : 'text-fg-faint'}>
            {description ?? (row.hasManifest ? 'The manifest has no description.' : 'This plugin has no manifest.')}
          </span>
        </ConfigCard>

        <ConfigCard
          label="WHAT IT ADDS"
          labelNote={loading ? undefined : addsNote || 'NOTHING'}
          action={
            hasSkillsTabItems ? (
              <button
                type="button"
                data-testid="plugin-open-in-skills"
                onClick={() => onJump('skills')}
                className="shrink-0 text-[13px] font-semibold text-accent hover:underline"
              >
                Open in Skills →
              </button>
            ) : undefined
          }
        >
          {loading ? (
            <EmptyState title="scanning…" />
          ) : items.length === 0 ? (
            <span className="text-fg-faint">{row.error ? `Inspection failed: ${row.error}` : 'No commands, skills, agents or hooks.'}</span>
          ) : (
            <ul data-testid="plugin-adds" className="-mx-[18px] mt-2 border-t border-line">
              {items.map((it) => {
                const content = (
                  <>
                    <span className="w-[200px] shrink-0 truncate font-mono text-[14px] font-semibold text-fg" title={it.name}>
                      {it.name}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-[13.5px] text-fg-dim" title={it.description ?? undefined}>
                      {it.description ?? ''}
                    </span>
                  </>
                )
                const cls = 'w-full flex items-baseline gap-4 px-[18px] py-3 text-left'
                return (
                  <li key={`${it.kind}:${it.id}`} data-testid={`plugin-adds-${it.kind}`} className="border-b border-line last:border-b-0">
                    {it.skill ? (
                      <button type="button" onClick={() => setBrowsingSkill(it.skill!)} className={`${cls} hover:bg-bg-elev`}>
                        {content}
                      </button>
                    ) : (
                      <div className={cls}>{content}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </ConfigCard>

        <ConfigCard
          label="INSTALLED AT"
          action={
            <button
              type="button"
              data-testid="plugin-reveal"
              onClick={() => revealInFileExplorer(row.path)}
              className="shrink-0 text-[13px] text-fg-dim hover:text-fg"
            >
              Reveal
            </button>
          }
        >
          <span data-testid="plugin-install-path" title={row.path} className="block truncate font-mono text-[14px]">
            {shortenHome(row.path, home)}
          </span>
        </ConfigCard>

        <ConfigSavedLine text={SAVED_TEXT} />
      </div>
    </div>
  )
}
