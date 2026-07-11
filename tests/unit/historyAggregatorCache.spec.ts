import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const { LRUCache, CACHE_MAX } = require('../../src/main/historyAggregator.cjs')

describe('CACHE_MAX', () => {
  it('is raised comfortably above the observed real-workspace file count', () => {
    expect(CACHE_MAX).toBeGreaterThanOrEqual(50_000)
  })
})

describe('LRUCache regression: no self-eviction mid-scan', () => {
  it('retains an early key after inserting 600 distinct keys under CACHE_MAX', () => {
    const cache = new LRUCache(CACHE_MAX)
    for (let i = 0; i < 600; i++) {
      cache.set(String(i), i)
    }
    expect(cache.get('10')).toBe(10)
  })
})

describe('LRUCache eviction semantics', () => {
  it('evicts the oldest key once size exceeds max', () => {
    const cache = new LRUCache(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    cache.set('d', 4)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
    expect(cache.get('d')).toBe(4)
  })
})
