import { useEffect, useState } from 'react'
import type { Armory } from '../../../../preload/api'
import { ArmoryDrawer, type ArmoryKind } from './ArmoryDrawer'
import type { Draft } from './AgentDetail'

/**
 * First-run choice for an Undecided agent (frame 1g): Bare (floor only), Pick gear (opens the Armory
 * with an empty Equipped loadout) or Unbound (every tool). Choices only edit the draft — the sheet's
 * normal save bar persists them. Disappears once the draft is decided (or "Not now").
 * Draft encodings: Unbound = tools ['*']; Bare = tools [] + loadout 'bare'; Equipped = the picked tools.
 */

const MCP = (id: string) => `mcp__${id}__`

/** True once the draft carries a decision (a choice made here, or tools edited away from the saved ones). */
export function isDecided(obj: Draft, savedTools: readonly string[]): boolean {
  return !!obj.loadout || JSON.stringify(obj.tools) !== JSON.stringify(savedTools)
}

export function LoadoutFirstRun({ obj, savedTools, set }: { obj: Draft; savedTools: readonly string[]; set: (patch: Partial<Draft>) => void }) {
  const [picking, setPicking] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [armory, setArmory] = useState<Armory | null>(null)
  useEffect(() => {
    if (!picking) return
    let live = true
    Promise.resolve(window.api.agents.armory?.({})).then((a) => { if (live && a) setArmory(a) }).catch(() => {})
    return () => { live = false }
  }, [picking])

  if (dismissed || (isDecided(obj, savedTools) && !picking)) return null

  const equipped = {
    allBuiltins: false,
    builtins: obj.tools,
    servers: [...new Set([...(obj.mcpServers ?? []), ...obj.tools.map((t) => /^mcp__(.+?)__/.exec(t)?.[1]).filter((x): x is string => !!x)])],
    packs: obj.packs ?? [],
  }
  const equip = (kind: ArmoryKind, id: string) => {
    if (kind === 'builtin') { if (!obj.tools.includes(id)) set({ loadout: 'equipped', tools: [...obj.tools, id] }) }
    else if (kind === 'mcp') {
      const s = armory?.mcpServers.find((x) => x.id === id)
      set({ loadout: 'equipped', tools: [...new Set([...obj.tools, ...(s?.tools.map((t) => t.id) ?? [])])], mcpServers: [...new Set([...(obj.mcpServers ?? []), id])] })
    } else set({ loadout: 'equipped', packs: [...new Set([...(obj.packs ?? []), id])] })
  }
  const unequip = (kind: ArmoryKind, id: string) => {
    if (kind === 'builtin') set({ tools: obj.tools.filter((t) => t !== id) })
    else if (kind === 'mcp') set({ tools: obj.tools.filter((t) => !t.startsWith(MCP(id))), mcpServers: (obj.mcpServers ?? []).filter((x) => x !== id) })
    else set({ packs: (obj.packs ?? []).filter((x) => x !== id) })
  }

  const card = 'rounded-[14px] border border-line bg-bg p-4 flex flex-col gap-2 min-w-0'
  const btn = 'mt-auto h-9 rounded-[10px] border border-line bg-bg-hi text-[13px] font-semibold text-fg hover:border-rule'
  return (
    <section data-testid="agent-undecided-choice" className="px-[18px] py-4 rounded-[14px] border border-dashed border-honey bg-honey/10">
      <h2 className="font-serif text-[22px] text-fg">Choose a loadout <span className="text-[13px] italic text-fg-dim">before the adventure starts</span></h2>
      <p className="mt-1 text-[13px] text-fg-dim">
        <span className="font-mono">{obj.name}</span> has no tools decision on record, so today it runs with{' '}
        <strong className="text-fg">every tool on this machine</strong> — in Epic chat, scheduler jobs and Tasks. Pick one; you can change it any time.
      </p>
      <div className="mt-3 grid grid-cols-3 gap-3">
        <div className={card} data-choice="bare">
          <div className="font-semibold text-fg">Bare <span className="font-serif italic font-normal text-fg-dim text-[12px]">empty-handed</span></div>
          <p className="text-[12.5px] text-fg-dim">Nothing equipped — only the floor no agent can drop.</p>
          <button type="button" data-testid="agent-choose-bare" onClick={() => set({ loadout: 'bare', tools: [] })} className={btn}>Go bare</button>
        </div>
        <div className={`${card} border-accent`} data-choice="pick">
          <div className="font-semibold text-fg">Pick gear <span className="font-serif italic font-normal text-fg-dim text-[12px]">outfit the character</span></div>
          <p className="text-[12.5px] text-fg-dim">Equip exactly what {obj.name} needs from the Armory.</p>
          <button type="button" data-testid="agent-choose-pick" onClick={() => setPicking(true)} className={`${btn} bg-accent text-white border-transparent`}>Open the Armory</button>
        </div>
        <div className={card} data-choice="unbound">
          <div className="font-semibold text-fg">Unbound <span className="font-serif italic font-normal text-fg-dim text-[12px]">every relic in the vault</span></div>
          <p className="text-[12.5px] text-fg-dim">Every tool on this machine — MCP servers too, including ones added later. Today's behaviour, chosen on purpose.</p>
          <button type="button" data-testid="agent-choose-unbound" onClick={() => set({ loadout: 'unbound', tools: ['*'] })} className={btn}>Go unbound</button>
        </div>
      </div>
      <p className="mt-3 text-[12px] text-fg-dim">
        <button type="button" data-testid="agent-choose-later" onClick={() => setDismissed(true)} className="underline text-fg">Not now</button>
        {' '}— {obj.name} keeps running with every tool and stays flagged in the roster.
      </p>
      {picking && (
        <ArmoryDrawer
          armory={armory}
          equipped={equipped}
          onEquip={equip}
          onUnequip={unequip}
          onDragStart={() => {}}
          onDragEnd={() => {}}
          onClose={() => setPicking(false)}
        />
      )}
    </section>
  )
}
