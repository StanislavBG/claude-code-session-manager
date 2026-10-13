import { useEffect, useState } from 'react'
import { Z } from '../../../../lib/zLayers'
import { searchRows, sortRows, type MemoryRow } from './model'

interface Props {
  open: boolean
  rows: MemoryRow[]
  clusterDot: (id: string | null) => string
  onPick: (name: string) => void
  onAsk: (q: string) => void
  onClose: () => void
}

export function SearchPalette({ open, rows, clusterDot, onPick, onAsk, onClose }: Props) {
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)

  useEffect(() => {
    if (open) {
      setQ('')
      setHi(0)
    }
  }, [open])

  if (!open) return null

  const results = searchRows(sortRows(rows, 'recent'), q, 6)
  const askIdx = results.length
  const activate = (i: number) => {
    if (i === askIdx) onAsk(q)
    else onPick(results[i].name)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHi((h) => Math.min(h + 1, askIdx))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHi((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(Math.min(hi, askIdx))
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div data-testid="mx-palette">
      <div className={`absolute inset-0 ${Z.dialog} bg-fg/30`} onClick={onClose} />
      <div
        className={`absolute left-1/2 top-[84px] -translate-x-1/2 w-[580px] ${Z.dialog} bg-bg-hi border border-rule-structural rounded-[10px] shadow-lg overflow-hidden`}
      >
        <input
          data-testid="mx-palette-input"
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setHi(0)
          }}
          onKeyDown={onKeyDown}
          placeholder="Search memories or ask a question…"
          className="w-full h-[50px] border-0 border-b border-rule-inner px-[18px] text-[15px] text-fg bg-transparent outline-none"
        />
        <div className="p-[6px] flex flex-col max-h-[380px] overflow-auto">
          {results.map((r, i) => (
            <div
              key={r.name}
              data-testid="mx-palette-row"
              onClick={() => activate(i)}
              onMouseEnter={() => setHi(i)}
              className={`flex items-center gap-[9px] px-3 py-2 rounded-[6px] cursor-pointer ${i === hi ? 'bg-bg-deep' : ''}`}
            >
              <span className={`w-[7px] h-[7px] rounded-[2px] flex-none ${clusterDot(r.clusterId)}`} />
              <span className="font-mono text-[12.5px] text-fg flex-none">{r.slug}</span>
              <span className="text-[12px] text-fg-dim overflow-hidden text-ellipsis whitespace-nowrap">
                {r.description}
              </span>
            </div>
          ))}
          <div
            data-testid="mx-palette-ask"
            onClick={() => activate(askIdx)}
            onMouseEnter={() => setHi(askIdx)}
            className={`flex items-center gap-[9px] px-3 py-[10px] mt-1 border-t border-rule-inner cursor-pointer text-[13px] text-accent ${hi === askIdx ? 'bg-bg-deep' : ''}`}
          >
            <span className="font-mono text-[11px]">↵</span>
            Ask “{q}” …
            <span className="flex-1" />
            <span className="text-[11px] text-fg-dim">opens Ask</span>
          </div>
        </div>
        <div className="px-[14px] py-2 border-t border-rule-inner text-[11px] text-fg-dim flex gap-[14px]">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  )
}
