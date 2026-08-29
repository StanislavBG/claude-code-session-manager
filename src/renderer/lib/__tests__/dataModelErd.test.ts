import { describe, expect, it } from 'vitest'
import {
  ERD_ENTITIES,
  ERD_GROUPS,
  ERD_RELATIONS,
  ERD_BOX_WIDTH,
  cardinalityGlyph,
  layoutErd,
  neighborsOf,
} from '../dataModelErd'
import type { ErdCardinality } from '../dataModelErd'

describe('dataModelErd', () => {
  it('has unique entity ids', () => {
    const ids = ERD_ENTITIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('resolves every fk field ref to a real entity id', () => {
    const ids = new Set(ERD_ENTITIES.map((e) => e.id))
    for (const entity of ERD_ENTITIES) {
      for (const field of entity.fields) {
        if (field.key !== 'fk') continue
        expect(field.ref, `${entity.id}.${field.name} is marked fk but has no ref`).toBeTruthy()
        const match = /^([^.]+)\.(.+)$/.exec(field.ref as string)
        expect(match, `${entity.id}.${field.name}.ref "${field.ref}" is not of the form <entityId>.<field>`).toBeTruthy()
        const [, refEntityId] = match!
        expect(ids.has(refEntityId), `${entity.id}.${field.name} refs unknown entity "${refEntityId}"`).toBe(true)
      }
    }
  })

  it('resolves every relation endpoint to a real entity id', () => {
    const ids = new Set(ERD_ENTITIES.map((e) => e.id))
    for (const relation of ERD_RELATIONS) {
      expect(ids.has(relation.from), `relation.from "${relation.from}" is unknown`).toBe(true)
      expect(ids.has(relation.to), `relation.to "${relation.to}" is unknown`).toBe(true)
    }
  })

  it('has at least 40 relations', () => {
    expect(ERD_RELATIONS.length).toBeGreaterThanOrEqual(40)
  })

  it('assigns every entity to a known group', () => {
    const groupIds = new Set(ERD_GROUPS.map((g) => g.id))
    for (const entity of ERD_ENTITIES) {
      expect(groupIds.has(entity.group), `entity "${entity.id}" has unknown group "${entity.group}"`).toBe(true)
    }
  })

  it('has exactly 8 groups in the documented order', () => {
    expect(ERD_GROUPS.map((g) => g.id)).toEqual([
      'project',
      'epic',
      'scheduler',
      'agents',
      'memory',
      'transcript',
      'brief',
      'config',
    ])
  })

  // The PRD's prose says "26 entities" but its own enumerated id list (project
  // through opsNamespace) contains 27 distinct ids — this asserts against
  // that authoritative list, not the miscounted prose number.
  it('has exactly the 27 entities enumerated in the PRD', () => {
    expect(ERD_ENTITIES.map((e) => e.id).sort()).toEqual(
      [
        'project', 'tab', 'epic', 'epicEvent', 'epicTranscriptTurn', 'epicArchive',
        'prd', 'scheduleJob', 'scheduleJobStatusHistory', 'scheduleHistoryEntry',
        'scheduleConfig', 'runLog', 'agentPersona', 'tag', 'memoryEntry',
        'memoryCluster', 'agentMemoryEntry', 'claudeTranscript', 'transcriptEvent',
        'historyRollupDay', 'billingUsage', 'projectBrief', 'projectPages',
        'bilkoPublishState', 'settingsScope', 'layoutEnvelope', 'opsNamespace',
      ].sort(),
    )
  })

  it('gives every entity a non-empty fields array', () => {
    for (const entity of ERD_ENTITIES) {
      expect(entity.fields.length, `entity "${entity.id}" has no fields`).toBeGreaterThan(0)
    }
  })

  it('marks every project-realm namespaced entity with the correct OWNERS writer', () => {
    const expectedByPathFragment: Array<[string, string]> = [
      ['prompt-sessions', 'epics'],
      ['scheduler/', 'scheduler'],
      ['project-brief', 'project-home'],
      ['bilko-host', 'bilko-host'],
    ]
    for (const entity of ERD_ENTITIES) {
      if (!entity.store.path.includes('session-manager-operations/')) continue
      if (entity.store.path.includes('project-pages')) {
        expect(entity.store.writer, `${entity.id} is in a deliberately-unowned namespace and must omit writer`).toBeUndefined()
        continue
      }
      const hit = expectedByPathFragment.find(([fragment]) => entity.store.path.includes(fragment))
      if (!hit) continue
      expect(entity.store.writer, `${entity.id} should carry writer "${hit[1]}"`).toBe(hit[1])
    }
  })

  describe('layoutErd', () => {
    const layout = layoutErd()

    it('is deterministic across calls', () => {
      const again = layoutErd()
      expect(again).toEqual(layout)
    })

    it('produces exactly one box per entity', () => {
      expect(layout.boxes.length).toBe(ERD_ENTITIES.length)
      const boxIds = new Set(layout.boxes.map((b) => b.id))
      for (const entity of ERD_ENTITIES) {
        expect(boxIds.has(entity.id)).toBe(true)
      }
    })

    it('never overlaps two boxes within the same column', () => {
      const byColumn = new Map<number, typeof layout.boxes>()
      for (const box of layout.boxes) {
        const list = byColumn.get(box.x) ?? []
        list.push(box)
        byColumn.set(box.x, list)
      }
      for (const boxes of byColumn.values()) {
        const sorted = [...boxes].sort((a, b) => a.y - b.y)
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i].y).toBeGreaterThanOrEqual(sorted[i - 1].y + sorted[i - 1].h)
        }
      }
    })

    it('bounds every box within width/height', () => {
      for (const box of layout.boxes) {
        expect(box.x + box.w).toBeLessThanOrEqual(layout.width)
        expect(box.y + box.h).toBeLessThanOrEqual(layout.height)
        expect(box.w).toBe(ERD_BOX_WIDTH)
        expect(box.h).toBeGreaterThan(0)
      }
    })

    it('emits one edge per relation whose endpoints are present, with a loop for self-edges', () => {
      expect(layout.edges.length).toBe(ERD_RELATIONS.length)
      for (const edge of layout.edges) {
        expect(edge.d.startsWith('M ')).toBe(true)
        expect(typeof edge.mx).toBe('number')
        expect(typeof edge.my).toBe('number')
        if (edge.relation.from === edge.relation.to) {
          // Loop path must not collapse to a zero-length segment.
          expect(edge.d).not.toMatch(/M (\S+) (\S+) C \1 \2, \1 \2, \1 \2/)
        }
      }
    })

    it('skips relations whose endpoints are missing from a filtered entity set', () => {
      const filtered = ERD_ENTITIES.filter((e) => e.group === 'project')
      const filteredLayout = layoutErd(filtered, ERD_RELATIONS)
      expect(filteredLayout.boxes.length).toBe(filtered.length)
      const filteredIds = new Set(filtered.map((e) => e.id))
      for (const edge of filteredLayout.edges) {
        expect(filteredIds.has(edge.relation.from)).toBe(true)
        expect(filteredIds.has(edge.relation.to)).toBe(true)
      }
    })
  })

  describe('neighborsOf', () => {
    it('excludes the entity itself and dedupes', () => {
      for (const entity of ERD_ENTITIES) {
        const neighbors = neighborsOf(entity.id)
        expect(neighbors).not.toContain(entity.id)
        expect(new Set(neighbors).size).toBe(neighbors.length)
      }
    })

    it('finds at least one neighbor for a well-connected entity', () => {
      expect(neighborsOf('epic').length).toBeGreaterThan(0)
    })
  })

  describe('cardinalityGlyph', () => {
    it('returns a non-empty string for all four cardinalities', () => {
      const cardinalities: ErdCardinality[] = ['1-1', '1-N', 'N-1', 'N-N']
      for (const c of cardinalities) {
        expect(cardinalityGlyph(c).length).toBeGreaterThan(0)
      }
    })
  })
})
