import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { liteExtract, canonicalize } = require('../../src/main/lib/kgLite.cjs') as {
  liteExtract: (
    prompts: Array<{ prompt: string; ts?: string }>,
    knownVocab: Array<{ key: string; name: string; type?: string }>
  ) => {
    entities: Array<{ key: string; name: string; type: string; description: string }>
    relations: Array<{ src: string; dst: string; relation: string; description: string }>
  }
  canonicalize: (name: string) => string
}

describe('liteExtract', () => {
  it('returns empty output for empty prompts', () => {
    const { entities, relations } = liteExtract([], [])
    expect(entities).toHaveLength(0)
    expect(relations).toHaveLength(0)
  })

  it('is deterministic — same input produces identical output', () => {
    const prompts = [
      { prompt: 'Add a purge button to the Knowledge Graph tab in Session Manager', ts: '2026-01-01T00:00:00Z' },
      { prompt: 'Fix the Scheduler to handle rate limits properly', ts: '2026-01-01T00:01:00Z' },
    ]
    const r1 = liteExtract(prompts, [])
    const r2 = liteExtract(prompts, [])
    expect(r1).toEqual(r2)
  })

  it('extracts multi-word capitalized phrases as entities', () => {
    const prompts = [
      { prompt: 'Add a purge button to the Knowledge Graph tab in Session Manager', ts: '2026-01-01T00:00:00Z' },
    ]
    const { entities } = liteExtract(prompts, [])
    const keys = entities.map((e) => e.key)
    expect(keys).toContain('knowledge graph')
    expect(keys).toContain('session manager')
  })

  it('collapses "The Scheduler" and "Scheduler" to a single entity via dedup key', () => {
    const prompts = [
      { prompt: 'The Scheduler should process jobs from the queue', ts: '2026-01-01T00:00:00Z' },
      { prompt: 'Scheduler is the core orchestrator for PRDs', ts: '2026-01-01T00:01:00Z' },
    ]
    const { entities } = liteExtract(prompts, [])
    const schedulerNodes = entities.filter((e) => e.key === 'scheduler')
    expect(schedulerNodes).toHaveLength(1)
  })

  it('emits no duplicate nodes regardless of how many prompts mention the same entity', () => {
    const prompts = [
      { prompt: 'The Scheduler queues PRDs and the Scheduler processes them', ts: '2026-01-01T00:00:00Z' },
      { prompt: 'Scheduler runs every 10 minutes', ts: '2026-01-01T00:01:00Z' },
    ]
    const { entities } = liteExtract(prompts, [])
    const keys = entities.map((e) => e.key)
    const unique = [...new Set(keys)]
    expect(keys).toEqual(unique)
  })

  it('emits co-occurrence edges for entities appearing in the same prompt', () => {
    const prompts = [
      { prompt: 'The Knowledge Graph tab shows entities from the Scheduler', ts: '2026-01-01T00:00:00Z' },
    ]
    const { relations } = liteExtract(prompts, [])
    expect(relations.length).toBeGreaterThan(0)
    expect(relations[0].relation).toBe('related_to')
  })

  it('produces no dangling edge references — every edge src/dst is a known entity key', () => {
    const prompts = [
      { prompt: 'The Session Manager uses the Scheduler to run PRDs for the Knowledge Graph', ts: '2026-01-01T00:00:00Z' },
      { prompt: 'Add liteExtract heuristic to KnowledgeGraph tab', ts: '2026-01-01T00:01:00Z' },
    ]
    const { entities, relations } = liteExtract(prompts, [])
    const keySet = new Set(entities.map((e) => e.key))
    for (const rel of relations) {
      expect(keySet).toContain(rel.src)
      expect(keySet).toContain(rel.dst)
      expect(rel.src).not.toBe(rel.dst)
    }
  })

  it('inherits type from knownVocab when entity key matches', () => {
    const knownVocab = [{ key: 'scheduler', name: 'Scheduler', type: 'feature' }]
    const prompts = [
      { prompt: 'Fix the Scheduler to handle rate limits', ts: '2026-01-01T00:00:00Z' },
    ]
    const { entities } = liteExtract(prompts, knownVocab)
    const sched = entities.find((e) => e.key === 'scheduler')
    expect(sched).toBeDefined()
    expect(sched!.type).toBe('feature')
  })

  it('extracts quoted (backtick) identifiers as entities', () => {
    const prompts = [
      { prompt: 'Update `scheduler.cjs` to call `liteExtract` on each batch', ts: '2026-01-01T00:00:00Z' },
    ]
    const { entities } = liteExtract(prompts, [])
    const keys = entities.map((e) => e.key)
    expect(keys).toContain('scheduler.cjs')
    expect(keys).toContain('liteextract')
  })

  it('extracts CamelCase identifiers as entities', () => {
    const prompts = [
      { prompt: 'Refactor KnowledgeGraph component to use SchedulerDock', ts: '2026-01-01T00:00:00Z' },
    ]
    const { entities } = liteExtract(prompts, [])
    const keys = entities.map((e) => e.key)
    expect(keys).toContain('knowledgegraph')
    expect(keys).toContain('schedulerdock')
  })

  it('dedup key strips leading article — "the scheduler" collapses with "scheduler"', () => {
    expect(canonicalize('the Scheduler')).toBe('scheduler')
    expect(canonicalize('Scheduler')).toBe('scheduler')
    expect(canonicalize('a Knowledge Graph')).toBe('knowledge graph')
  })

  it('entities have valid shape matching the kg node contract', () => {
    const prompts = [
      { prompt: 'Build the Knowledge Graph feature for Session Manager', ts: '2026-01-01T00:00:00Z' },
    ]
    const { entities } = liteExtract(prompts, [])
    for (const e of entities) {
      expect(typeof e.key).toBe('string')
      expect(typeof e.name).toBe('string')
      expect(typeof e.type).toBe('string')
      expect(typeof e.description).toBe('string')
      expect(e.key.length).toBeGreaterThan(0)
    }
  })

  it('relations have valid shape matching the kg edge contract', () => {
    const prompts = [
      { prompt: 'The Scheduler processes Knowledge Graph PRDs', ts: '2026-01-01T00:00:00Z' },
    ]
    const { relations } = liteExtract(prompts, [])
    for (const r of relations) {
      expect(typeof r.src).toBe('string')
      expect(typeof r.dst).toBe('string')
      expect(typeof r.relation).toBe('string')
      expect(r.src.length).toBeGreaterThan(0)
      expect(r.dst.length).toBeGreaterThan(0)
    }
  })

  it('does not extract garbage from mismatched quote delimiters (contraction next to backtick)', () => {
    // Backreference fix: "`scheduler.cjs` isn't done" — apostrophe in "isn't" must
    // NOT close the backtick span, so no garbage "scheduler.cjs isn" entity appears.
    const prompts = [{ prompt: "Update `scheduler.cjs` isn't finished yet", ts: '2026-01-01T00:00:00Z' }]
    const { entities } = liteExtract(prompts, [])
    const keys = entities.map((e) => e.key)
    expect(keys).toContain('scheduler.cjs')
    const garbage = keys.filter((k) => k.includes("isn"))
    expect(garbage).toHaveLength(0)
  })
})
