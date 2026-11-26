import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Armory, ArmoryItem } from '../../../../preload/api'
import { Z } from '../../../lib/zLayers'

/**
 * The Armory drawer (frame 1e): every equippable item grouped by kind, searchable, with badges.
 * Items drag (HTML5) onto the matching GearPanel row, or are equipped with the Equip button (Enter on
 * the focused button) — drag-and-drop is never the only way. Skills outside a pack are listed, not equippable.
 */

export type ArmoryKind = 'builtin' | 'mcp' | 'pack'

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
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => { searchRef.current?.focus() }, [])
  const needle = q.trim().toLowerCase()
  const hit = (...s: string[]) => !needle || s.some((x) => x.toLowerCase().includes(needle))

  const Item = ({ kind, id, label, badges, meta, on, locked }: { kind: ArmoryKind; id: string; label: string; badges: ArmoryItem['badges']; meta?: ReactNode; on: boolean; locked?: boolean }) => (
    <div
      data-testid="armory-item"
      data-kind={kind}
      data-item={id}
      data-equipped={on ? 'true' : undefined}
      draggable={!on && !locked}
      onDragStart={(e) => {
        e.dataTransfer?.setData('text/plain', `${kind}:${id}`)
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
        onDragStart(kind, id)
      }}
      onDragEnd={onDragEnd}
      className={`rounded-[10px] border px-2.5 py-1.5 flex items-center gap-2 ${on ? 'border-line bg-bg-hi' : 'border-line bg-bg cursor-grab'}`}
    >
      <div className="min-w-0 flex-1">
        <div title={id} className="font-mono text-[12.5px] font-semibold text-fg truncate">{label}<Badges badges={badges} /></div>
        {meta && <div className="text-[11px] text-fg-dim flex items-center gap-1.5">{meta}</div>}
      </div>
      {locked ? (
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

  const builtins = (armory?.builtins ?? []).filter((b) => hit(b.id, b.label))
  const servers = (armory?.mcpServers ?? []).filter((s) => hit(s.id, s.label))
  const packs = (armory?.packs ?? []).filter((p) => hit(p.id, p.label, ...p.skills))
  const unpacked = (armory?.unpackedSkills ?? []).filter((s) => hit(s))

  return (
    <aside
      data-testid="agent-armory"
      role="complementary"
      aria-label="Armory"
      className={`fixed top-0 right-0 bottom-0 w-[400px] ${Z.dialog} flex flex-col bg-bg-elev border-l border-line shadow-xl`}
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
      <div className="flex-1 overflow-y-auto px-5">
        {builtins.length > 0 && (
          <Group title="Built-in tools" sub="class abilities">
            {builtins.map((b) => (
              <Item key={b.id} kind="builtin" id={b.id} label={b.label} badges={b.badges} locked={b.badges.includes('floor')} on={equipped.allBuiltins || equipped.builtins.includes(b.id)} />
            ))}
          </Group>
        )}
        {servers.length > 0 && (
          <Group title="MCP servers" sub="magic items">
            {servers.map((s) => (
              <Item
                key={s.id}
                kind="mcp"
                id={s.id}
                label={s.label}
                badges={s.badges}
                on={equipped.servers.includes(s.id)}
                meta={<><span data-testid="armory-status-dot" className={`inline-block w-1.5 h-1.5 rounded-full ${DOT[s.status] ?? DOT['not-checked']}`} />{s.status === 'checked' ? 'connected' : s.status === 'failing' ? 'failing' : 'not checked'} · {s.tools.length} powers</>}
              />
            ))}
          </Group>
        )}
        {packs.length > 0 && (
          <Group title="Packs" sub="spellbooks">
            {packs.map((p) => (
              <Item key={p.id} kind="pack" id={p.id} label={p.label} badges={p.badges} on={equipped.packs.includes(p.id)} meta={<>{p.source ? `${p.source} · ` : ''}{p.skills.length} skills</>} />
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
        {!builtins.length && !servers.length && !packs.length && !unpacked.length && (
          <div data-testid="armory-empty" className="text-[12px] text-fg-faint py-4">{armory ? 'Nothing matches.' : 'Loading the armory…'}</div>
        )}
      </div>
      <div className="px-5 py-2 border-t border-line text-[11px] text-fg-faint">Tab to move · Enter equips the focused item · Esc closes</div>
    </aside>
  )
}
