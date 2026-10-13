'use strict';

/**
 * web-remote-repair-identity.test.cjs — re-pairing an existing machine keeps its
 * deviceId, E2E keypair and pinned phone keys; revocation or a relay-returned
 * deviceId mismatch yields a fresh identity.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-repair-identity.test.cjs
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'

const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const https = require('node:https')
const { EventEmitter } = require('node:events')

let tmpHome
let origHome
let origRequest
let webRemote
let cfgPath
let sent

// Fake https.request for /pair: records the body; replies with `respond(body)`.
function stubPair(respond) {
  https.request = (_opts, cb) => {
    const req = new EventEmitter()
    let written = ''
    req.setTimeout = () => {}
    req.destroy = () => {}
    req.write = (c) => { written += c }
    req.end = (c) => {
      if (c) written += c
      const body = JSON.parse(written || '{}')
      sent = body
      const res = new EventEmitter()
      res.statusCode = 200
      cb(res)
      res.emit('data', JSON.stringify(respond(body)))
      res.emit('end')
    }
    return req
  }
}

const echo = (b) => ({ deviceId: b.deviceId, deviceToken: 'new-token' })

async function seed(devices) {
  await fsp.writeFile(cfgPath, JSON.stringify({ remoteEnabled: false, devices }))
  webRemote.__test.invalidateConfigCache()
}
async function readDevices() {
  return JSON.parse(await fsp.readFile(cfgPath, 'utf8')).devices
}

const PRIOR = {
  deviceId: 'dev-old', deviceToken: 'old-token', issuedAt: new Date(0).toISOString(),
  e2ePrivateKey: 'priv-old', e2ePublicKey: 'pub-old',
  verifiedPeerPubKey: 'phone-1', verifiedPeerPubKeys: ['phone-1', 'phone-2'],
}

beforeAll(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-remote-repair-'))
  origHome = process.env.HOME
  process.env.HOME = tmpHome
  origRequest = https.request
  const electronPath = require.resolve('electron')
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: {
      ipcMain: { handle: () => {}, on: () => {} },
      app: { getPath: () => tmpHome, getVersion: () => '0.0.0-test' },
    },
  }
  for (const mod of ['../webRemote.cjs', '../config.cjs', '../logs.cjs']) {
    try { delete require.cache[require.resolve(mod)] } catch { /* not yet loaded */ }
  }
  webRemote = require('../webRemote.cjs')
  cfgPath = path.join(tmpHome, '.claude', 'session-manager', 'web-remote.json')
  await fsp.mkdir(path.dirname(cfgPath), { recursive: true })
})

beforeEach(() => { sent = null })
afterEach(() => { https.request = origRequest })
afterAll(async () => {
  https.request = origRequest
  process.env.HOME = origHome
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

describe('re-pair identity', () => {
  it('reuses deviceId, pubkey and pins; only token/issuedAt change', async () => {
    await seed([{ ...PRIOR }])
    stubPair(echo)
    const r = await webRemote.__test.pair('abc123')
    expect(r.ok).toBe(true)
    expect(sent.deviceId).toBe('dev-old')
    expect(sent.devicePubKey).toBe('pub-old')
    const [d] = await readDevices()
    expect(d.deviceId).toBe('dev-old')
    expect(d.deviceToken).toBe('new-token')
    expect(d.e2ePrivateKey).toBe('priv-old')
    expect(d.e2ePublicKey).toBe('pub-old')
    expect(d.verifiedPeerPubKeys).toEqual(['phone-1', 'phone-2'])
    expect(d.verifiedPeerPubKey).toBe('phone-1')
    expect(d.issuedAt).not.toBe(PRIOR.issuedAt)
    expect(d.lastConnectedAt).toBeNull()
  })

  it('pair after revokeAllDevices mints a new identity with empty pins', async () => {
    await seed([{ ...PRIOR }])
    await webRemote.__test.revokeAllDevices()
    stubPair(echo)
    await webRemote.__test.pair('abc123')
    expect(sent.deviceId).not.toBe('dev-old')
    expect(sent.devicePubKey).not.toBe('pub-old')
    const [d] = await readDevices()
    expect(d.deviceId).toBe(sent.deviceId)
    expect(d.e2ePublicKey).toBe(sent.devicePubKey)
    expect(d.verifiedPeerPubKeys).toEqual([])
    expect(d.verifiedPeerPubKey).toBeNull()
  })

  it('relay-returned deviceId mismatch drops pins and keeps the request keypair', async () => {
    await seed([{ ...PRIOR }])
    stubPair(() => ({ deviceId: 'relay-chosen', deviceToken: 'new-token' }))
    await webRemote.__test.pair('abc123')
    const [d] = await readDevices()
    expect(d.deviceId).toBe('relay-chosen')
    expect(d.e2ePublicKey).toBe(sent.devicePubKey)
    expect(d.verifiedPeerPubKeys).toEqual([])
    expect(d.verifiedPeerPubKey).toBeNull()
  })
})
