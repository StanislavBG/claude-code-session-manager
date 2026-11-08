/**
 * PluginCard — one installed plugin on Home ▸ Extensions ▸ Plugins, in the 3a design
 * (`session-manager-operations/design-mocks/extensions-3a/DESIGN_SPEC.md` §5).
 *
 * Grid `36px | 1fr | auto`: the enable switch; the plugin itself (name → drill-in, version,
 * provenance, scope, description, contents chips, one quiet cache-path line); and a ⋯ menu with
 * Reveal in File Explorer, Copy path and Uninstall.
 *
 * Chips show what the plugin adds, from `summarizePluginContents`, zero counts left out. A `›` chip
 * stays on the Extensions page and switches its tab (`onJump`): skills and commands live in Skills,
 * servers in MCP Servers. A `↗` chip leaves for the page that owns that kind: agents → Agents,
 * hooks → Settings ▸ Hooks.
 *
 * Uninstall confirms inline inside the menu (DESIGN_SPEC §7.7) — never a native `window.confirm`.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ProvenanceBadge } from '../../ui/ProvenanceBadge'
import { shortenHome } from '../../ui/SourceChip'
import type { ProvenanceInput } from '../../../lib/provenance'
import { summarizePluginContents, type PluginRow } from '../../../lib/pluginContents'
import { revealInFileExplorer } from '../../../lib/revealInFileExplorer'
import { copyText } from '../../../lib/clipboard'
import { Z } from '../../../lib/zLayers'
import { useLayout } from '../../../state/layout'
import { toast } from '../../../state/toast'

/** The Extensions tabs a `›` chip can switch to. */
export type PluginJumpTab = 'skills' | 'mcp'

/** One source for a plugin's provenance input, so the card and the drill-in header badges agree. */
export const pluginProvInput = (r: PluginRow): ProvenanceInput => ({
  type: 'plugin', name: r.name, repository: r.manifest?.repository, homepage: r.manifest?.homepage,
})

export interface PluginCardProps {
  row: PluginRow
  /** Home dir, to show the cache path as `~/…`; the absolute path shows until it resolves. */
  home: string | null
  /** True while this plugin's enable or uninstall call is in flight. */
  busy: boolean
  onToggle: (row: PluginRow) => void
  /** Opens the plugin's drill-in page. */
  onOpen: (row: PluginRow) => void
  /** Runs the uninstall; the card has already confirmed it. */
  onUninstall: (row: PluginRow) => void
  onJump: (tab: PluginJumpTab) => void
}

interface ContentChip {
  kind: 'skills' | 'commands' | 'mcp' | 'agents' | 'hooks'
  /** Mono count before the label; null shows the label alone (a single MCP server). */
  count: number | null
  label: string
  /** `›` switches the Extensions tab; `↗` opens another page. */
  arrow: '›' | '↗'
  title: string
  onClick: () => void
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

function contentChips(row: PluginRow, onJump: (tab: PluginJumpTab) => void): ContentChip[] {
  const c = summarizePluginContents(row)
  const chips: ContentChip[] = []
  if (c.skills > 0) {
    chips.push({
      kind: 'skills', count: c.skills, label: plural(c.skills, 'skill', 'skills'), arrow: '›',
      title: 'Show in the Skills tab', onClick: () => onJump('skills'),
    })
  }
  if (c.commands > 0) {
    chips.push({
      kind: 'commands', count: c.commands, label: plural(c.commands, 'command', 'commands'), arrow: '›',
      title: 'Show in the Skills tab', onClick: () => onJump('skills'),
    })
  }
  if (c.mcpServers > 0) {
    chips.push({
      kind: 'mcp', count: c.mcpServers === 1 ? null : c.mcpServers, label: plural(c.mcpServers, 'MCP server', 'MCP servers'),
      arrow: '›', title: 'Show in the MCP Servers tab', onClick: () => onJump('mcp'),
    })
  }
  if (c.agents > 0) {
    chips.push({
      kind: 'agents', count: c.agents, label: plural(c.agents, 'agent', 'agents'), arrow: '↗',
      title: 'Open the Agents page', onClick: () => useLayout.getState().openPanel('agent-library'),
    })
  }
  if (c.hooks > 0) {
    chips.push({
      kind: 'hooks', count: c.hooks, label: plural(c.hooks, 'hook', 'hooks'), arrow: '↗',
      title: 'Open Settings ▸ Hooks', onClick: () => useLayout.getState().openPanel('settings', 'hooks'),
    })
  }
  return chips
}

const scopeLabel = (scope: string) => `${scope.charAt(0).toUpperCase()}${scope.slice(1)} scope`

export function PluginCard({ row, home, busy, onToggle, onOpen, onUninstall, onJump }: PluginCardProps) {
  const enabled = row.enabled === true
  const version = row.manifest?.version
  const description = row.manifest?.description
  const chips = contentChips(row, onJump)

  return (
    <div
      data-testid="plugin-card"
      className="grid grid-cols-[36px_minmax(0,1fr)_auto] gap-x-4 px-[18px] py-4 bg-bg-hi border border-line rounded-[10px]"
    >
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={`${enabled ? 'Disable' : 'Enable'} ${row.name}`}
        data-testid="plugin-enabled-switch"
        disabled={!row.key || busy}
        onClick={() => onToggle(row)}
        className={`relative mt-px w-9 h-5 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
          enabled ? 'bg-accent' : 'bg-rule'
        }`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-bg-hi shadow transition-[left] ${
            enabled ? 'left-[18px]' : 'left-0.5'
          }`}
        />
      </button>

      <div className="min-w-0 flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5">
          <button
            type="button"
            data-testid="plugin-card-name"
            onClick={() => onOpen(row)}
            title={`Open ${row.name}`}
            className="text-left text-[15px] font-semibold text-fg hover:text-accent hover:underline"
          >
            {row.name}
          </button>
          {version ? <span className="font-mono text-[11.5px] text-fg-faint">v{version}</span> : null}
          <ProvenanceBadge interactive={false} input={pluginProvInput(row)} />
          {row.scope ? (
            <span data-testid="plugin-scope" className="text-xs text-fg-faint">
              {scopeLabel(row.scope)}
            </span>
          ) : null}
        </div>

        {description ? (
          <p data-testid="plugin-card-description" title={description} className="text-[13px] text-fg-dim">
            {description}
          </p>
        ) : null}

        {chips.length > 0 || row.error ? (
          <div className="flex flex-wrap gap-1.5">
            {chips.map((chip) => (
              <button
                key={chip.kind}
                type="button"
                data-testid={`plugin-chip-${chip.kind}`}
                title={chip.title}
                onClick={chip.onClick}
                className="inline-flex items-center gap-[5px] h-6 px-2.5 bg-bg border border-line rounded-full text-xs text-fg-dim hover:border-accent hover:text-fg"
              >
                {chip.count !== null ? <b className="font-mono font-semibold text-fg">{chip.count}</b> : null}
                {chip.count !== null ? ' ' : null}
                {chip.label}{' '}
                <span aria-hidden="true" className="text-fg-faint/60">{chip.arrow}</span>
              </button>
            ))}
            {row.error ? (
              <span
                title={row.error}
                className="inline-flex items-center h-6 px-2.5 border border-delta-bad/30 rounded-full text-xs text-delta-bad"
              >
                inspection failed
              </span>
            ) : null}
          </div>
        ) : null}

        <span
          data-testid="plugin-card-path"
          title={row.path}
          className="font-mono text-[11px] text-fg-faint/80 whitespace-nowrap overflow-hidden text-ellipsis"
        >
          {shortenHome(row.path, home)}
        </span>
      </div>

      <PluginMenu row={row} busy={busy} onUninstall={onUninstall} />
    </div>
  )
}

/** The ⋯ menu: Reveal in File Explorer, Copy path, divider, then Uninstall with its inline confirm. */
function PluginMenu({ row, busy, onUninstall }: Pick<PluginCardProps, 'row' | 'busy' | 'onUninstall'>) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  // Closing always drops a pending confirm, so the menu reopens on its item list.
  const close = useCallback(() => {
    setOpen(false)
    setConfirming(false)
  }, [])

  // Escape or a mousedown outside the trigger + menu closes it (same rule as ExtensionsToolbar).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  const reveal = () => {
    close()
    revealInFileExplorer(row.path)
  }
  const copyPath = async () => {
    close()
    if (!(await copyText(row.path))) toast.error(`Could not copy ${row.path} to the clipboard`)
  }
  const confirmUninstall = () => {
    close()
    onUninstall(row)
  }

  const item = 'px-2.5 py-[7px] rounded-[5px] text-left whitespace-nowrap hover:bg-bg-elev'

  return (
    <div ref={wrapRef} className="relative self-start">
      <button
        type="button"
        data-testid="plugin-menu"
        aria-label={`Actions for ${row.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
        className="w-[30px] h-7 inline-flex items-center justify-center bg-bg border border-line rounded-md text-fg-dim hover:border-rule"
      >
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={`Actions for ${row.name}`}
          className={`absolute ${Z.dialog} right-0 top-[34px] w-[210px] p-[5px] flex flex-col bg-bg-hi border border-line rounded-lg shadow-lg text-[12.5px] text-fg`}
        >
          {confirming ? (
            <div className="flex flex-col gap-2 px-2.5 py-[7px]">
              <span className="font-medium">Uninstall {row.name}?</span>
              <div className="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  role="menuitem"
                  data-testid="plugin-uninstall"
                  disabled={busy}
                  onClick={confirmUninstall}
                  className="h-6 px-2.5 rounded-[5px] bg-delta-bad text-bg-hi font-medium hover:bg-delta-bad/90 disabled:opacity-40"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setConfirming(false)}
                  className="h-6 px-2.5 rounded-[5px] border border-line text-fg-dim hover:bg-bg-elev"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={reveal} className={item}>
                Reveal in File Explorer
              </button>
              <button type="button" role="menuitem" onClick={() => void copyPath()} className={item}>
                Copy path
              </button>
              <div role="separator" className="h-px mx-1.5 my-1 bg-line" />
              <button
                type="button"
                role="menuitem"
                disabled={!row.marketplace || busy}
                title={row.marketplace ? undefined : 'No marketplace is recorded for this install'}
                onClick={() => setConfirming(true)}
                className={`${item} font-medium text-delta-bad hover:bg-delta-bad/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent`}
              >
                Uninstall {row.name}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
