import { describe, it, expect } from 'vitest'
import { queueConstraintLabel } from './queueConstraintLabel'
import type { ScheduleLastTick } from '../../../preload/api'

const tick = (o: Partial<ScheduleLastTick>): ScheduleLastTick => ({
  fired: false,
  reason: 'drained',
  at: '2026-11-01T00:00:00Z',
  ...o,
})

describe('queueConstraintLabel', () => {
  it('null for null/undefined, fired, or no pending', () => {
    expect(queueConstraintLabel(null, 3, 5)).toBeNull()
    expect(queueConstraintLabel(undefined, 3, 5)).toBeNull()
    expect(queueConstraintLabel(tick({ reason: 'paused', fired: true }), 3, 5)).toBeNull()
    expect(queueConstraintLabel(tick({ reason: 'paused' }), 0, 5)).toBeNull()
  })
  it('memory-deferred', () => {
    expect(
      queueConstraintLabel(tick({ reason: 'memory-deferred', availableMb: 100, threshold: 2500 }), 2, 5),
    ).toBe('memory gate: 100 MB free, need 2500 MB')
  })
  it('load-deferred uses detail, with fallback', () => {
    expect(queueConstraintLabel(tick({ reason: 'load-deferred', detail: 'load 9 > 8' }), 2, 5)).toBe('load 9 > 8')
    expect(queueConstraintLabel(tick({ reason: 'load-deferred' }), 2, 5)).toBe('CPU load gate holding')
  })
  it('slots-exhausted', () => {
    expect(queueConstraintLabel(tick({ reason: 'slots-exhausted', deferredCount: 4 }), 2, 5)).toBe('all 5 slots busy — 4 pending')
    expect(queueConstraintLabel(tick({ reason: 'slots-exhausted' }), 2, 5)).toBe('all 5 slots busy — 2 pending')
  })
  it('held', () => {
    const holds = [{}] as unknown as ScheduleLastTick['holds']
    expect(queueConstraintLabel(tick({ reason: 'held', holds }), 2, 5)).toBe('1 pending held behind dependencies')
    expect(queueConstraintLabel(tick({ reason: 'held', detail: 'why' }), 2, 5)).toBe('why')
    expect(queueConstraintLabel(tick({ reason: 'held' }), 2, 5)).toBe('held')
  })
  it('paused and unknown', () => {
    expect(queueConstraintLabel(tick({ reason: 'paused' }), 2, 5)).toBe('scheduler paused')
    expect(queueConstraintLabel(tick({ reason: 'drained' }), 2, 5)).toBeNull()
  })
})
