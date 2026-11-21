'use strict'

import { describe, it, expect } from 'vitest'
const { createFrameAssembler, FRAME_LIMITS } = require('../remoteFrameAssembler.cjs')
const { chunkFrames } = require('../remoteIpcDispatch.cjs')

const ID1 = '11111111-2222-4333-8444-555555555555'
const ID2 = '21111111-2222-4333-8444-555555555555'
const ID3 = '31111111-2222-4333-8444-555555555555'

function framesOf(value, bytes = 50) {
  const r = chunkFrames(value, bytes)
  if (!r.ok) throw new Error(r.reason)
  return r.frames
}
const big = { type: 'files.saveBinary', id: 'x', payload: { name: 'a.png', b64: 'Q'.repeat(400) + '"\\\n€' } }

describe('remoteFrameAssembler', () => {
  it('exports FRAME_LIMITS defaults', () => {
    expect(FRAME_LIMITS).toEqual({ maxMessageBytes: 25 * 1024 * 1024, maxInflightPerClient: 2, maxFrames: 200, idleTtlMs: 60000 })
  })

  it('reassembles in order', () => {
    const a = createFrameAssembler()
    const frames = framesOf(big)
    expect(frames.length).toBeGreaterThan(2)
    let last
    frames.forEach((f, i) => {
      last = a.accept('c', { msgId: ID1, ...f })
      if (i < frames.length - 1) expect(last).toEqual({ status: 'partial' })
    })
    expect(last).toEqual({ status: 'complete', envelope: big })
  })

  it('reassembles out of order', () => {
    const a = createFrameAssembler()
    const frames = framesOf(big).reverse()
    const results = frames.map((f) => a.accept('c', { msgId: ID1, ...f }))
    expect(results.slice(0, -1).every((r) => r.status === 'partial')).toBe(true)
    expect(results[results.length - 1]).toEqual({ status: 'complete', envelope: big })
  })

  it('refuses malformed payloads', () => {
    const a = createFrameAssembler()
    const good = { msgId: ID1, seq: 0, total: 2, data: 'x' }
    for (const bad of [
      null,
      'str',
      { ...good, msgId: 'nope' },
      { ...good, msgId: 5 },
      { ...good, seq: -1 },
      { ...good, seq: 2 },
      { ...good, seq: 0.5 },
      { ...good, total: 0 },
      { ...good, total: 201 },
      { ...good, total: '2' },
      { ...good, data: 7 },
    ]) {
      expect(a.accept('c', bad)).toEqual({ status: 'refused', reason: 'malformed' })
    }
  })

  it('refuses duplicate seq and frees the message', () => {
    const a = createFrameAssembler()
    const frames = framesOf(big)
    expect(a.accept('c', { msgId: ID1, ...frames[0] }).status).toBe('partial')
    expect(a.accept('c', { msgId: ID1, ...frames[0] })).toEqual({ status: 'refused', reason: 'duplicate_seq' })
    // freed: frame 0 is accepted fresh again
    expect(a.accept('c', { msgId: ID1, ...frames[0] }).status).toBe('partial')
  })

  it('refuses total mismatch and frees the message', () => {
    const a = createFrameAssembler()
    expect(a.accept('c', { msgId: ID1, seq: 0, total: 3, data: 'a' }).status).toBe('partial')
    expect(a.accept('c', { msgId: ID1, seq: 1, total: 4, data: 'b' })).toEqual({ status: 'refused', reason: 'total_mismatch' })
    expect(a.accept('c', { msgId: ID1, seq: 0, total: 3, data: 'a' }).status).toBe('partial')
  })

  it('refuses a 3rd concurrent msgId per client', () => {
    const a = createFrameAssembler()
    expect(a.accept('c', { msgId: ID1, seq: 0, total: 2, data: 'a' }).status).toBe('partial')
    expect(a.accept('c', { msgId: ID2, seq: 0, total: 2, data: 'a' }).status).toBe('partial')
    expect(a.accept('c', { msgId: ID3, seq: 0, total: 2, data: 'a' })).toEqual({ status: 'refused', reason: 'too_many_inflight' })
    // other clients are independent
    expect(a.accept('d', { msgId: ID3, seq: 0, total: 2, data: 'a' }).status).toBe('partial')
  })

  it('refuses accumulated data over maxMessageBytes and frees it', () => {
    const a = createFrameAssembler({ maxMessageBytes: 10 })
    expect(a.accept('c', { msgId: ID1, seq: 0, total: 3, data: '123456' }).status).toBe('partial')
    expect(a.accept('c', { msgId: ID1, seq: 1, total: 3, data: '12345' })).toEqual({ status: 'refused', reason: 'too_large' })
    expect(a.accept('c', { msgId: ID1, seq: 1, total: 3, data: '1' }).status).toBe('partial')
  })

  it('refuses bad JSON', () => {
    const a = createFrameAssembler()
    expect(a.accept('c', { msgId: ID1, seq: 0, total: 2, data: '{"type":' }).status).toBe('partial')
    expect(a.accept('c', { msgId: ID1, seq: 1, total: 2, data: 'oops' })).toEqual({ status: 'refused', reason: 'bad_json' })
  })

  it('refuses bad inner envelopes', () => {
    const a = createFrameAssembler()
    for (const inner of [[1], 'str', null, { id: 1 }, { type: 5 }, { type: 'e2e:frame' }, { type: 'e2e:box' }]) {
      const frames = framesOf(inner, 1000)
      expect(frames.length).toBe(1)
      expect(a.accept('c', { msgId: ID1, ...frames[0] })).toEqual({ status: 'refused', reason: 'bad_inner' })
    }
  })

  it('sweep evicts idle partials via injected now', () => {
    let t = 1000
    const a = createFrameAssembler({ idleTtlMs: 100, now: () => t })
    expect(a.accept('c', { msgId: ID1, seq: 0, total: 2, data: 'a' }).status).toBe('partial')
    expect(a.accept('c', { msgId: ID2, seq: 0, total: 2, data: 'a' }).status).toBe('partial')
    t += 101
    // accept sweeps first, so both slots are free again
    expect(a.accept('c', { msgId: ID3, seq: 0, total: 2, data: 'a' }).status).toBe('partial')
    // ID1 was evicted: its seq 0 is no longer a duplicate
    expect(a.accept('c', { msgId: ID1, seq: 0, total: 2, data: 'a' }).status).toBe('partial')
    t += 50
    a.sweep()
    expect(a.accept('c', { msgId: ID2, seq: 0, total: 2, data: 'a' })).toEqual({ status: 'refused', reason: 'too_many_inflight' })
    t += 60
    a.sweep()
    expect(a.accept('c', { msgId: ID2, seq: 0, total: 2, data: 'a' }).status).toBe('partial')
  })

  it('dropClient frees all of a client partials', () => {
    const a = createFrameAssembler()
    a.accept('c', { msgId: ID1, seq: 0, total: 2, data: 'a' })
    a.accept('c', { msgId: ID2, seq: 0, total: 2, data: 'a' })
    a.accept('d', { msgId: ID1, seq: 0, total: 2, data: 'a' })
    a.dropClient('c')
    expect(a.accept('c', { msgId: ID3, seq: 0, total: 2, data: 'a' }).status).toBe('partial')
    expect(a.accept('c', { msgId: ID1, seq: 0, total: 2, data: 'a' }).status).toBe('partial')
    expect(a.accept('d', { msgId: ID1, seq: 0, total: 2, data: 'a' })).toEqual({ status: 'refused', reason: 'duplicate_seq' })
  })
})
