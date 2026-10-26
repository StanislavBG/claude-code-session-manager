'use strict'

/**
 * web-remote-push-fanout.test.cjs — ipc:subscribe / ipc:unsubscribe + sendIfAlive fanout to
 * E2E-authenticated clients as chunked ipc:event frames.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-push-fanout.test.cjs
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { encryptBox, decryptBox } = require('../lib/feedback-remote/remoteE2eCrypto.cjs')

let tmpHome
let origHome
let webRemote
let sendToRenderer

function genP256() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  return { priv: privateKey.toString('base64url'), pub: publicKey.toString('base64url') }
}

beforeAll(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-remote-push-fanout-'))
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
  for (const mod of ['../webRemote.cjs', '../config.cjs', '../logs.cjs', '../lib/sendToRenderer.cjs']) {
    try { delete require.cache[require.resolve(mod)] } catch { /* not loaded */ }
  }
  webRemote = require('../webRemote.cjs')
  sendToRenderer = require('../lib/sendToRenderer.cjs')
  webRemote.registerRemoteHandlers()
})

afterAll(async () => {
  process.env.HOME = origHome
  sendToRenderer.setRemoteFanout(null)
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

describe('web-remote push fanout', () => {
  const dk = genP256()
  const device = {
    deviceId: 'device-push', deviceToken: 'tok', e2ePrivateKey: dk.priv, e2ePublicKey: dk.pub,
    deviceName: 'Push', issuedAt: new Date(0).toISOString(), lastConnectedAt: null, verifiedPeerPubKey: null,
  }
  const key = crypto.randomBytes(32)
  const sent = []
  const fakeWs = { readyState: 1, send: (m) => sent.push(JSON.parse(m)), terminate: () => {} }

  const send = (conn, inner) => {
    const { nonce, ciphertext } = encryptBox(JSON.stringify(inner), key)
    return webRemote._internal.handleMessage(
      JSON.stringify({ type: 'e2e:box', id: inner.id, fromConn: conn, payload: { nonce, ciphertext } }), device)
  }
  const sub = (channels, conn = 'connA', type = 'ipc:subscribe') =>
    send(conn, { type, id: `s-${Math.random()}`, payload: { channels }, ts: 1 })
  const events = () => sent.filter((m) => m.type === 'e2e:box').map((m) => ({ to: m.toConn, ...JSON.parse(decryptBox(m.payload.nonce, m.payload.ciphertext, key)) }))
  const push = (channel, payload) => sendToRenderer.sendIfAlive(null, channel, payload)

  function setup() {
    webRemote._internal.resetE2e()
    webRemote.__test.setWs(fakeWs)
    webRemote.__test.setE2eAuthenticated(key, 'connA')
    sent.length = 0
  }

  it('delivers a subscribed channel as an ipc:event and stops after unsubscribe', async () => {
    setup()
    await sub(['agents:changed'])
    push('agents:changed', { n: 1 })
    const [e] = events()
    expect(e).toMatchObject({ type: 'ipc:event', channel: 'agents:changed', seq: 0, total: 1, to: 'connA' })
    expect(JSON.parse(e.data)).toEqual({ n: 1 })
    sent.length = 0
    await sub(['agents:changed'], 'connA', 'ipc:unsubscribe')
    push('agents:changed', { n: 2 })
    expect(sent).toHaveLength(0)
  })

  it('refuses deny and unknown channels', async () => {
    setup()
    await sub(['pty:data:abc', 'config:changed', 'nope:nothing', 'app:version'])
    push('pty:data:abc', 1); push('config:changed', 1); push('nope:nothing', 1); push('app:version', 1)
    expect(sent).toHaveLength(0)
  })

  it('matches on-dynamic channels by prefix', async () => {
    setup()
    await sub(['transcript:event:sess1'])
    push('transcript:event:sess1', 'hi')
    push('transcript:event:other', 'no')
    const evs = events()
    expect(evs).toHaveLength(1)
    expect(evs[0].channel).toBe('transcript:event:sess1')
  })

  it('sends nothing to an unauthenticated client', async () => {
    setup()
    await sub(['agents:changed'])
    webRemote.__test.getClient('connA').e2e.state = 'pending_sas'
    push('agents:changed', 1)
    expect(sent).toHaveLength(0)
    // an unauthenticated client cannot subscribe either
    webRemote.__test.getClient('connB')
    await sub(['agents:changed'], 'connB')
    webRemote.__test.getClient('connA').e2e.state = 'authenticated'
    sent.length = 0
    push('agents:changed', 1)
    expect(events().map((e) => e.to)).toEqual(['connA'])
  })

  it('clears subscriptions on disconnect', async () => {
    setup()
    await sub(['agents:changed'])
    webRemote._internal.resetE2e()
    webRemote.__test.setE2eAuthenticated(key, 'connA')
    sent.length = 0
    push('agents:changed', 1)
    expect(sent).toHaveLength(0)
  })

  it('chunks a large payload into frames that join back', async () => {
    setup()
    await sub(['agents:changed'])
    const big = 'y'.repeat(600 * 1024)
    push('agents:changed', big)
    const evs = events()
    expect(evs.length).toBeGreaterThan(1)
    const { joinFrames } = require('../lib/feedback-remote/remoteIpcDispatch.cjs')
    expect(joinFrames(evs.map(({ seq, total, data }) => ({ seq, total, data })))).toBe(big)
  })
})
