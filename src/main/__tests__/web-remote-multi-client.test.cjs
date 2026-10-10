'use strict';

/**
 * web-remote-multi-client.test.cjs — two relay clients (fromConn connA/connB) each keep
 * their own ECDH session key + SAS state; replies are encrypted for, and unicast to, the requester.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-multi-client.test.cjs
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { generateE2EKeyPair, deriveSessionKey, encryptBox, decryptBox } = require('../lib/remoteE2eCrypto.cjs')

/** Generate a P-256 keypair in the same encoding webRemote.cjs uses (SPKI/PKCS8, base64url). */
function genP256KeyPairB64() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  return {
    priv: privateKey.toString('base64url'),
    pub: publicKey.toString('base64url'),
  }
}

let tmpHome
let origHome
let webRemote
let configPath
let handlers // captured ipcMain.handle(name, fn) map

function freshRequire(mod) {
  delete require.cache[require.resolve(mod)]
  return require(mod)
}

async function readConfig() {
  const text = await fsp.readFile(configPath, 'utf8')
  return JSON.parse(text)
}

async function writeConfig(cfg) {
  await fsp.mkdir(path.dirname(configPath), { recursive: true })
  await fsp.writeFile(configPath, JSON.stringify(cfg, null, 2) + '\n')
}

beforeAll(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-remote-multi-client-'))
  origHome = process.env.HOME
  process.env.HOME = tmpHome

  // Stub 'electron' before webRemote.cjs (and logs.cjs, transitively) require it —
  // outside a real Electron process, require('electron') just resolves to a path
  // string, so destructuring { ipcMain, app } off it would throw at module load.
  handlers = new Map()
  const electronPath = require.resolve('electron')
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      ipcMain: {
        handle: (name, fn) => handlers.set(name, fn),
        on: () => {},
      },
      app: {
        getPath: () => tmpHome,
        getVersion: () => '0.0.0-test',
      },
    },
  }

  // Clear anything already cached under the real HOME so paths re-resolve under tmpHome.
  for (const mod of ['../webRemote.cjs', '../config.cjs', '../logs.cjs', './e2eStateMachine.cjs']) {
    try { delete require.cache[require.resolve(mod)] } catch { /* not yet loaded */ }
  }

  webRemote = freshRequire('../webRemote.cjs')
  configPath = path.join(tmpHome, '.claude', 'session-manager', 'web-remote.json')

  webRemote.registerRemoteHandlers()
})

afterAll(async () => {
  process.env.HOME = origHome
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

describe('web-remote multi-client E2E', () => {
  const deviceKeys = genP256KeyPairB64()
  const deviceId = 'device-multi'
  const device = {
    deviceId,
    deviceToken: 'tok',
    e2ePrivateKey: deviceKeys.priv,
    e2ePublicKey: deviceKeys.pub,
    deviceName: 'Multi',
    issuedAt: new Date(0).toISOString(),
    lastConnectedAt: null,
    verifiedPeerPubKey: null,
  }
  const sent = []
  const fakeWs = { readyState: 1, send: (m) => sent.push(JSON.parse(m)), terminate: () => {} }

  const hello = (conn, pub, id) => webRemote._internal.handleMessage(
    JSON.stringify({ type: 'e2e:hello', id, fromConn: conn, payload: { pubKey: pub } }), device)
  const boxed = (conn, key, inner) => {
    const { nonce, ciphertext } = encryptBox(JSON.stringify(inner), key)
    return webRemote._internal.handleMessage(
      JSON.stringify({ type: 'e2e:box', id: inner.id, fromConn: conn, payload: { nonce, ciphertext } }), device)
  }

  it('keeps separate keys, unicasts replies, and isolates re-hello', async () => {
    await writeConfig({ remoteEnabled: true, remoteControlEnabled: false, devices: [device] })
    webRemote.__test.setWs(fakeWs)
    const a = generateE2EKeyPair()
    const b = generateE2EKeyPair()
    const keyA = deriveSessionKey(a.e2ePrivateKey, deviceKeys.pub, deviceId)
    const keyB = deriveSessionKey(b.e2ePrivateKey, deviceKeys.pub, deviceId)

    await hello('connA', a.e2ePublicKey, 'hA')
    await hello('connB', b.e2ePublicKey, 'hB')
    expect(sent.filter((m) => m.type === 'e2e:ready').map((m) => m.toConn)).toEqual(['connA', 'connB'])
    expect(webRemote._internal.getE2eState('connA').state).toBe('pending_sas')
    expect(webRemote._internal.getE2eState('connB').state).toBe('pending_sas')

    sent.length = 0
    await boxed('connA', keyA, { type: 'cmd:unknown:probe', id: 'qA', payload: {}, ts: 1 })
    await boxed('connB', keyB, { type: 'cmd:unknown:probe', id: 'qB', payload: {}, ts: 1 })
    expect(sent).toHaveLength(2)
    const [rA, rB] = sent
    expect(rA.type).toBe('e2e:box')
    expect(rA.toConn).toBe('connA')
    expect(rB.toConn).toBe('connB')
    expect(decryptBox(rA.payload.nonce, rA.payload.ciphertext, keyA)).toBeTruthy()
    expect(decryptBox(rA.payload.nonce, rA.payload.ciphertext, keyB)).toBeFalsy()
    expect(decryptBox(rB.payload.nonce, rB.payload.ciphertext, keyB)).toBeTruthy()
    expect(decryptBox(rB.payload.nonce, rB.payload.ciphertext, keyA)).toBeFalsy()

    // connA re-hellos with a new key — connB's state and key are untouched.
    const keyBBefore = webRemote._internal.getE2eState('connB').sessionKey
    const a2 = generateE2EKeyPair()
    await hello('connA', a2.e2ePublicKey, 'hA2')
    expect(webRemote._internal.getE2eState('connB').sessionKey).toBe(keyBBefore)
    expect(webRemote._internal.getE2eState('connB').state).toBe('pending_sas')
    expect(webRemote._internal.getE2eState('connA').sessionKey).not.toBe(keyA)

    // A box from a client with no session is dropped.
    sent.length = 0
    await boxed('connC', keyA, { type: 'cmd:unknown:probe', id: 'qC', payload: {}, ts: 1 })
    expect(sent).toHaveLength(0)
  })
})
