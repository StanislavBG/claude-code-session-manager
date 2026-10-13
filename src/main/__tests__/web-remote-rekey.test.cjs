'use strict';

/**
 * web-remote-rekey.test.cjs — a box from a client with no session key gets one throttled
 * plaintext e2e:rekey (unicast via toConn); decrypt failures with a key stay silent.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-rekey.test.cjs
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { generateE2EKeyPair, deriveSessionKey, encryptBox } = require('../lib/feedback-remote/remoteE2eCrypto.cjs')

let tmpHome
let origHome
let webRemote

beforeAll(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-remote-rekey-'))
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
  for (const mod of ['../webRemote.cjs', '../config.cjs', '../logs.cjs', './e2eStateMachine.cjs']) {
    try { delete require.cache[require.resolve(mod)] } catch { /* not yet loaded */ }
  }
  webRemote = require('../webRemote.cjs')
})

afterAll(async () => {
  vi.useRealTimers()
  process.env.HOME = origHome
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

describe('web-remote e2e:rekey', () => {
  const kp = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  const deviceId = 'device-rekey'
  const device = {
    deviceId, deviceToken: 'tok', e2ePrivateKey: kp.privateKey.toString('base64url'),
    e2ePublicKey: kp.publicKey.toString('base64url'), deviceName: 'Rekey',
    issuedAt: new Date(0).toISOString(), lastConnectedAt: null, verifiedPeerPubKey: null,
  }
  const sent = []
  const fakeWs = { readyState: 1, send: (m) => sent.push(JSON.parse(m)), terminate: () => {} }
  const box = (conn, key, id) => {
    const { nonce, ciphertext } = encryptBox(JSON.stringify({ type: 'cmd:x', id, payload: {}, ts: 1 }), key)
    return webRemote._internal.handleMessage(
      JSON.stringify({ type: 'e2e:box', id, fromConn: conn, payload: { nonce, ciphertext } }), device)
  }

  it('rekeys an unknown client once per 5s, and stays silent on decrypt failure', async () => {
    webRemote._internal.resetE2e()
    webRemote.__test.setWs(fakeWs)
    const a = generateE2EKeyPair()
    const key = deriveSessionKey(a.e2ePrivateKey, kp.publicKey.toString('base64url'), deviceId)

    await box('connX', key, 'b1')
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('e2e:rekey')
    expect(sent[0].toConn).toBe('connX')
    expect(sent[0].payload).toEqual({ reason: 'no_session' })

    await box('connX', key, 'b2')
    expect(sent).toHaveLength(1)

    // Decrypt failure with a session key present: no rekey.
    await webRemote._internal.handleMessage(
      JSON.stringify({ type: 'e2e:hello', id: 'h', fromConn: 'connY', payload: { pubKey: a.e2ePublicKey } }), device)
    sent.length = 0
    const other = generateE2EKeyPair()
    const wrongKey = deriveSessionKey(other.e2ePrivateKey, kp.publicKey.toString('base64url'), deviceId)
    await box('connY', wrongKey, 'b3')
    expect(sent.filter((m) => m.type === 'e2e:rekey')).toHaveLength(0)
  })
})
