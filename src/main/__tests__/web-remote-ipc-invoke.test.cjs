'use strict';

/**
 * web-remote-ipc-invoke.test.cjs — batched ipc:invoke envelope runs through the shared
 * dispatcher; results return as chunked, encrypted, unicast ipc:result frames.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-ipc-invoke.test.cjs
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { encryptBox, decryptBox } = require('../lib/feedback-remote/remoteE2eCrypto.cjs')

let tmpHome
let origHome
let webRemote
let configPath

function genP256() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  return { priv: privateKey.toString('base64url'), pub: publicKey.toString('base64url') }
}

async function writeConfig(cfg) {
  await fsp.mkdir(path.dirname(configPath), { recursive: true })
  await fsp.writeFile(configPath, JSON.stringify(cfg, null, 2) + '\n')
}

beforeAll(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-remote-ipc-invoke-'))
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
  webRemote.registerRemoteHandlers()
})

afterAll(async () => {
  process.env.HOME = origHome
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

describe('web-remote ipc:invoke', () => {
  const dk = genP256()
  const device = {
    deviceId: 'device-ipc', deviceToken: 'tok', e2ePrivateKey: dk.priv, e2ePublicKey: dk.pub,
    deviceName: 'Ipc', issuedAt: new Date(0).toISOString(), lastConnectedAt: null, verifiedPeerPubKey: null,
  }
  const key = crypto.randomBytes(32)
  const sent = []
  const fakeWs = { readyState: 1, send: (m) => sent.push(JSON.parse(m)), terminate: () => {} }
  const big = 'x'.repeat(600 * 1024)

  const calls = []
  const surface = [
    { channel: 'app:version', kind: 'invoke', remote: 'read' },
    { channel: 'big:read', kind: 'invoke', remote: 'read' },
    { channel: 'thing:write', kind: 'invoke', remote: 'mutate' },
  ]
  const handlers = new Map([
    ['app:version', async () => '1.2.3'],
    ['big:read', async () => big],
    ['thing:write', async (_e, v) => { calls.push(v); return 'written' }],
  ])
  const { createRemoteIpcDispatcher, joinFrames } = require('../lib/feedback-remote/remoteIpcDispatch.cjs')

  const send = (conn, k, inner) => {
    const { nonce, ciphertext } = encryptBox(JSON.stringify(inner), k)
    return webRemote._internal.handleMessage(
      JSON.stringify({ type: 'e2e:box', id: inner.id, fromConn: conn, payload: { nonce, ciphertext } }), device)
  }
  const invoke = (id, callList, conn = 'connA') =>
    send(conn, key, { type: 'ipc:invoke', id, payload: { calls: callList }, ts: 1 })
  const results = (k = key) => sent.map((m) => {
    expect(m.type).toBe('e2e:box')
    return JSON.parse(decryptBox(m.payload.nonce, m.payload.ciphertext, k))
  })
  const readAudit = async () => {
    const out = []
    const walk = async (d) => {
      for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const f = path.join(d, e.name)
        if (e.isDirectory()) await walk(f)
        else if (/remote-audit-.*\.log$/.test(e.name)) out.push(await fsp.readFile(f, 'utf8'))
      }
    }
    await walk(tmpHome)
    return out.join('\n')
  }

  async function setup(cfg, state = 'authenticated') {
    await fsp.mkdir(path.join(tmpHome, '.claude', 'session-manager', 'logs'), { recursive: true })
    await writeConfig({ remoteEnabled: true, remoteControlEnabled: false, devices: [device], ...cfg })
    webRemote.__test.invalidateConfigCache()
    webRemote._internal.resetE2e()
    webRemote.__test.setWs(fakeWs)
    webRemote.__test.setE2eAuthenticated(key, 'connA')
    if (state !== 'authenticated') webRemote.__test.getClient('connA').e2e.state = state
    webRemote.setIpcDispatcher(createRemoteIpcDispatcher({
      surface, handlers, getConfig: () => webRemote.loadConfig(),
      fenceCtx: { homeDir: tmpHome, realpath: (p) => p, projectRoots: () => [] },
    }))
    sent.length = 0
    calls.length = 0
  }

  it('authenticated read returns an ok ipc:result unicast to the caller', async () => {
    await setup()
    await invoke('r1', [{ channel: 'app:version', args: [] }])
    const [r] = results()
    expect(sent[0].toConn).toBe('connA')
    expect(r).toMatchObject({ type: 'ipc:result', id: 'r1.0', seq: 0, total: 1 })
    expect(JSON.parse(r.data)).toEqual({ ok: true, result: '1.2.3' })
    expect(await readAudit()).toMatch(/ipc:app:version\s+deviceId=device-ipc\s+client=connA\s+msgId=r1\s+result=ok/)
  })

  it('refuses when the client is not authenticated', async () => {
    await setup({}, 'pending_sas')
    await invoke('u1', [{ channel: 'app:version', args: [] }])
    const [r] = results()
    expect(JSON.parse(r.data)).toEqual({ ok: false, error: 'rejected' })
    expect(await readAudit()).toMatch(/ipc:app:version .*msgId=u1\s+result=refused:e2e_not_authenticated/)
  })

  it('refuses mutate while remoteControlEnabled is false, allows it when true', async () => {
    await setup()
    await invoke('m1', [{ channel: 'thing:write', args: [1] }])
    expect(JSON.parse(results()[0].data).ok).toBe(false)
    expect(calls).toEqual([])
    expect(await readAudit()).toMatch(/msgId=m1\s+result=refused:mutate_not_allowed/)
    await setup({ remoteControlEnabled: true })
    await invoke('m2', [{ channel: 'thing:write', args: [2] }])
    expect(JSON.parse(results()[0].data)).toEqual({ ok: true, result: 'written' })
    expect(calls).toEqual([2])
  })

  it('returns one result per call in a 3-call batch', async () => {
    await setup()
    await invoke('b1', [{ channel: 'app:version' }, { channel: 'app:version', args: [] }, { channel: 'nope:x', args: [] }])
    const rs = results()
    expect(rs.map((r) => r.id)).toEqual(['b1.0', 'b1.1', 'b1.2'])
    expect(rs.map((r) => JSON.parse(r.data).ok)).toEqual([true, true, false])
  })

  it('chunks a 600 KB result into frames under 180 KB that join back', async () => {
    await setup()
    await invoke('c1', [{ channel: 'big:read', args: [] }])
    const rs = results()
    expect(rs.length).toBeGreaterThan(1)
    for (const r of rs) expect(Buffer.byteLength(r.data)).toBeLessThan(180000)
    expect(joinFrames(rs.map(({ seq, total, data }) => ({ seq, total, data })))).toEqual({ ok: true, result: big })
  })

  it('rejects malformed payloads opaquely', async () => {
    await setup()
    for (const payload of [undefined, {}, { calls: [] }, { calls: [{ channel: 5 }] },
      { calls: Array.from({ length: 51 }, () => ({ channel: 'app:version' })) }]) {
      sent.length = 0
      await send('connA', key, { type: 'ipc:invoke', id: 'bad', payload, ts: 1 })
      expect(results()[0].payload).toEqual({ error: 'rejected' })
    }
  })

  it('drops a plaintext ipc:invoke once an e2e session is active', async () => {
    await setup()
    await webRemote._internal.handleMessage(JSON.stringify({
      type: 'ipc:invoke', id: 'p1', fromConn: 'connA', payload: { calls: [{ channel: 'app:version' }] },
    }), device)
    expect(sent).toHaveLength(0)
  })
})
