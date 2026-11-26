import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_DRAWN_PER_TYPE,
  createSpriteCache,
  drawWorld,
  groupLabel,
  layoutGroups,
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
