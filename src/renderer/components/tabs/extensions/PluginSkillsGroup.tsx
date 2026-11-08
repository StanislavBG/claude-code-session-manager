import { useCallback, useEffect, useRef, useState } from 'react'
import { readPluginManifest, resolvePluginComponents, readMdEntries } from '../../../lib/pluginContents'
import { resolveInstalledPluginSkillsDir, listPluginSkills } from '../../../lib/pluginSkills'
import { useConfigDirWatch } from '../../../lib/useConfigDirWatch'

/** One skill or command an enabled plugin adds — listed and opened read-only (3a §3 FROM PLUGINS). */
export interface PluginSkillItem {
  kind: 'skills' | 'commands'
  /** The plugin's name (the `installed_plugins.json` key before `@`). */
  plugin: string
  name: string
  /** Absolute path to the markdown file inside the plugin's install dir. */
  path: string
  description?: string
}

/** One enabled plugin and what it adds; `error` set when reading its install dir failed. */
export interface PluginSkillsEntry {
  key: string
  name: string
  items: PluginSkillItem[]
  error?: string
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const byName = (a: PluginSkillItem, b: PluginSkillItem) => a.name.localeCompare(b.name)

/** Skills (SKILL.md folders) then commands (manifest-declared + default `commands/`) of one install dir. */
async function readPluginItems(plugin: string, installPath: string): Promise<PluginSkillItem[]> {
  const [skillsDir, { manifest }] = await Promise.all([
    resolveInstalledPluginSkillsDir(installPath),
    readPluginManifest(installPath),
  ])
  const [skills, comps] = await Promise.all([
    skillsDir ? listPluginSkills(skillsDir) : Promise.resolve([]),
    resolvePluginComponents(installPath, manifest),
  ])
  const commands = await readMdEntries(comps.commandFiles)
  return [
    ...skills
      .map((s): PluginSkillItem => ({ kind: 'skills', plugin, name: s.name ?? s.id, path: s.path, description: s.description ?? undefined }))
      .sort(byName),
    ...commands
      .map((c): PluginSkillItem => ({ kind: 'commands', plugin, name: c.name ?? c.id, path: c.id, description: c.description ?? undefined }))
      .sort(byName),
  ]
}

/**
 * The enabled plugins' skills and commands, read through pluginContents' readers. Loads once per mount
 * (while `enabled`) and again whenever config.onChanged reports a change to installed_plugins.json or the
 * user settings.json (`enabledPlugins`). A plugin whose read throws stays listed with its `error`.
 */
export function usePluginSkills(home: string | null, enabled: boolean): PluginSkillsEntry[] {
  const [entries, setEntries] = useState<PluginSkillsEntry[]>([])
  const seq = useRef(0)

  const load = useCallback(async () => {
    const id = ++seq.current
    if (!enabled) {
      setEntries([])
      return
    }
    let next: PluginSkillsEntry[] = []
    try {
      const installed = (await window.api.plugins.list()).filter((p) => p.enabled && p.installPath)
      next = await Promise.all(
        installed.map(async (p): Promise<PluginSkillsEntry> => {
          try {
            return { key: p.key, name: p.name, items: await readPluginItems(p.name, p.installPath as string) }
          } catch (e) {
            return { key: p.key, name: p.name, items: [], error: errorText(e) }
          }
        }),
      )
    } catch (e) {
      console.warn(`[skills] could not list plugins: ${errorText(e)}`)
    }
    if (seq.current !== id) return
    next.sort((a, b) => a.name.localeCompare(b.name))
    setEntries(next)
  }, [enabled])

  useEffect(() => { void load() }, [load])
  useEffect(() => () => { seq.current += 1 }, [])

  useConfigDirWatch(
    enabled && home ? [`${home}/.claude/plugins/installed_plugins.json`, `${home}/.claude/settings.json`] : [],
    () => { void load() },
  )

  return entries
}

/** `<n> skills · <m> commands`, zero parts omitted. */
function countsText(items: PluginSkillItem[]): string {
  const s = items.filter((i) => i.kind === 'skills').length
  const c = items.length - s
  return [s ? plural(s, 'skill', 'skills') : '', c ? plural(c, 'command', 'commands') : ''].filter(Boolean).join(' · ')
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 text-fg-faint/60 transition-transform ${open ? 'rotate-90' : ''}`}
      aria-hidden
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

interface Props {
  plugins: PluginSkillsEntry[]
  /** Lowercased filter needle ('' = no filter); matches item name/description or the plugin name. */
  needle: string
  selectedPath: string | null
  onSelect: (path: string) => void
}

/** The FROM PLUGINS list section: header + READ-ONLY badge, one expandable row per enabled plugin. */
export function PluginSkillsGroup({ plugins, needle, selectedPath, onSelect }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const shown = plugins
    .map((p) => {
      if (!needle || p.name.toLowerCase().includes(needle)) return { p, items: p.items }
      const items = p.items.filter(
        (i) => i.name.toLowerCase().includes(needle) || !!i.description?.toLowerCase().includes(needle),
      )
      return { p, items }
    })
    .filter(({ p, items }) => !needle || items.length > 0 || p.name.toLowerCase().includes(needle))
  const total = shown.reduce((n, s) => n + s.items.length, 0)

  const toggle = (key: string) =>
    setExpanded((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <>
      <div
        data-testid="skills-section-plugins"
        className="flex items-center gap-2 mt-3 mx-1.5 mb-1 text-[11px] font-semibold tracking-[0.06em] uppercase text-fg-faint"
      >
        From plugins
        <span data-testid="skills-section-plugins-count" className="font-mono font-medium tracking-normal text-fg-faint/60">
          {total}
        </span>
        <span
          data-testid="skills-section-plugins-readonly"
          title="Plugin files are managed by the plugin — open them to read, not edit"
          className="ml-auto px-[5px] border border-line rounded-[3px] text-[9.5px] font-medium tracking-normal text-fg-faint"
        >
          READ-ONLY
        </span>
      </div>
      {plugins.length === 0 && (
        <div className="mx-1.5 mb-1 text-xs text-fg-faint">No enabled plugin adds skills or commands</div>
      )}
      {shown.map(({ p, items }) => {
        // A filter match opens the row so the matching items are visible.
        const open = !p.error && (expanded.has(p.key) || (!!needle && items.length > 0))
        return (
          <div key={p.key} className="flex flex-col">
            <button
              type="button"
              data-testid="plugin-skills-row"
              data-plugin={p.name}
              aria-expanded={open}
              onClick={() => toggle(p.key)}
              className="flex items-center gap-2 px-2.5 py-[7px] border border-transparent rounded-[7px] text-left text-[12.5px] text-fg-dim hover:bg-bg-hi"
            >
              <span className="min-w-0 truncate">{p.name}</span>
              {p.error ? (
                <span data-testid="plugin-skills-row-error" title={p.error} className="ml-auto shrink-0 text-[11px] text-red-400">
                  Could not read plugin
                </span>
              ) : (
                <span data-testid="plugin-skills-row-counts" className="ml-auto shrink-0 font-mono text-[11px] text-fg-faint">
                  {countsText(p.items) || 'nothing to list'}
                </span>
              )}
              <Chevron open={open} />
            </button>
            {open &&
              items.map((i) => {
                const selected = selectedPath === i.path
                return (
                  <button
                    key={i.path}
                    type="button"
                    data-testid="plugin-skills-item"
                    data-path={i.path}
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => onSelect(i.path)}
                    className={`ml-3 mb-0.5 flex flex-col gap-[2px] px-2.5 py-1.5 border rounded-[7px] text-left ${
                      selected ? 'border-accent bg-bg-hi' : 'border-transparent hover:bg-bg-hi'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span data-testid="plugin-skills-item-name" className="min-w-0 truncate font-mono text-[12px] font-semibold text-fg">
                        /{i.name}
                      </span>
                      <span className="ml-auto shrink-0 text-[9.5px] tracking-[0.04em] text-fg-faint">
                        {i.kind === 'commands' ? 'COMMAND' : 'SKILL'}
                      </span>
                    </span>
                    {i.description && (
                      <span title={i.description} className="truncate text-[11px] text-fg-faint">
                        {i.description}
                      </span>
                    )}
                  </button>
                )
              })}
          </div>
        )
      })}
    </>
  )
}
