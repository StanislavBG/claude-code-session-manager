'use strict'

import { describe, it, expect, afterEach } from 'vitest'

const { sendIfAlive, setRemoteFanout } = require('../sendToRenderer.cjs')

const liveWindow = (sent) => ({
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, isCrashed: () => false, send: (c, p) => sent.push([c, p]) },
})

describe('sendIfAlive remote fanout hook', () => {
  afterEach(() => setRemoteFanout(null))

  it('calls the fanout after the window send', () => {
    const order = []
    setRemoteFanout((c, p) => order.push(['fan', c, p]))
    sendIfAlive(liveWindow(order), 'a:b', { x: 1 })
    expect(order).toEqual([['a:b', { x: 1 }], ['fan', 'a:b', { x: 1 }]])
  })

  it('still fans out when the window is null or destroyed', () => {
    const got = []
    setRemoteFanout((c, p) => got.push([c, p]))
    sendIfAlive(null, 'n:1', 1)
    sendIfAlive({ isDestroyed: () => true }, 'n:2', 2)
    expect(got).toEqual([['n:1', 1], ['n:2', 2]])
  })

  it('never throws when the fanout throws or window send throws', () => {
    setRemoteFanout(() => { throw new Error('boom') })
    const win = liveWindow([])
    win.webContents.send = () => { throw new Error('disposed') }
    expect(() => sendIfAlive(win, 'x', 1)).not.toThrow()
  })

  it('works with no fanout registered', () => {
    expect(() => sendIfAlive(null, 'x', 1)).not.toThrow()
  })
})
