'use strict';

/**
 * web-remote-frames.test.cjs — browser→desktop messages over the relay's 256 KB cap arrive
 * as boxed e2e:frame sequences, are rebuilt by remoteFrameAssembler, and then pass through
 * the unchanged dispatchEnvelope gates.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-frames.test.cjs
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { encryptBox, decryptBox, generateE2EKeyPair } = require('../lib/feedback-remote/remoteE2eCrypto.cjs')
const { chunkFrames } = require('../lib/feedback-remote/remoteIpcDispatch.cjs')

let tmpHome
let origHome
let webRemote
let configPath

beforeAll(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-remote-frames-'))
  origHome = process.env.HOME
  process.env.HOME = tmpHome
  const electronPath = require.resolve('electron')
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: {
      ipcMain: { handle: () => {}, on: () => {} },
      app: { getPath: () => tmpHome, getVersion: () => '0.0.0-test' },
    },
  }
  for (const mod of ['../webRemote.cjs', '../config.cjs', '../logs.cjs']) {
    try { delete require.cache[require.resolve(mod)] } catch { /* not loaded */ }
  }
  webRemote = require('../webRemote.cjs')
  configPath = path.join(tmpHome, '.claude', 'session-manager', 'web-remote.json')
})

afterAll(async () => {
  process.env.HOME = origHome
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

describe('web-remote e2e:frame reassembly', () => {
  const dk = generateE2EKeyPair()
  const device = {
    deviceId: 'device-frames', deviceToken: 'tok', e2ePrivateKey: dk.e2ePrivateKey, e2ePublicKey: dk.e2ePublicKey,
    deviceName: 'Frames', issuedAt: new Date(0).toISOString(), lastConnectedAt: null, verifiedPeerPubKey: null,
  }
  const key = crypto.randomBytes(32)
  const sent = []
  const fakeWs = { readyState: 1, send: (m) => sent.push(JSON.parse(m)), terminate: () => {} }
  const received = []

  const sendBoxed = (conn, inner) => {
    const { nonce, ciphertext } = encryptBox(JSON.stringify(inner), key)
    return webRemote._internal.handleMessage(
      JSON.stringify({ type: 'e2e:box', id: inner.id, fromConn: conn, payload: { nonce, ciphertext } }), device)
  }
  const framesOf = (envelope, msgId) => {
    const r = chunkFrames(envelope, 180 * 1024)
    expect(r.ok).toBe(true)
    return r.frames.map((f) => ({ type: 'e2e:frame', id: crypto.randomUUID(), payload: { msgId, seq: f.seq, total: f.total, data: f.data }, ts: 1 }))
  }
  const decoded = () => sent.map((m) => {
    if (m.type !== 'e2e:box') return m
    return JSON.parse(decryptBox(m.payload.nonce, m.payload.ciphertext, key))
  })

  async function setup(state = 'authenticated') {
    await fsp.mkdir(path.join(tmpHome, '.claude', 'session-manager', 'logs'), { recursive: true })
    await fsp.mkdir(path.dirname(configPath), { recursive: true })
    await fsp.writeFile(configPath, JSON.stringify({ remoteEnabled: true, remoteControlEnabled: true, devices: [device] }, null, 2) + '\n')
    webRemote.__test.invalidateConfigCache()
    webRemote._internal.resetE2e()
    webRemote.__test.setWs(fakeWs)
    webRemote.__test.setE2eAuthenticated(key, 'connA')
    if (state !== 'authenticated') webRemote.__test.getClient('connA').e2e.state = state
    webRemote.__test.getDispatchMap()['cmd:chat:send'] = async (payload) => { received.push(payload); return { ok: true } }
    sent.length = 0
    received.length = 0
  }

  it('a 600 KB cmd:* envelope sent as boxed e2e:frame envelopes reaches the handler intact', async () => {
    await setup()
    const big = 'y'.repeat(600 * 1024)
    const cmdId = crypto.randomUUID()
    const frames = framesOf({ type: 'cmd:chat:send', id: cmdId, payload: { text: big }, ts: 1 }, cmdId)
    expect(frames.length).toBeGreaterThan(3)
    for (const f of frames) await sendBoxed('connA', f)
    expect(received).toHaveLength(1)
    expect(received[0].text).toBe(big)
    expect(decoded().map((m) => m.type)).toEqual([`resp:${cmdId}`])
  })

  it('frames from a pending_sas client are dropped unbuffered', async () => {
    await setup('pending_sas')
    const cmdId = crypto.randomUUID()
    const frames = framesOf({ type: 'cmd:chat:send', id: cmdId, payload: { text: 'z'.repeat(400 * 1024) }, ts: 1 }, cmdId)
    await sendBoxed('connA', frames[0])
    expect(received).toHaveLength(0)
    expect(sent).toHaveLength(0)
    // Had frame 0 been buffered, the rest would now complete the message.
    webRemote.__test.getClient('connA').e2e.state = 'authenticated'
    for (const f of frames.slice(1)) await sendBoxed('connA', f)
    expect(received).toHaveLength(0)
  })

  it('a refused frame sends resp:<msgId> with error', async () => {
    await setup()
    const msgId = crypto.randomUUID()
    await sendBoxed('connA', { type: 'e2e:frame', id: 'f1', payload: { msgId, seq: 0, total: 2, data: 'abc' }, ts: 1 })
    await sendBoxed('connA', { type: 'e2e:frame', id: 'f2', payload: { msgId, seq: 0, total: 2, data: 'abc' }, ts: 1 })
    expect(decoded()).toEqual([expect.objectContaining({ type: `resp:${msgId}`, payload: { error: 'rejected' } })])
    expect(received).toHaveLength(0)
  })

  it('plaintext e2e:frame envelopes are ignored', async () => {
    await setup()
    const msgId = crypto.randomUUID()
    const cmdId = msgId
    const frames = framesOf({ type: 'cmd:chat:send', id: cmdId, payload: { text: 'p'.repeat(400 * 1024) }, ts: 1 }, cmdId)
    await webRemote._internal.handleMessage(JSON.stringify({ ...frames[0], fromConn: 'connA' }), device)
    for (const f of frames.slice(1)) await sendBoxed('connA', f)
    expect(received).toHaveLength(0)
  })

  it('a client disconnect frees its partial', async () => {
    await setup()
    const cmdId = crypto.randomUUID()
    const frames = framesOf({ type: 'cmd:chat:send', id: cmdId, payload: { text: 'q'.repeat(400 * 1024) }, ts: 1 }, cmdId)
    await sendBoxed('connA', frames[0])
    await webRemote._internal.handleMessage(JSON.stringify({ type: 'event:client:disconnected', fromConn: 'connA' }), device)
    // Reconnect under the same key: the freed partial must not combine with the remainder.
    webRemote.__test.setE2eAuthenticated(key, 'connA')
    for (const f of frames.slice(1)) await sendBoxed('connA', f)
    expect(received).toHaveLength(0)
  })

  it('event:remote:ready carries capabilities', async () => {
    await setup()
    expect(webRemote.REMOTE_CAPABILITIES).toEqual(['e2e-frames'])
    expect(Object.isFrozen(webRemote.REMOTE_CAPABILITIES)).toBe(true)
    webRemote.__test.finalizeE2eAuthenticated('test', webRemote.__test.getClient('connA'))
    const [ev] = decoded()
    expect(ev.type).toBe('event:remote:ready')
    expect(ev.payload.capabilities).toEqual(['e2e-frames'])
    expect(typeof ev.payload.ts).toBe('number')
  })
})
