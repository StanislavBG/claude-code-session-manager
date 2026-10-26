'use strict'

/**
 * web-remote-assets.test.cjs — asset:manifest / asset:get over the E2E channel.
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-assets.test.cjs
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { encryptBox, decryptBox } = require('../lib/feedback-remote/remoteE2eCrypto.cjs')
const { joinFrames } = require('../lib/feedback-remote/remoteIpcDispatch.cjs')
const remoteAssets = require('../lib/feedback-remote/remoteAssets.cjs')

let tmpHome, origHome, webRemote, configPath, distDir
const oneMb = crypto.randomBytes(1024 * 1024)

function genP256() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  return { priv: privateKey.toString('base64url'), pub: publicKey.toString('base64url') }
}

beforeAll(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-remote-assets-'))
  origHome = process.env.HOME
  process.env.HOME = tmpHome
  distDir = path.join(tmpHome, 'dist-web')
  await fsp.mkdir(distDir)
  await fsp.writeFile(path.join(distDir, 'index.html'), '<html>hi</html>')
  await fsp.writeFile(path.join(distDir, 'big.bin'), oneMb)
  await fsp.writeFile(path.join(tmpHome, 'secret.txt'), 'secret')
  remoteAssets.__test.setRoot(distDir)
  const electronPath = require.resolve('electron')
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { ipcMain: { handle: () => {}, on: () => {} }, app: { getPath: () => tmpHome, getVersion: () => '0.0.0-test' } },
  }
  for (const mod of ['../webRemote.cjs', '../config.cjs', '../logs.cjs']) {
    try { delete require.cache[require.resolve(mod)] } catch { /* not loaded */ }
  }
  webRemote = require('../webRemote.cjs')
  configPath = path.join(tmpHome, '.claude', 'session-manager', 'web-remote.json')
  webRemote.registerRemoteHandlers()
})

afterAll(async () => {
  remoteAssets.__test.setRoot(null)
  process.env.HOME = origHome
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

describe('remoteAssets', () => {
  it('manifest hashes match file contents', () => {
    const m = remoteAssets.assetManifest()
    expect(m.available).toBe(true)
    expect(m.files.map((f) => f.name)).toEqual(['big.bin', 'index.html'])
    const big = m.files.find((f) => f.name === 'big.bin')
    expect(big.size).toBe(oneMb.length)
    expect(big.sha256).toBe(crypto.createHash('sha256').update(oneMb).digest('hex'))
    expect(m.files.find((f) => f.name === 'index.html').type).toBe('text/html')
  })

  it('refuses traversal, absolute and nested names', () => {
    for (const n of ['../package.json', '../secret.txt', path.join(tmpHome, 'secret.txt'), 'a/b', '..', '', null, 'x\\y']) {
      expect(remoteAssets.readAsset(n).ok).toBe(false)
    }
  })

  it('refuses a symlink escaping dist-web', async () => {
    await fsp.symlink(path.join(tmpHome, 'secret.txt'), path.join(distDir, 'link.txt'))
    expect(remoteAssets.readAsset('link.txt').ok).toBe(false)
    expect(remoteAssets.assetManifest().files.some((f) => f.name === 'link.txt')).toBe(false)
    await fsp.rm(path.join(distDir, 'link.txt'))
  })

  it('missing dir gives available:false', () => {
    remoteAssets.__test.setRoot(path.join(tmpHome, 'nope'))
    expect(remoteAssets.assetManifest()).toMatchObject({ available: false, files: [] })
    expect(remoteAssets.readAsset('index.html').ok).toBe(false)
    remoteAssets.__test.setRoot(distDir)
  })
})

describe('web-remote asset frames', () => {
  const dk = genP256()
  const device = {
    deviceId: 'device-assets', deviceToken: 'tok', e2ePrivateKey: dk.priv, e2ePublicKey: dk.pub,
    deviceName: 'A', issuedAt: new Date(0).toISOString(), lastConnectedAt: null, verifiedPeerPubKey: null,
  }
  const key = crypto.randomBytes(32)
  const sent = []
  const fakeWs = { readyState: 1, send: (m) => sent.push(JSON.parse(m)), terminate: () => {} }

  async function setup(state = 'authenticated') {
    await fsp.mkdir(path.dirname(configPath), { recursive: true })
    await fsp.writeFile(configPath, JSON.stringify({ remoteEnabled: true, remoteControlEnabled: false, devices: [device] }))
    await fsp.mkdir(path.join(tmpHome, '.claude', 'session-manager', 'logs'), { recursive: true })
    webRemote.__test.invalidateConfigCache()
    webRemote._internal.resetE2e()
    webRemote.__test.setWs(fakeWs)
    webRemote.__test.setE2eAuthenticated(key, 'connA')
    if (state !== 'authenticated') webRemote.__test.getClient('connA').e2e.state = state
    sent.length = 0
  }
  const send = (inner) => {
    const { nonce, ciphertext } = encryptBox(JSON.stringify(inner), key)
    return webRemote._internal.handleMessage(
      JSON.stringify({ type: 'e2e:box', id: inner.id, fromConn: 'connA', payload: { nonce, ciphertext } }), device)
  }
  const decoded = () => sent.map((m) => JSON.parse(decryptBox(m.payload.nonce, m.payload.ciphertext, key)))

  it('refuses unauthenticated clients', async () => {
    await setup('pending_sas')
    await send({ type: 'asset:manifest', id: 'a0', ts: 1 })
    const [r] = decoded()
    expect(r.payload).toEqual({ error: 'rejected' })
    expect(JSON.stringify(sent)).not.toContain('index.html')
  })

  it('serves the manifest unicast', async () => {
    await setup()
    await send({ type: 'asset:manifest', id: 'a1', ts: 1 })
    expect(sent[0].toConn).toBe('connA')
    const v = joinFrames(decoded().map(({ seq, total, data }) => ({ seq, total, data: JSON.parse(JSON.stringify(data)) })).map((f) => ({ ...f })))
    expect(v.ok).toBe(true)
    expect(v.result.available).toBe(true)
  })

  it('refuses traversal names', async () => {
    await setup()
    await send({ type: 'asset:get', id: 'a2', payload: { name: '../package.json' }, ts: 1 })
    const v = joinFrames(decoded())
    expect(v).toEqual({ ok: false, error: 'rejected' })
  })

  it('round-trips a 1 MB asset through frames', async () => {
    await setup()
    await send({ type: 'asset:get', id: 'a3', payload: { name: 'big.bin' }, ts: 1 })
    const rs = decoded()
    expect(rs.length).toBeGreaterThan(1)
    const v = joinFrames(rs)
    expect(v.ok).toBe(true)
    expect(Buffer.from(v.result.data, 'base64').equals(oneMb)).toBe(true)
    expect(v.result.sha256).toBe(crypto.createHash('sha256').update(oneMb).digest('hex'))
  })
})
