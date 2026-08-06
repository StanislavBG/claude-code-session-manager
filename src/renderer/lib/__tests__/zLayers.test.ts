import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { Z, Z_VALUE, type ZLayer } from '../zLayers'

const RENDERER = path.resolve(__dirname, '..', '..')
const SELF = path.resolve(__filename)
const LADDER = path.join(RENDERER, 'lib', 'zLayers.ts')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full)
  }
  return out
}

describe('zLayers ladder', () => {
  it('class strings and numeric values agree', () => {
    for (const key of Object.keys(Z) as ZLayer[]) {
      const n = Number(/z-(?:\[(\d+)\]|(\d+))/.exec(Z[key])!.slice(1).find(Boolean))
      expect(n).toBe(Z_VALUE[key])
    }
  })

  it('CORE: the privacy banner is the topmost rung — nothing may paint over it', () => {
    const others = (Object.keys(Z_VALUE) as ZLayer[]).filter((k) => k !== 'recording')
    for (const k of others) expect(Z_VALUE.recording).toBeGreaterThan(Z_VALUE[k])
  })

  it('CORE: toasts clear every surface that can raise one', () => {
    for (const k of ['dialog', 'tour', 'contextMenu', 'contextMenuDialog'] as ZLayer[]) {
      expect(Z_VALUE.toast).toBeGreaterThan(Z_VALUE[k])
    }
    // …and still sits under the privacy banner.
    expect(Z_VALUE.toast).toBeLessThan(Z_VALUE.recording)
  })

  it('a context menu clears dialogs; a dialog it opens clears the menu; the scrim sits just under it', () => {
    expect(Z_VALUE.contextMenu).toBeGreaterThan(Z_VALUE.dialog)
    expect(Z_VALUE.contextMenu).toBeGreaterThan(Z_VALUE.tour)
    expect(Z_VALUE.contextMenuDialog).toBeGreaterThan(Z_VALUE.contextMenu)
    expect(Z_VALUE.contextMenuScrim).toBeLessThan(Z_VALUE.contextMenu)
    expect(Z_VALUE.contextMenuScrim).toBeGreaterThan(Z_VALUE.dialog)
  })

  it('every rung is distinct', () => {
    const values = Object.values(Z_VALUE)
    expect(new Set(values).size).toBe(values.length)
  })

  /**
   * The drift guard. The four disconnected z-index islands this module
   * replaced were each invented locally and silently broke two documented
   * invariants. Any NEW global-overlay z-index must go through the ladder,
   * not a fresh literal. (Historical values are described in prose, not
   * bracket syntax — see the note in zLayers.ts about Tailwind scanning.)
   *
   * Local, in-pane values (z-10/z-20/z-30/z-40) are deliberately allowed:
   * they are relative to their own stacking context and never race with the
   * global overlays.
   */
  it('no raw z-index above the local range outside lib/zLayers.ts', () => {
    const offenders: string[] = []
    for (const file of walk(RENDERER)) {
      if (file === SELF || file === LADDER) continue
      const src = fs.readFileSync(file, 'utf8')
      src.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/z-\[(\d+)\]|(?:^|[\s"'`])z-(\d+)(?![\d[])/g)) {
          const n = Number(m[1] ?? m[2])
          if (n > 40) offenders.push(`${path.relative(RENDERER, file)}:${i + 1}  z-index ${n}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
