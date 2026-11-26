'use strict';

/**
 * web-remote-service-clients.test.cjs — a paired service (role:'service' in e2e:hello)
 * authenticates by pinned key or a pending pairing + SAS, may send only boxed cmd:mcp
 * (answered by a boxed mcp:result), and is torn down on disconnect / kill switch.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-service-clients.test.cjs
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { generateE2EKeyPair, deriveSessionKey, deriveSas, encryptBox, decryptBox } = require('../lib/feedback-remote/remoteE2eCrypto.cjs')
const { createServicePairings } = require('../lib/feedback-remote/servicePairings.cjs')
const { ALLOWED_COMMANDS } = require('../ipcSchemas.cjs')

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

function freshRequire(mod) {
  delete require.cache[require.resolve(mod)]
  return require(mod)
}

async function writeConfig(cfg) {
  await fsp.mkdir(path.dirname(configPath), { recursive: true })
  await fsp.writeFile(configPath, JSON.stringify(cfg, null, 2) + '\n')
}

async function readConfig() {
  return JSON.parse(await fsp.readFile(configPath, 'utf8'))
}

async function readAudit() {
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

beforeAll(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-remote-service-clients-'))
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
  webRemote = freshRequire('../webRemote.cjs')
  configPath = path.join(tmpHome, '.claude', 'session-manager', 'web-remote.json')
  await fsp.mkdir(path.join(tmpHome, '.claude', 'session-manager', 'logs'), { recursive: true })
  webRemote.registerRemoteHandlers()
})

afterAll(async () => {
  process.env.HOME = origHome
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

const deviceKeys = genP256KeyPairB64()
const deviceId = 'device-svc'
const device = {
  deviceId, deviceToken: 'tok', e2ePrivateKey: deviceKeys.priv, e2ePublicKey: deviceKeys.pub,
  deviceName: 'Svc', issuedAt: new Date(0).toISOString(), lastConnectedAt: null, verifiedPeerPubKey: null,
}
const sent = []
const fakeWs = { readyState: 1, send: (m) => sent.push(JSON.parse(m)), terminate: () => {} }
let store
let clock
let invokeCalls

const HOME_CWD = '/home/test/kiln'
const RELAY_ID = '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b'

async function setup({ enabled = true } = {}) {
  await writeConfig({ remoteEnabled: enabled, remoteControlEnabled: false, devices: [device] })
  webRemote.__test.invalidateConfigCache()
  webRemote._internal.resetE2e()
  webRemote.__test.setWs(fakeWs)
  clock = 1_000_000
  store = createServicePairings({ filePath: path.join(tmpHome, `svc-${crypto.randomUUID()}.json`), now: () => clock })
  webRemote.__test.setServiceStore(store)
  invokeCalls = []
  webRemote.setServiceInvoker(async (method, routePath, opts) => {
    invokeCalls.push({ method, routePath, opts })
    return { status: 200, json: { ok: true, projects: [{ cwd: HOME_CWD }] } }
  })
  sent.length = 0
}

async function pairedService(scope = ['feedback_list_projects']) {
  const kp = generateE2EKeyPair()
  const { pairingId } = await store.createPending({ name: 'Kiln', homeCwd: HOME_CWD, scope })
  const svc = await store.confirmPending(pairingId, kp.e2ePublicKey, { relayClientId: RELAY_ID })
  return { kp, svc }
}

const hello = (conn, pub, extra = {}) => webRemote._internal.handleMessage(JSON.stringify({
  type: 'e2e:hello', id: `h-${conn}`, fromConn: conn, payload: { pubKey: pub, ...extra },
}), device)

const boxed = (conn, key, inner) => {
  const { nonce, ciphertext } = encryptBox(JSON.stringify(inner), key)
  return webRemote._internal.handleMessage(JSON.stringify({
    type: 'e2e:box', id: inner.id, fromConn: conn, payload: { nonce, ciphertext },
  }), device)
}

const sessionKeyOf = (kp) => deriveSessionKey(kp.e2ePrivateKey, deviceKeys.pub, deviceId)

/** Decrypt every boxed frame sent to `conn` with `key`. */
function openBoxes(conn, key) {
  return sent
    .filter((m) => m.type === 'e2e:box' && m.toConn === conn)
    .map((m) => JSON.parse(decryptBox(m.payload.nonce, m.payload.ciphertext, key)))
}

const mcpCall = (id, name, args = {}) => ({
  type: 'cmd:mcp', id, ts: 1,
  payload: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } },
})

beforeEach(() => { sent.length = 0 })

describe('paired service clients', () => {
  it('pinned key authenticates at once, touches lastSeen, and answers cmd:mcp with a boxed mcp:result', async () => {
    await setup()
    const { kp, svc } = await pairedService()
    clock += 5000
    await hello('svcA', kp.e2ePublicKey, { role: 'service', clientId: RELAY_ID })
    expect(webRemote._internal.getE2eState('svcA').state).toBe('authenticated')
    const client = webRemote.__test.getClient('svcA')
    expect(client.service.serviceId).toBe(svc.serviceId)
    expect(client.relayClientId).toBe(RELAY_ID)
    await new Promise((r) => setTimeout(r, 20))
    expect(store.list()[0].lastSeenAt).toBe(clock)
    // A service key never becomes a device pin.
    expect(JSON.stringify((await readConfig()).devices)).not.toContain(kp.e2ePublicKey)

    sent.length = 0
    const key = sessionKeyOf(kp)
    await boxed('svcA', key, mcpCall('m1', 'feedback_list_projects', { secretArg: 'do-not-log-me' }))
    expect(invokeCalls).toHaveLength(1)
    const [reply] = openBoxes('svcA', key)
    expect(reply.type).toBe('mcp:result')
    expect(reply.id).toBe('m1')
    expect(reply.payload.jsonrpc).toBe('2.0')
    expect(reply.payload.id).toBe(7)
    expect(reply.payload.result.content[0].text).toContain(HOME_CWD)
    const audit = await readAudit()
    expect(audit).toMatch(/mcp:feedback_list_projects\s+deviceId=device-svc\s+client=svcA\s+msgId=m1\s+result=ok/)
    expect(audit).not.toContain('do-not-log-me')
  })

  it('pending pairing makes it pending_sas, keeps a UUID clientId, and confirmServiceSas pins it', async () => {
    await setup()
    const { pairingId } = await store.createPending({ name: 'Kiln', homeCwd: HOME_CWD, scope: ['macro_list'] })
    const kp = generateE2EKeyPair()
    await hello('svcP', kp.e2ePublicKey, { role: 'service', clientId: RELAY_ID })
    expect(webRemote._internal.getE2eState('svcP').state).toBe('pending_sas')
    const client = webRemote.__test.getClient('svcP')
    expect(client.pendingPairingId).toBe(pairingId)
    expect(client.relayClientId).toBe(RELAY_ID)
    expect(sent.some((m) => m.type === 'e2e:ready' && m.toConn === 'svcP')).toBe(true)

    // The phone confirm path never picks up a service client.
    expect(await handlers.get('webRemote:confirm-sas')({}, undefined)).toEqual({ ok: false, error: 'no_e2e_session' })
    expect(await handlers.get('webRemote:confirm-sas')({}, { clientKey: 'svcP' })).toEqual({ ok: false, error: 'no_e2e_session' })

    // cmd:mcp before confirmation is refused.
    const key = sessionKeyOf(kp)
    sent.length = 0
    await boxed('svcP', key, mcpCall('p1', 'macro_list'))
    expect(invokeCalls).toHaveLength(0)
    expect(openBoxes('svcP', key)).toEqual([expect.objectContaining({ type: 'resp:p1', payload: { error: 'rejected' } })])

    const sas = deriveSas(kp.e2ePrivateKey, deviceKeys.pub, deviceId)
    const wrong = sas === '000000' ? '111111' : '000000'
    expect(await webRemote.confirmServiceSas(pairingId, wrong)).toEqual({ ok: false, error: 'sas_mismatch' })
    const ok = await webRemote.confirmServiceSas(pairingId, sas)
    expect(ok.ok).toBe(true)
    expect(webRemote._internal.getE2eState('svcP').state).toBe('authenticated')
    const pinned = store.findByPubKey(kp.e2ePublicKey)
    expect(pinned).toBeTruthy()
    expect(pinned.relayClientId).toBe(RELAY_ID)
    expect(store.listPending()).toEqual([])
    expect(JSON.stringify((await readConfig()).devices)).not.toContain(kp.e2ePublicKey)
  })

  it('service-pair-cancel drops the pending pairing and its waiting client; a re-hello is refused', async () => {
    await setup()
    const { pairingId } = await store.createPending({ name: 'Kiln', homeCwd: HOME_CWD, scope: ['macro_list'] })
    const kp = generateE2EKeyPair()
    await hello('svcC', kp.e2ePublicKey, { role: 'service', clientId: RELAY_ID, pairingId })
    expect(webRemote._internal.getE2eState('svcC').state).toBe('pending_sas')

    const cancel = handlers.get('webRemote:service-pair-cancel')
    await expect(async () => cancel({}, { pairingId: 'not-a-uuid' })).rejects.toThrow()
    expect(await cancel({}, { pairingId })).toEqual({ ok: true, cancelled: true, dropped: 1 })
    expect(store.listPending()).toEqual([])
    // The waiting client is gone: no session left, SAS can't be confirmed.
    expect(webRemote._internal.getE2eState('svcC').state).toBe('idle')
    const sas = deriveSas(kp.e2ePrivateKey, deviceKeys.pub, deviceId)
    expect(await webRemote.confirmServiceSas(pairingId, sas)).toEqual({ ok: false, error: 'no_pending_service' })
    expect(store.findByPubKey(kp.e2ePublicKey)).toBe(null)
    expect(await readAudit()).toMatch(/service:pair-cancelled\s+deviceId=device-svc.*result=ok:dropped=1/)

    // A later hello for the cancelled pairing is refused.
    await hello('svcC2', kp.e2ePublicKey, { role: 'service', clientId: RELAY_ID, pairingId })
    expect(webRemote._internal.getE2eState('svcC2').state).toBe('failed')
    expect(await readAudit()).toMatch(/service:unpaired\s+deviceId=device-svc\s+client=svcC2\s+msgId=h-svcC2\s+result=refused/)

    // Cancelling again is a no-op.
    expect(await cancel({}, { pairingId })).toEqual({ ok: true, cancelled: false, dropped: 0 })
  })

  it('service-pair-cancel with no paired device audits deviceId=-, never undefined', async () => {
    await setup()
    await writeConfig({ remoteEnabled: true, remoteControlEnabled: false, devices: [] })
    webRemote.__test.invalidateConfigCache()
    const cancel = handlers.get('webRemote:service-pair-cancel')
    const pairingId = crypto.randomUUID()
    expect(await cancel({}, { pairingId })).toEqual({ ok: true, cancelled: false, dropped: 0 })
    const audit = await readAudit()
    expect(audit).toMatch(/service:pair-cancelled\s+deviceId=-\s+client=-\s+msgId=-\s+result=noop:dropped=0/)
    expect(audit).not.toMatch(/deviceId=undefined/)
  })

  it('drops a non-UUID clientId', async () => {
    await setup()
    await store.createPending({ name: 'Kiln', homeCwd: HOME_CWD, scope: ['macro_list'] })
    const kp = generateE2EKeyPair()
    await hello('svcQ', kp.e2ePublicKey, { role: 'service', clientId: 'not-a-uuid' })
    expect(webRemote._internal.getE2eState('svcQ').state).toBe('pending_sas')
    expect(webRemote.__test.getClient('svcQ').relayClientId).toBe(null)
  })

  it('an unpaired service is refused, audited and failed', async () => {
    await setup()
    const kp = generateE2EKeyPair()
    await hello('svcU', kp.e2ePublicKey, { role: 'service' })
    expect(webRemote._internal.getE2eState('svcU').state).toBe('failed')
    expect(webRemote.__test.getClient('svcU').role).toBe(null)
    expect(await readAudit()).toMatch(/service:unpaired\s+deviceId=device-svc\s+client=svcU\s+msgId=h-svcU\s+result=refused/)
  })

  it('refuses tools outside scope and any non-mcp command from a service', async () => {
    await setup()
    const { kp } = await pairedService(['macro_list'])
    await hello('svcS', kp.e2ePublicKey, { role: 'service' })
    const key = sessionKeyOf(kp)
    sent.length = 0
    await boxed('svcS', key, mcpCall('s1', 'feedback_open_session', { toCwd: '/x' }))
    expect(invokeCalls).toHaveLength(0)
    const [reply] = openBoxes('svcS', key)
    expect(reply.type).toBe('mcp:result')
    expect(reply.payload.error.code).toBe(-32001)
    expect(await readAudit()).toMatch(/mcp:feedback_open_session\s+deviceId=device-svc\s+client=svcS\s+msgId=s1\s+result=refused:scope/)

    sent.length = 0
    await boxed('svcS', key, { type: 'cmd:projects:list', id: 's2', payload: {}, ts: 1 })
    await boxed('svcS', key, { type: 'ipc:invoke', id: 's3', payload: { calls: [{ channel: 'x', args: [] }] }, ts: 1 })
    const replies = openBoxes('svcS', key)
    expect(replies.map((r) => [r.type, r.payload])).toEqual([
      ['resp:s2', { error: 'rejected' }],
      ['resp:s3', { error: 'rejected' }],
    ])
    const audit = await readAudit()
    expect(audit).toMatch(/cmd:projects:list\s+deviceId=device-svc\s+client=svcS\s+msgId=s2\s+result=refused:service_not_allowed/)
    expect(audit).toMatch(/ipc:invoke\s+deviceId=device-svc\s+client=svcS\s+msgId=s3\s+result=refused:service_not_allowed/)
  })

  it('a phone client sending cmd:mcp gets the opaque reject', async () => {
    await setup()
    expect(ALLOWED_COMMANDS.has('cmd:mcp')).toBe(false)
    const phoneKey = crypto.randomBytes(32)
    webRemote.__test.setE2eAuthenticated(phoneKey, 'phone1')
    await boxed('phone1', phoneKey, mcpCall('ph1', 'feedback_list_projects'))
    expect(invokeCalls).toHaveLength(0)
    expect(openBoxes('phone1', phoneKey)).toEqual([expect.objectContaining({ type: 'resp:ph1', payload: { error: 'rejected' } })])
    expect(await readAudit()).toMatch(/cmd:mcp\s+deviceId=device-svc\s+client=phone1\s+msgId=ph1\s+result=error:not_service/)
  })

  it('kill switch refuses service commands', async () => {
    await setup()
    const { kp } = await pairedService()
    await hello('svcK', kp.e2ePublicKey, { role: 'service' })
    expect(webRemote._internal.getE2eState('svcK').state).toBe('authenticated')
    await writeConfig({ remoteEnabled: false, remoteControlEnabled: false, devices: [device] })
    webRemote.__test.invalidateConfigCache()
    const key = sessionKeyOf(kp)
    sent.length = 0
    await boxed('svcK', key, mcpCall('k1', 'feedback_list_projects'))
    expect(invokeCalls).toHaveLength(0)
    expect(openBoxes('svcK', key)).toEqual([expect.objectContaining({ type: 'resp:k1', payload: { error: 'rejected' } })])
    expect(await readAudit()).toMatch(/cmd:mcp\s+deviceId=device-svc\s+client=svcK\s+msgId=k1\s+result=error:disabled/)
  })

  it('a revoked service is refused and torn down', async () => {
    await setup()
    const { kp, svc } = await pairedService()
    await hello('svcR', kp.e2ePublicKey, { role: 'service' })
    await store.revoke(svc.serviceId)
    await boxed('svcR', sessionKeyOf(kp), mcpCall('r1', 'feedback_list_projects'))
    expect(invokeCalls).toHaveLength(0)
    expect(webRemote._internal.getE2eState('svcR').state).toBe('idle')
  })

  it('event:client:disconnected tears the service down, token_revoked included', async () => {
    await setup()
    const { kp } = await pairedService()
    for (const [conn, reason] of [['svcD1', 'closed'], ['svcD2', 'token_revoked']]) {
      await hello(conn, kp.e2ePublicKey, { role: 'service' })
      expect(webRemote._internal.getE2eState(conn).state).toBe('authenticated')
      await webRemote._internal.handleMessage(JSON.stringify({
        type: 'event:client:disconnected', fromConn: conn, reason,
      }), device)
      expect(webRemote._internal.getE2eState(conn).state).toBe('idle')
    }
    // After teardown a box from that connection carries no session.
    sent.length = 0
    await boxed('svcD2', sessionKeyOf(kp), mcpCall('d1', 'feedback_list_projects'))
    expect(invokeCalls).toHaveLength(0)
    expect(sent.map((m) => m.type)).toEqual(['e2e:rekey'])
  })

  it('local pairing: confirmServiceSasLocal pins a local pending pairing, refuses window ones and wrong SAS', async () => {
    await setup()
    const { pairingId } = await store.createPending({ name: 'Kiln', homeCwd: HOME_CWD, scope: ['macro_list'], pairedVia: 'local' })
    const kp = generateE2EKeyPair()
    await hello('svcL', kp.e2ePublicKey, { role: 'service', clientId: RELAY_ID })
    const sas = deriveSas(kp.e2ePrivateKey, deviceKeys.pub, deviceId)
    const wrong = sas === '000000' ? '111111' : '000000'
    expect(await webRemote.confirmServiceSasLocal(pairingId, wrong)).toEqual({ ok: false, error: 'sas_mismatch' })
    const ok = await webRemote.confirmServiceSasLocal(pairingId, sas)
    expect(ok.ok).toBe(true)
    expect(ok.service.pairedVia).toBe('local')
    expect(store.findByPubKey(kp.e2ePublicKey).pairedVia).toBe('local')
    expect(await readAudit()).toMatch(/service:confirm-sas.*result=ok:paired-locally:service=/)
    // revoke works the same for a local pairing
    expect(store.findByPubKey(kp.e2ePublicKey)).toBeTruthy()
    const r = await handlers.get('webRemote:service-revoke')({}, { serviceId: ok.service.serviceId })
    expect(r.ok).toBe(true)
    expect(store.findByPubKey(kp.e2ePublicKey)).toBe(null)
  })

  it('confirmServiceSasLocal refuses a window pairing; both local functions refuse when remote is off', async () => {
    await setup()
    const { pairingId } = await store.createPending({ name: 'Kiln', homeCwd: HOME_CWD, scope: ['macro_list'] })
    const kp = generateE2EKeyPair()
    await hello('svcW', kp.e2ePublicKey, { role: 'service', clientId: RELAY_ID })
    const sas = deriveSas(kp.e2ePrivateKey, deviceKeys.pub, deviceId)
    expect(await webRemote.confirmServiceSasLocal(pairingId, sas)).toEqual({ ok: false, error: 'not_local_pairing' })
    expect(await webRemote.confirmServiceSasLocal('missing', sas)).toEqual({ ok: false, error: 'not_local_pairing' })
    expect((await webRemote.confirmServiceSas(pairingId, sas)).service.pairedVia).toBe('window')

    await writeConfig({ remoteEnabled: false, remoteControlEnabled: false, devices: [device] })
    webRemote.__test.invalidateConfigCache()
    expect(await webRemote.servicePairStartLocal({ name: 'K', homeCwd: HOME_CWD, scope: ['macro_list'] })).toEqual({ ok: false, error: 'web_remote_off' })
    expect(await webRemote.confirmServiceSasLocal(pairingId, sas)).toEqual({ ok: false, error: 'web_remote_off' })
    expect(store.listPending()).toEqual([])
  })
})
