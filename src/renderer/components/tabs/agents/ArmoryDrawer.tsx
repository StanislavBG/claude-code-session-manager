import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Armory, ArmoryItem } from '../../../../preload/api'
import { Z } from '../../../lib/zLayers'
import { useLayout } from '../../../state/layout'

/**
 * The Armory drawer (frame 1e): every equippable item grouped by kind, searchable, with badges.
 * Items drag (HTML5) onto the matching GearPanel row, or are equipped with the Equip button (Enter on
 * the focused button) — drag-and-drop is never the only way. Skills outside a pack are listed, not equippable.
 */

export type ArmoryKind = 'builtin' | 'mcp' | 'pack'
type KindTab = 'all' | ArmoryKind
const KIND_TABS: Array<{ id: KindTab; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'builtin', label: 'Built-in' }, { id: 'mcp', label: 'MCP' }, { id: 'pack', label: 'Packs' },
]

export interface ArmoryEquipped {
  /** True when the persona has no tools: line — every built-in counts as equipped. */
  allBuiltins: boolean
  builtins: readonly string[]
  servers: readonly string[]
  packs: readonly string[]
}

interface Props {
  armory: Armory | null
  equipped: ArmoryEquipped
  onEquip: (kind: ArmoryKind, id: string) => void
  onUnequip: (kind: ArmoryKind, id: string) => void
  onDragStart: (kind: ArmoryKind, id: string) => void
  onDragEnd: () => void
  onClose: () => void
}

const DOT: Record<string, string> = { checked: 'bg-green-600', failing: 'bg-red-600', 'not-checked': 'bg-fg-faint' }

function Badges({ badges }: { badges: ArmoryItem['badges'] }) {
  return (
    <>
      {badges.includes('risky') && <span data-badge="risky" className="ml-1 px-1 rounded text-[9.5px] uppercase bg-honey/20 text-honey-dark">risky</span>}
      {badges.includes('banned') && <span data-badge="banned" className="ml-1 px-1 rounded text-[9.5px] uppercase bg-red-500/15 text-red-700">banned</span>}
    </>
  )
}

function Group({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="mb-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-faint mb-1.5">
        {title} {sub && <span className="font-serif italic normal-case tracking-normal font-normal">{sub}</span>}
      </h3>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  )
}

export function ArmoryDrawer({ armory, equipped, onEquip, onUnequip, onDragStart, onDragEnd, onClose }: Props) {
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<KindTab>('all')
  const [moving, setMoving] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => { searchRef.current?.focus() }, [])
  const needle = q.trim().toLowerCase()
  const hit = (...s: string[]) => !needle || s.some((x) => x.toLowerCase().includes(needle))

  // A plain render function (not a component): a component declared here would remount mid-drag and cancel it.
  const renderItem = ({ kind, id, label, badges, meta, on, locked }: { kind: ArmoryKind; id: string; label: string; badges: ArmoryItem['badges']; meta?: ReactNode; on: boolean; locked?: boolean }) => (
    <div
      data-testid="armory-item"
      data-kind={kind}
      data-item={id}
      data-equipped={on ? 'true' : undefined}
      draggable={!on && !locked}
      data-moving={moving === `${kind}:${id}` ? 'true' : undefined}
      onDragStart={(e) => {
        setMoving(`${kind}:${id}`)
        e.dataTransfer?.setData('text/plain', `${kind}:${id}`)
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
        onDragStart(kind, id)
      }}
      onDragEnd={() => { setMoving(null); onDragEnd() }}
      className={`rounded-[10px] border px-2.5 py-1.5 flex items-center gap-2 ${moving === `${kind}:${id}` ? 'border-dashed border-accent/60 bg-accent/5' : on ? 'border-line bg-bg-hi' : 'border-line bg-bg cursor-grab'}`}
    >
      <span data-testid="armory-grip" aria-hidden="true" className="text-fg-faint text-[11px] leading-none select-none">⋮⋮</span>
      <div className="min-w-0 flex-1">
        <div title={id} className="font-mono text-[12.5px] font-semibold text-fg truncate">{label}<Badges badges={badges} /></div>
        {meta && <div className="text-[11px] text-fg-dim flex items-center gap-1.5">{meta}</div>}
      </div>
      {moving === `${kind}:${id}` ? (
        <span data-testid="armory-moving" className="text-[11px] font-semibold text-accent-dark">Moving…</span>
      ) : locked ? (
        <span className="text-[11px] text-fg-faint">always granted</span>
      ) : on ? (
        <>
          <span data-testid="armory-on-sheet" className="text-[11px] text-fg-dim">✓ On sheet</span>
          <button type="button" data-testid="armory-unequip" aria-label={`Unequip ${label}`} onClick={() => onUnequip(kind, id)} className="h-6 px-2 rounded-md border border-line text-[11.5px] text-fg-dim hover:text-fg">Unequip</button>
        </>
      ) : (
        <button type="button" data-testid="armory-equip" aria-label={`Equip ${label}`} onClick={() => onEquip(kind, id)} className="h-6 px-2 rounded-md border border-line bg-bg-hi text-[11.5px] font-medium text-fg hover:border-rule">Equip</button>
      )}
    </div>
  )

  const shows = (k: ArmoryKind) => tab === 'all' || tab === k
  const builtins = shows('builtin') ? (armory?.builtins ?? []).filter((b) => hit(b.id, b.label)) : []
  const servers = shows('mcp') ? (armory?.mcpServers ?? []).filter((s) => hit(s.id, s.label)) : []
  const packs = shows('pack') ? (armory?.packs ?? []).filter((p) => hit(p.id, p.label, ...p.skills)) : []
  const bundled = tab === 'all' || tab === 'builtin' ? (armory?.bundledSkills ?? []).filter((b) => hit(b.id, b.label)) : []
  const unpacked = tab === 'all' || tab === 'pack' ? (armory?.unpackedSkills ?? []).filter((s) => hit(s)) : []
  const count = (k: KindTab) => k === 'all' ? (armory ? armory.builtins.length + armory.mcpServers.length + armory.packs.length : 0)
    : k === 'builtin' ? armory?.builtins.length ?? 0 : k === 'mcp' ? armory?.mcpServers.length ?? 0 : armory?.packs.length ?? 0

  return (
    <aside
      data-testid="agent-armory"
      role="complementary"
      aria-label="Armory"
      className={`fixed top-0 right-0 bottom-0 w-[340px] ${Z.dialog} flex flex-col bg-bg-elev border-l border-line shadow-xl`}
    >
      <div className="px-5 pt-4 pb-2 flex items-start gap-2">
        <div className="flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-faint">Installed on this machine</div>
          <div className="font-serif text-[24px] text-fg leading-tight">Armory <span className="font-sans text-[12px] text-fg-dim">Drag onto the sheet, or press Equip.</span></div>
        </div>
        <button type="button" aria-label="Close armory" data-testid="armory-close" onClick={onClose} className="px-2 text-fg-faint hover:text-fg">×</button>
      </div>
      <div className="px-5 pb-3">
        <input
          ref={searchRef}
          type="search"
          data-testid="armory-search"
          aria-label="Search the armory"
          placeholder="Search tools, servers, packs…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full h-9 px-3 rounded-[10px] border border-line bg-bg text-[13px] text-fg"
        />
      </div>
      <div role="tablist" aria-label="Armory kinds" className="px-5 pb-2 flex flex-wrap items-center gap-1">
        {KIND_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} data-testid="armory-tab" data-tab={t.id} onClick={() => setTab(t.id)}
            className={`h-6 px-2 rounded-md text-[11.5px] ${tab === t.id ? 'bg-bg-hi border border-line font-semibold text-fg' : 'text-fg-dim hover:text-fg'}`}>
            {t.label} <span className="text-fg-faint">{count(t.id)}</span>
          </button>
        ))}
        <span data-testid="armory-tab-companions" className="px-2 text-[11.5px] text-fg-faint">Companions · later</span>
      </div>
      <div className="flex-1 overflow-y-auto px-5">
        {builtins.length > 0 && (
          <Group title="Built-in tools" sub="class abilities">
            {builtins.map((b) => (
              <Fragment key={b.id}>{renderItem({ kind: 'builtin', id: b.id, label: b.label, badges: b.badges, locked: b.badges.includes('floor'), on: equipped.allBuiltins || equipped.builtins.includes(b.id) })}</Fragment>
            ))}
          </Group>
        )}
        {bundled.length > 0 && (
          <Group title="Skills bundled with the CLI">
            <div data-testid="armory-bundled" className="flex flex-wrap gap-1.5">
              {bundled.map((b) => (
                <span key={b.id} data-bundled={b.id} title="Bundled with the CLI — not equippable" className="px-2 py-0.5 rounded-md text-[12px] font-mono border border-line bg-bg text-fg-dim"><span aria-hidden="true" className="text-fg-faint mr-1">⋮⋮</span>{b.label}</span>
              ))}
            </div>
          </Group>
        )}
        {servers.length > 0 && (
          <Group title="MCP servers" sub="magic items">
            {servers.map((s) => (
              <Fragment key={s.id}>{renderItem({ kind: 'mcp', id: s.id, label: s.label, badges: s.badges, on: equipped.servers.includes(s.id), meta: <><span data-testid="armory-status-dot" className={`inline-block w-1.5 h-1.5 rounded-full ${DOT[s.status] ?? DOT['not-checked']}`} />{s.status === 'checked' ? 'connected' : s.status === 'failing' ? 'failing' : 'not checked'} · {s.tools.length} powers{s.status === 'not-checked' && <> · <button type="button" data-testid="armory-check-now" onClick={() => useLayout.getState().openPanel('claude-config', 'mcp')} className="underline text-accent-dark">Check now</button></>}</> })}</Fragment>
            ))}
          </Group>
        )}
        {packs.length > 0 && (
          <Group title="Packs" sub="spellbooks">
            {packs.map((p) => (
              <Fragment key={p.id}>{renderItem({ kind: 'pack', id: p.id, label: p.label, badges: p.badges, on: equipped.packs.includes(p.id), meta: <>{p.source ? `${p.source} · ` : ''}{p.skills.length} skills</> })}</Fragment>
            ))}
          </Group>
        )}
        {unpacked.length > 0 && (
          <Group title="Unpacked skills · not equippable">
            <div data-testid="armory-unpacked" className="rounded-[10px] border border-dashed border-rule px-2.5 py-1.5 text-[12px] text-fg-dim">
              <span className="font-mono">{unpacked.join(' · ')}</span> — skills travel only inside packs
            </div>
          </Group>
        )}
        {!builtins.length && !servers.length && !packs.length && !unpacked.length && !bundled.length && (
          <div data-testid="armory-empty" className="text-[12px] text-fg-faint py-4">{armory ? 'Nothing matches.' : 'Loading the armory…'}</div>
        )}
      </div>
      <div className="px-5 py-2 border-t border-line text-[11px] text-fg-faint">Tab to move · Enter equips the focused item · Esc closes</div>
    </aside>
  )
}
