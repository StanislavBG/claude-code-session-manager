'use strict';

/**
 * web-remote-pin-live.test.cjs — a pin written by webRemote:confirm-sas must be
 * visible to the SAME open relay connection, whose `device` snapshot was taken
 * at connect() time and is passed (stale) to every handleMessage call.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-pin-live.test.cjs
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

function genP256KeyPairB64() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  return { priv: privateKey.toString('base64url'), pub: publicKey.toString('base64url') }
}

let tmpHome
let origHome
let webRemote
let configPath
let handlers

async function writeConfig(cfg) {
  await fsp.mkdir(path.dirname(configPath), { recursive: true })
  await fsp.writeFile(configPath, JSON.stringify(cfg, null, 2) + '\n')
  webRemote.__test.invalidateConfigCache()
}

beforeAll(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-remote-pin-live-'))
  origHome = process.env.HOME
  process.env.HOME = tmpHome
  handlers = new Map()
  const electronPath = require.resolve('electron')
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: () => {} },
      app: { getPath: () => tmpHome, getVersion: () => '0.0.0-test' },
    },
  }
  for (const mod of ['../webRemote.cjs', '../config.cjs', '../logs.cjs']) {
    try { delete require.cache[require.resolve(mod)] } catch { /* not yet loaded */ }
  }
  webRemote = require('../webRemote.cjs')
  configPath = path.join(tmpHome, '.claude', 'session-manager', 'web-remote.json')
  webRemote.registerRemoteHandlers()
})

afterAll(async () => {
  process.env.HOME = origHome
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

describe('web-remote live pin check', () => {
  const deviceKeys = genP256KeyPairB64()
  const browserK = genP256KeyPairB64()
  const browserOther = genP256KeyPairB64()
  const deviceId = 'dev-live'

  const row = (id, extra = {}) => ({
    deviceId: id,
    deviceToken: 'tok-' + id,
    e2ePrivateKey: deviceKeys.priv,
    e2ePublicKey: deviceKeys.pub,
    deviceName: id,
    issuedAt: new Date(0).toISOString(),
    lastConnectedAt: null,
    verifiedPeerPubKey: null,
    ...extra,
  })
  const hello = (device, conn, pub, id) => webRemote._internal.handleMessage(
    JSON.stringify({ type: 'e2e:hello', id, fromConn: conn, payload: { pubKey: pub } }), device)
  const stateOf = (conn) => webRemote._internal.getE2eState(conn).state

  it('a) pin from confirm-sas on client A is honoured for client B on the same stale device snapshot', async () => {
    await writeConfig({ remoteEnabled: true, remoteControlEnabled: false, devices: [row(deviceId)] })
    const stale = JSON.parse(JSON.stringify(row(deviceId))) // connect-time snapshot, never refreshed

    await hello(stale, 'connA', browserK.pub, 'm1')
    expect(stateOf('connA')).toBe('pending_sas')
    expect(await handlers.get('webRemote:confirm-sas')({}, { clientKey: 'connA' })).toEqual({ ok: true })

    await hello(stale, 'connB', browserK.pub, 'm2')
    expect(stateOf('connB')).toBe('authenticated')
  })

  it('b) a never-pinned key stays pending_sas', async () => {
    const stale = row(deviceId)
    await hello(stale, 'connC', browserOther.pub, 'm3')
    expect(stateOf('connC')).toBe('pending_sas')
  })

  it('c) a pin under another deviceId does not authenticate', async () => {
    await writeConfig({
      remoteEnabled: true,
      remoteControlEnabled: false,
      devices: [
        row(deviceId),
        row('dev-other', { verifiedPeerPubKeys: [{ pubKey: browserOther.pub, pinnedAt: new Date().toISOString() }] }),
      ],
    })
    webRemote._internal.resetE2e()
    await hello(row(deviceId), 'connD', browserOther.pub, 'm4')
    expect(stateOf('connD')).toBe('pending_sas')
  })
})
