import { describe, expect, it } from 'vitest'
import { resolveContextInjections } from '../contextInjections'

describe('resolveContextInjections', () => {
  it('is all off with no agent, no mission, no loop', () => {
    expect(resolveContextInjections({ tag: null, agentless: true, developLoop: false })).toEqual({
      'general-behavior': false,
      'delegate-implementation': false,
    })
  })
  it('is all on for feature + agent + loop', () => {
    expect(resolveContextInjections({ tag: 'feature', agentless: false, developLoop: true })).toEqual({
      'general-behavior': true,
      'delegate-implementation': true,
    })
  })
  it('discussion: general on, delegate off', () => {
    expect(resolveContextInjections({ tag: 'discussion', agentless: true, developLoop: true })).toEqual({
      'general-behavior': true,
      'delegate-implementation': false,
    })
  })
  it('no tag with an agent: general on, delegate off', () => {
    expect(resolveContextInjections({ tag: null, agentless: false, developLoop: true })).toEqual({
      'general-behavior': true,
      'delegate-implementation': false,
    })
  })
  it('forces delegate off when loop is off, even if overridden on', () => {
    const r = resolveContextInjections({
      tag: 'feature',
      agentless: false,
      developLoop: false,
      overrides: { 'delegate-implementation': true },
    })
    expect(r['delegate-implementation']).toBe(false)
  })
  it('honors general-behavior overrides', () => {
    expect(
      resolveContextInjections({ tag: null, agentless: true, developLoop: false, overrides: { 'general-behavior': true } })[
        'general-behavior'
      ],
    ).toBe(true)
    expect(
      resolveContextInjections({ tag: 'bug', agentless: false, developLoop: true, overrides: { 'general-behavior': false } })[
        'general-behavior'
      ],
    ).toBe(false)
  })
})
