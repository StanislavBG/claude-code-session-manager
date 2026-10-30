'use strict';

/**
 * web-remote-pinned-ready-order.test.cjs — contract: an e2e:hello from an already-pinned
 * browser key sends the boxed event:remote:ready BEFORE the plaintext e2e:ready.
 * web/remote-app/src/ws.ts relies on that order to skip the SAS prompt.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-pinned-ready-order.test.cjs
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { generateE2EKeyPair, deriveSessionKey, decryptBox } = require('../lib/feedback-remote/remoteE2eCrypto.cjs')

let tmpHome
let origHome
let webRemote

function freshRequire(mod) {
  delete require.cache[require.resolve(mod)]
  return require(mod)
}

beforeAll(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-remote-pinned-order-'))
  origHome = process.env.HOME
  process.env.HOME = tmpHome

  const electronPath = require.resolve('electron')
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      ipcMain: { handle: () => {}, on: () => {} },
      app: { getPath: () => tmpHome, getVersion: () => '0.0.0-test' },
    },
  }

  for (const mod of ['../webRemote.cjs', '../config.cjs', '../logs.cjs']) {
    try { delete require.cache[require.resolve(mod)] } catch { /* not yet loaded */ }
  }
  webRemote = freshRequire('../webRemote.cjs')
})

afterAll(async () => {
  process.env.HOME = origHome
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

describe('web-remote pinned hello frame order', () => {
  const dev = generateE2EKeyPair()
  const browser = generateE2EKeyPair()
  const stranger = generateE2EKeyPair()
  const deviceId = 'device-pinned-order'
  const device = {
    deviceId,
    deviceToken: 'tok',
    e2ePrivateKey: dev.e2ePrivateKey,
    e2ePublicKey: dev.e2ePublicKey,
    deviceName: 'PinnedOrder',
    issuedAt: new Date(0).toISOString(),
    lastConnectedAt: null,
    verifiedPeerPubKeys: [{ pubKey: browser.e2ePublicKey, pinnedAt: new Date(0).toISOString() }],
  }
  const sent = []
  const fakeWs = { readyState: 1, send: (m) => sent.push(JSON.parse(m)), terminate: () => {} }

  async function setup() {
    const configPath = path.join(tmpHome, '.claude', 'session-manager', 'web-remote.json')
    await fsp.mkdir(path.dirname(configPath), { recursive: true })
    await fsp.writeFile(configPath, JSON.stringify({ remoteEnabled: true, remoteControlEnabled: false, devices: [device] }, null, 2) + '\n')
    webRemote.__test.invalidateConfigCache()
    webRemote._internal.resetE2e()
    webRemote.__test.setWs(fakeWs)
    sent.length = 0
  }

  const hello = (pub) => webRemote._internal.handleMessage(
    JSON.stringify({ type: 'e2e:hello', id: 'h1', fromConn: 'connP', payload: { pubKey: pub } }), device)

  it('pinned key: boxed event:remote:ready first, plaintext e2e:ready second', async () => {
    await setup()
    await hello(browser.e2ePublicKey)
    expect(sent).toHaveLength(2)
    expect(sent[0].type).toBe('e2e:box')
    expect(sent[1].type).toBe('e2e:ready')
    expect(sent[0].toConn).toBe('connP')
    expect(sent[1].toConn).toBe('connP')
    expect(webRemote._internal.getE2eState('connP').state).toBe('authenticated')

    const key = deriveSessionKey(dev.e2ePrivateKey, browser.e2ePublicKey, deviceId)
    const inner = decryptBox(sent[0].payload.nonce, sent[0].payload.ciphertext, key)
    const parsed = typeof inner === 'string' ? JSON.parse(inner) : inner
    expect(parsed.type).toBe('event:remote:ready')
  })

  it('unpinned key: only e2e:ready, state pending_sas', async () => {
    await setup()
    await hello(stranger.e2ePublicKey)
    expect(sent.map((m) => m.type)).toEqual(['e2e:ready'])
    expect(webRemote._internal.getE2eState('connP').state).toBe('pending_sas')
  })
})
