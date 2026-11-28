import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_DRAWN_PER_TYPE,
  createSpriteCache,
  drawWorld,
  groupLabel,
  layoutGroups,
  layoutRoomActors,
  layoutRooms,
  layoutWorld,
  spriteSpec,
} from '../worldScene'

type Call = { name: string; args: unknown[] }

function mockCtx(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = []
  const target: Record<string, unknown> = {}
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop]
      return (...args: unknown[]) => {
        calls.push({ name: prop, args })
      }
    },
    set(t, prop: string, v) {
      t[prop] = v
      return true
    },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, calls }
}

class FakeOffscreen {
  width: number
  height: number
  constructor(w: number, h: number) {
    this.width = w
    this.height = h
  }
  getContext() {
    return mockCtx().ctx
  }
}

beforeEach(() => {
  vi.stubGlobal('OffscreenCanvas', FakeOffscreen)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const roster = [
  { agentType: 'architect', count: 3 },
  { agentType: 'dev-lead', count: 30 },
  { agentType: 'validator', count: 1 },
]

describe('layoutWorld', () => {
  it('is deterministic', () => {
    expect(layoutWorld(roster, 600, 400)).toEqual(layoutWorld(roster, 600, 400))
  })

  it('keeps actors in bounds and caps copies per type', () => {
    const actors = layoutWorld(roster, 600, 400)
    expect(actors.filter((a) => a.agentType === 'architect')).toHaveLength(3)
    expect(actors.filter((a) => a.agentType === 'dev-lead')).toHaveLength(MAX_DRAWN_PER_TYPE)
    expect(actors).toHaveLength(3 + MAX_DRAWN_PER_TYPE + 1)
    for (const a of actors) {
      expect(a.x).toBeGreaterThanOrEqual(0)
      expect(a.x).toBeLessThanOrEqual(600)
      expect(a.y).toBeGreaterThanOrEqual(0)
      expect(a.y).toBeLessThanOrEqual(400)
    }
  })

  it('gives each group its own non-overlapping camp', () => {
    const groups = layoutGroups(roster, 600, 400)
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i]
        const b = groups[j]
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(overlap).toBe(false)
      }
    }
    const actors = layoutWorld(roster, 600, 400)
    for (const g of groups) {
      for (const a of actors.filter((x) => x.agentType === g.agentType)) {
        expect(a.x).toBeGreaterThanOrEqual(g.x)
        expect(a.x).toBeLessThanOrEqual(g.x + g.w)
        expect(a.y).toBeGreaterThanOrEqual(g.y)
        expect(a.y).toBeLessThanOrEqual(g.y + g.h)
      }
    }
  })

  it('keeps every group, label and actor below insetTop for 1..n groups', () => {
    const types = ['a', 'b', 'c', 'd', 'e', 'f']
    for (let n = 1; n <= types.length; n++) {
      const r = types.slice(0, n).map((agentType, i) => ({ agentType, count: i + 2 }))
      const groups = layoutGroups(r, 600, 400, 60)
      expect(groups).toHaveLength(n)
      for (const g of groups) {
        expect(g.y).toBeGreaterThanOrEqual(60)
        expect(g.y + g.h).toBeLessThanOrEqual(400 + 1e-6)
      }
      const actors = layoutWorld(r, 600, 400, 60)
      for (const a of actors) {
        expect(a.y).toBeGreaterThanOrEqual(60 + 16)
        expect(a.y).toBeLessThanOrEqual(400)
      }
      expect(layoutWorld(r, 600, 400, 60)).toEqual(actors)
    }
  })

  it('insetTop defaults to 0', () => {
    expect(layoutWorld(roster, 600, 400, 0)).toEqual(layoutWorld(roster, 600, 400))
  })

  it('stays in bounds even in a tiny world', () => {
    for (const a of layoutWorld(roster, 30, 20)) {
      expect(a.x).toBeGreaterThanOrEqual(0)
      expect(a.x).toBeLessThanOrEqual(30)
      expect(a.y).toBeGreaterThanOrEqual(0)
      expect(a.y).toBeLessThanOrEqual(20)
    }
  })
})

describe('spriteSpec', () => {
  it('is stable and unique per name', () => {
    expect(spriteSpec('architect')).toEqual(spriteSpec('architect'))
    expect(spriteSpec('architect')).not.toEqual(spriteSpec('dev-lead'))
    expect(spriteSpec('architect').pattern).toHaveLength(8)
  })
  it('gives unknown a neutral grey', () => {
    expect(spriteSpec('unknown').palette.body).toMatch(/^hsl\(0, 0%/)
  })
})

describe('sprite cache', () => {
  it('returns the same canvas on a second call', () => {
    const cache = createSpriteCache()
    expect(cache.sprite('architect', 1)).toBe(cache.sprite('architect', 1))
    expect(cache.sprite('architect', 1)).not.toBe(cache.sprite('architect', 2))
    expect(cache.sprite('architect', 1)).not.toBe(cache.sprite('dev-lead', 1))
  })
})

describe('drawWorld', () => {
  const opts = { width: 600, height: 400, timeMs: 1000, dpr: 1 }

  it('draws only the caption on an empty roster', () => {
    const { ctx, calls } = mockCtx()
    drawWorld(ctx, [], [], opts)
    const texts = calls.filter((c) => c.name === 'fillText').map((c) => c.args[0])
    expect(texts).toEqual(['No one is out adventuring'])
    expect(calls.some((c) => c.name === 'drawImage')).toBe(true)
  })

  it('labels each group with the true count', () => {
    const { ctx, calls } = mockCtx()
    const groups = layoutGroups(roster, 600, 400)
    drawWorld(ctx, layoutWorld(roster, 600, 400), groups, opts)
    const texts = calls.filter((c) => c.name === 'fillText').map((c) => c.args[0])
    expect(texts).toContain('dev-lead ×30')
    expect(texts).toContain(groupLabel('architect', 3))
    expect(texts).toHaveLength(3)
  })
})

const mkRooms = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    key: `p${i}`,
    label: `Proj${i}`,
    roster: i % 3 === 0 ? [] : [{ agentType: 'architect', count: 1 }, { agentType: 'dev-lead', count: i * 4 }],
  }))

describe('layoutRooms', () => {
  it('handles 0 rooms and zero size', () => {
    expect(layoutRooms([], 600, 400)).toEqual([])
    expect(() => layoutRoomActors(layoutRooms(mkRooms(3), 0, 0), mkRooms(3))).not.toThrow()
  })
  it('1 room fills the area', () => {
    const [r] = layoutRooms(mkRooms(1), 600, 400, 40)
    expect(r.w).toBeGreaterThan(580)
    expect(r.y).toBeGreaterThanOrEqual(40)
    expect(r.h).toBeGreaterThan(340)
  })
  it.each([1, 8, 12])('%i rooms tile without overlap, below the inset, with contained actors', (n) => {
    const input = mkRooms(n)
    const rooms = layoutRooms(input, 1592, 1040, 50)
    expect(rooms).toHaveLength(n)
    for (let i = 0; i < n; i++) {
      const a = rooms[i]
      expect(a.w).toBeGreaterThan(0)
      expect(a.h).toBeGreaterThan(0)
      expect(a.y).toBeGreaterThanOrEqual(50)
      expect(a.y + a.h).toBeLessThanOrEqual(1040)
      expect(a.agents).toBe(input[i].roster.reduce((s, e) => s + e.count, 0))
      for (let j = i + 1; j < n; j++) {
        const b = rooms[j]
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false)
      }
    }
    const actors = layoutRoomActors(rooms, input)
    const expected = input.reduce((s, r) => s + r.roster.reduce((t, e) => t + Math.min(e.count, MAX_DRAWN_PER_TYPE), 0), 0)
    expect(actors).toHaveLength(expected)
  })
  it('keeps actors inside tiny rooms', () => {
    const input = mkRooms(12)
    const rooms = layoutRooms(input, 60, 40)
    const actors = layoutRoomActors(rooms, input)
    // every actor lies in some room rect
    for (const a of actors) {
      expect(rooms.some((r) => a.x >= r.x && a.x <= r.x + r.w && a.y >= r.y && a.y <= r.y + r.h)).toBe(true)
    }
  })
})

describe('drawWorld with rooms', () => {
  it('paints the ground and the caption when rooms is empty', () => {
    const { ctx, calls } = mockCtx()
    drawWorld(ctx, [], [], { width: 600, height: 400, timeMs: 0, dpr: 1 }, [], [])
    const caption = calls.filter((c) => c.name === 'fillText')
    expect(caption.map((c) => c.args[0])).toEqual(['No one is out adventuring'])
    expect(caption[0].args.slice(1)).toEqual([300, 200])
    expect(calls.some((c) => c.name === 'drawImage')).toBe(true)
  })
  it('strokes boundaries and labels rooms, idle and groups', () => {
    const { ctx, calls } = mockCtx()
    const input = [
      { key: 'b', label: 'Bilko', roster: [{ agentType: 'architect', count: 2 }] },
      { key: 's', label: 'Self', roster: [] },
    ]
    const rooms = layoutRooms(input, 600, 400)
    drawWorld(ctx, layoutRoomActors(rooms, input), [], { width: 600, height: 400, timeMs: 0, dpr: 1 }, rooms, input)
    const texts = calls.filter((c) => c.name === 'fillText').map((c) => c.args[0])
    expect(texts).toContain('Bilko · 2')
    expect(texts).toContain('Self · 0')
    expect(texts).toContain('idle')
    expect(texts).toContain(groupLabel('architect', 2))
    expect(calls.filter((c) => c.name === 'roundRect')).toHaveLength(2)
    expect(calls.filter((c) => c.name === 'stroke')).toHaveLength(2)
  })
})
