'use strict';

/**
 * web-remote-service-ipc.test.cjs — renderer IPC for paired services:
 * services-list (redacted + relay orphans), service-pair-start (relay client-otp
 * + pending pairing, error mapping), service-confirm-sas, service-revoke (relay
 * DELETE, 404 = gone), relay-client-revoke, and revokeAllDevices clearing services.
 * https.request is stubbed — no network.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-service-ipc.test.cjs
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const https = require('node:https')
const { EventEmitter } = require('node:events')
const { generateE2EKeyPair, deriveSas } = require('../lib/feedback-remote/remoteE2eCrypto.cjs')
const { createServicePairings } = require('../lib/feedback-remote/servicePairings.cjs')

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
let origRequest
let logsMod
const logLines = []

/** Queue of relay replies keyed by `${method} ${path}`; each call records itself. */
const relayReplies = new Map()
const relayCalls = []

function stubRelay(method, p, status, json) {
  relayReplies.set(`${method} ${p}`, { status, json })
}

function fakeRequest(opts, cb) {
  const req = new EventEmitter()
  let body = ''
  req.setTimeout = () => req
  req.write = (c) => { body += c }
  req.destroy = (e) => req.emit('error', e)
  req.end = () => {
    relayCalls.push({ method: opts.method, path: opts.path, hostname: opts.hostname, headers: opts.headers, body })
    const r = relayReplies.get(`${opts.method} ${opts.path}`)
    setImmediate(() => {
      if (!r) { req.emit('error', new Error('ECONNREFUSED')); return }
      const res = new EventEmitter()
      res.statusCode = r.status
      cb(res)
      if (r.json !== undefined) res.emit('data', typeof r.json === 'string' ? r.json : JSON.stringify(r.json))
      res.emit('end')
    })
  }
  return req
}

beforeAll(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-remote-service-ipc-'))
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
  origRequest = https.request
  https.request = fakeRequest
  logsMod = require('../logs.cjs')
  const origWrite = logsMod.writeLine
  logsMod.writeLine = (entry) => { logLines.push(JSON.stringify(entry)); try { return origWrite(entry) } catch { return undefined } }
  webRemote = require('../webRemote.cjs')
  configPath = path.join(tmpHome, '.claude', 'session-manager', 'web-remote.json')
  await fsp.mkdir(path.join(tmpHome, '.claude', 'session-manager', 'logs'), { recursive: true })
  webRemote.registerRemoteHandlers()
})

afterAll(async () => {
  https.request = origRequest
  process.env.HOME = origHome
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

const deviceKeys = genP256KeyPairB64()
const deviceId = '6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab'
const DEVICE_TOKEN = 'device-token-secret-xyz'
const device = {
  deviceId, deviceToken: DEVICE_TOKEN, e2ePrivateKey: deviceKeys.priv, e2ePublicKey: deviceKeys.pub,
  deviceName: 'Svc', issuedAt: new Date(0).toISOString(), lastConnectedAt: null, verifiedPeerPubKey: null,
}
const sent = []
const fakeWs = { readyState: 1, send: (m) => sent.push(JSON.parse(m)), terminate: () => {}, removeAllListeners: () => {}, close: () => {} }
let store
const HOME_CWD = '/home/test/kiln'
const RELAY_ID = '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b'
const ORPHAN_ID = '2c5f39cb-3ab2-4e4c-b4a6-f02ac6b8744c'
const START = { name: 'Kiln', homeCwd: HOME_CWD, scope: ['feedback_list_projects', 'macro_list'] }

const call = (name, arg) => handlers.get(name)({}, arg)

async function setup({ devices = [device] } = {}) {
  await fsp.mkdir(path.dirname(configPath), { recursive: true })
  await fsp.writeFile(configPath, JSON.stringify({ remoteEnabled: true, remoteControlEnabled: false, devices }, null, 2) + '\n')
  webRemote.__test.invalidateConfigCache()
  webRemote._internal.resetE2e()
  webRemote.__test.setWs(fakeWs)
  store = createServicePairings({ filePath: path.join(tmpHome, `svc-${crypto.randomUUID()}.json`) })
  webRemote.__test.setServiceStore(store)
  relayReplies.clear()
  relayCalls.length = 0
  sent.length = 0
  logLines.length = 0
}

async function pairedService(relayClientId = RELAY_ID) {
  const kp = generateE2EKeyPair()
  const { pairingId } = await store.createPending({ name: 'Kiln', homeCwd: HOME_CWD, scope: ['macro_list'] })
  return store.confirmPending(pairingId, kp.e2ePublicKey, { relayClientId })
}

beforeEach(() => { relayCalls.length = 0 })

describe('webRemote:service-pair-start', () => {
  it('POSTs client-otp with the device token and creates a pending pairing', async () => {
    await setup()
    stubRelay('POST', '/api/sm-relay/client-otp', 200, { code: 'AB12CD34' })
    const before = Date.now()
    const r = await call('webRemote:service-pair-start', START)
    expect(r.ok).toBe(true)
    expect(r.code).toBe('AB12CD34')
    expect(r.deviceId).toBe(deviceId)
    expect(r.codeExpiresAt).toBeGreaterThanOrEqual(before + 5 * 60_000)
    expect(r.codeExpiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000)
    expect(relayCalls).toHaveLength(1)
    expect(relayCalls[0]).toMatchObject({ method: 'POST', hostname: 'bilko.run', path: '/api/sm-relay/client-otp' })
    expect(relayCalls[0].headers.Authorization).toBe(`Bearer ${DEVICE_TOKEN}`)
    const pending = store.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0].pairingId).toBe(r.pairingId)
    expect(pending[0].name).toBe('Kiln')
    expect(logLines.join('\n')).not.toContain(DEVICE_TOKEN)
    expect(logLines.join('\n')).not.toContain('AB12CD34')
  })

  it.each([
    [404, { error: 'not_found' }, 'relay_unsupported'],
    [405, undefined, 'relay_unsupported'],
    [401, { error: 'unauthorized' }, 'device_token_invalid'],
    [429, { error: 'too_many' }, 'rate_limited'],
    [500, { error: 'relay_exploded' }, 'relay_exploded'],
  ])('maps relay %s to %s and creates no pending pairing', async (status, json, error) => {
    await setup()
    stubRelay('POST', '/api/sm-relay/client-otp', status, json)
    expect(await call('webRemote:service-pair-start', START)).toEqual({ ok: false, error })
    expect(store.listPending()).toEqual([])
    expect(logLines.join('\n')).not.toContain(DEVICE_TOKEN)
  })

  it('needs a paired device', async () => {
    await setup({ devices: [] })
    expect(await call('webRemote:service-pair-start', START)).toEqual({ ok: false, error: 'no_paired_device' })
    expect(relayCalls).toHaveLength(0)
  })

  it('rejects invalid input via the schema', async () => {
    await setup()
    expect(() => call('webRemote:service-pair-start', { name: 'x' })).toThrow()
  })

  describe('projectRoot (project_create)', () => {
    const PC_SCOPE = ['macro_list', 'project_create']
    const STR_IN_HOME = () => path.join(os.homedir(), 'projects-root')

    it('passes projectRoot through to the pending pairing when project_create is in scope', async () => {
      await setup()
      const root = STR_IN_HOME()
      await fsp.mkdir(root, { recursive: true })
      stubRelay('POST', '/api/sm-relay/client-otp', 200, { code: 'AB12CD34' })
      const r = await call('webRemote:service-pair-start', { ...START, scope: PC_SCOPE, projectRoot: root })
      expect(r.ok).toBe(true)
      const pending = store.listPending()
      expect(pending).toHaveLength(1)
      expect(pending[0].projectRoot).toBe(root)
      stubRelay('GET', '/api/sm-relay/clients', 200, { clients: [] })
      const list = await call('webRemote:services-list')
      expect(list.pending[0].projectRoot).toBe(root)
    })

    it.each([
      ['missing', undefined],
      ['relative', 'projects-root'],
      ['not a directory', 'FILE'],
      ['nonexistent', 'NOPE'],
      ['outside the home folder', 'OUTSIDE'],
      ['the home folder parent via ..', 'DOTDOT'],
    ])('refuses projectRoot %s with the tool, before any relay call', async (_label, kind) => {
      await setup()
      let root = kind
      if (kind === 'FILE') {
        root = path.join(os.homedir(), 'a-file.txt')
        await fsp.writeFile(root, 'x')
      } else if (kind === 'NOPE') {
        root = path.join(os.homedir(), 'does-not-exist')
      } else if (kind === 'OUTSIDE') {
        root = os.tmpdir() === os.homedir() ? '/' : path.dirname(os.homedir())
      } else if (kind === 'DOTDOT') {
        root = path.join(os.homedir(), '..')
      }
      stubRelay('POST', '/api/sm-relay/client-otp', 200, { code: 'AB12CD34' })
      const arg = { ...START, scope: PC_SCOPE }
      if (root !== undefined) arg.projectRoot = root
      expect(await call('webRemote:service-pair-start', arg))
        .toEqual({ ok: false, error: 'projectRoot must be an existing folder in your home folder' })
      expect(relayCalls).toHaveLength(0)
      expect(store.listPending()).toEqual([])
    })

    it('refuses a symlink inside home that points outside it, before any relay call', async () => {
      await setup()
      const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-remote-outside-'))
      const link = path.join(os.homedir(), 'escape-link')
      try {
        await fsp.symlink(outside, link)
        stubRelay('POST', '/api/sm-relay/client-otp', 200, { code: 'AB12CD34' })
        expect(await call('webRemote:service-pair-start', { ...START, scope: PC_SCOPE, projectRoot: link }))
          .toEqual({ ok: false, error: 'projectRoot must be an existing folder in your home folder' })
        expect(relayCalls).toHaveLength(0)
        expect(store.listPending()).toEqual([])
      } finally {
        await fsp.rm(link, { force: true })
        await fsp.rm(outside, { recursive: true, force: true })
      }
    })

    it('drops projectRoot when project_create is not in scope', async () => {
      await setup()
      stubRelay('POST', '/api/sm-relay/client-otp', 200, { code: 'AB12CD34' })
      const r = await call('webRemote:service-pair-start', { ...START, projectRoot: '/not/even/real' })
      expect(r.ok).toBe(true)
      expect(store.listPending()[0].projectRoot).toBeNull()
      stubRelay('GET', '/api/sm-relay/clients', 200, { clients: [] })
      const list = await call('webRemote:services-list')
      expect(list.pending[0].projectRoot).toBeNull()
    })

    it('services-list rows carry projectRoot null when absent', async () => {
      await setup()
      await pairedService()
      stubRelay('GET', '/api/sm-relay/clients', 200, { clients: [] })
      const list = await call('webRemote:services-list')
      expect(list.services[0].projectRoot).toBeNull()
    })

    it('the strict schema accepts projectRoot and bounds its length', () => {
      const { schemas } = require('../ipcSchemas.cjs')
      const s = schemas.webRemoteServicePairStart
      expect(s.safeParse({ ...START, projectRoot: '/home/x/p' }).success).toBe(true)
      expect(s.safeParse(START).success).toBe(true)
      expect(s.safeParse({ ...START, projectRoot: '' }).success).toBe(false)
      expect(s.safeParse({ ...START, projectRoot: 'a'.repeat(4097) }).success).toBe(false)
      expect(s.safeParse({ ...START, extra: 1 }).success).toBe(false)
    })
  })
})

describe('webRemote:service-confirm-sas', () => {
  it('confirms a pending service SAS and returns a service without its key', async () => {
    await setup()
    stubRelay('POST', '/api/sm-relay/client-otp', 200, { code: 'AB12CD34' })
    const { pairingId } = await call('webRemote:service-pair-start', START)
    const kp = generateE2EKeyPair()
    await webRemote._internal.handleMessage(JSON.stringify({
      type: 'e2e:hello', id: 'h1', fromConn: 'svcC', payload: { pubKey: kp.e2ePublicKey, role: 'service', clientId: RELAY_ID, pairingId },
    }), device)
    expect(webRemote._internal.getE2eState('svcC').state).toBe('pending_sas')
    const sas = deriveSas(kp.e2ePrivateKey, deviceKeys.pub, deviceId)
    const wrong = sas === '000000' ? '111111' : '000000'
    expect(await call('webRemote:service-confirm-sas', { pairingId, sas: wrong })).toEqual({ ok: false, error: 'sas_mismatch' })
    const r = await call('webRemote:service-confirm-sas', { pairingId, sas })
    expect(r.ok).toBe(true)
    expect(r.service.name).toBe('Kiln')
    expect(r.service.relayClientId).toBe(RELAY_ID)
    expect(JSON.stringify(r)).not.toContain(kp.e2ePublicKey)
    expect(webRemote._internal.getE2eState('svcC').state).toBe('authenticated')
  })
})

describe('webRemote:services-list', () => {
  it('lists services and pending pairings without keys, plus relay orphans', async () => {
    await setup()
    const svc = await pairedService()
    await store.createPending({ name: 'Other', homeCwd: HOME_CWD, scope: ['macro_list'] })
    stubRelay('GET', '/api/sm-relay/clients', 200, {
      clients: [
        { clientId: RELAY_ID, clientName: 'Kiln', issuedAt: '2026-11-23T00:00:00Z', clientToken: 'leak-me' },
        { clientId: ORPHAN_ID, clientName: 'Old Kiln', issuedAt: '2026-11-01T00:00:00Z', clientToken: 'leak-me' },
      ],
    })
    const r = await call('webRemote:services-list')
    expect(r.ok).toBe(true)
    expect(r.services).toHaveLength(1)
    expect(r.services[0]).toMatchObject({ serviceId: svc.serviceId, name: 'Kiln', homeCwd: HOME_CWD, relayClientId: RELAY_ID })
    expect(r.services[0].pubKey).toBeUndefined()
    expect(r.pending).toHaveLength(1)
    expect(r.pending[0].name).toBe('Other')
    expect(r.relayOrphans).toEqual([{ clientId: ORPHAN_ID, clientName: 'Old Kiln', issuedAt: '2026-11-01T00:00:00Z' }])
    expect(r.relayError).toBeUndefined()
    const text = JSON.stringify(r)
    expect(text).not.toContain(svc.pubKey)
    expect(text).not.toContain('leak-me')
    expect(text).not.toContain(DEVICE_TOKEN)
    expect(relayCalls[0].headers.Authorization).toBe(`Bearer ${DEVICE_TOKEN}`)
  })

  it('reports relayError and no orphans when the relay fails', async () => {
    await setup()
    await pairedService()
    stubRelay('GET', '/api/sm-relay/clients', 404, { error: 'not_found' })
    const r = await call('webRemote:services-list')
    expect(r.ok).toBe(true)
    expect(r.services).toHaveLength(1)
    expect(r.relayOrphans).toEqual([])
    expect(r.relayError).toBe('relay_unsupported')
  })
})

describe('webRemote:service-revoke / relay-client-revoke', () => {
  it('removes the service, tears down its client and DELETEs the relay client', async () => {
    await setup()
    const svc = await pairedService()
    const pub = store.list()[0].pubKey
    await webRemote._internal.handleMessage(JSON.stringify({
      type: 'e2e:hello', id: 'h2', fromConn: 'svcR', payload: { pubKey: pub, role: 'service', clientId: RELAY_ID },
    }), device)
    expect(webRemote._internal.getE2eState('svcR').state).toBe('authenticated')
    stubRelay('DELETE', `/api/sm-relay/clients/${RELAY_ID}`, 200, { ok: true })
    const r = await call('webRemote:service-revoke', { serviceId: svc.serviceId })
    expect(r).toEqual({ ok: true, relayRevoked: true })
    expect(store.list()).toEqual([])
    expect(webRemote._internal.getE2eState('svcR').state).toBe('idle')
    const del = relayCalls.find((c) => c.method === 'DELETE')
    expect(del.path).toBe(`/api/sm-relay/clients/${RELAY_ID}`)
    expect(del.headers.Authorization).toBe(`Bearer ${DEVICE_TOKEN}`)
  })

  it('treats relay 404 client_not_found as gone', async () => {
    await setup()
    const svc = await pairedService()
    stubRelay('DELETE', `/api/sm-relay/clients/${RELAY_ID}`, 404, { error: 'client_not_found' })
    expect(await call('webRemote:service-revoke', { serviceId: svc.serviceId })).toEqual({ ok: true, relayRevoked: true })
    expect(store.list()).toEqual([])
  })

  it('still revokes locally when the relay DELETE fails', async () => {
    await setup()
    const svc = await pairedService()
    stubRelay('DELETE', `/api/sm-relay/clients/${RELAY_ID}`, 500, { error: 'boom' })
    expect(await call('webRemote:service-revoke', { serviceId: svc.serviceId })).toEqual({ ok: true, relayRevoked: false })
    expect(store.list()).toEqual([])
    expect(logLines.join('\n')).not.toContain(DEVICE_TOKEN)
  })

  it('skips the relay DELETE when the service has no relayClientId', async () => {
    await setup()
    const svc = await pairedService(null)
    expect(await call('webRemote:service-revoke', { serviceId: svc.serviceId })).toEqual({ ok: true, relayRevoked: false })
    expect(relayCalls).toHaveLength(0)
  })

  it('unknown serviceId is an error', async () => {
    await setup()
    expect(await call('webRemote:service-revoke', { serviceId: crypto.randomUUID() })).toEqual({ ok: false, error: 'no_such_service' })
  })

  it('relay-client-revoke DELETEs an orphan (404 client_not_found = ok)', async () => {
    await setup()
    stubRelay('DELETE', `/api/sm-relay/clients/${ORPHAN_ID}`, 200, { ok: true })
    expect(await call('webRemote:relay-client-revoke', { clientId: ORPHAN_ID })).toEqual({ ok: true })
    stubRelay('DELETE', `/api/sm-relay/clients/${ORPHAN_ID}`, 404, { error: 'client_not_found' })
    expect(await call('webRemote:relay-client-revoke', { clientId: ORPHAN_ID })).toEqual({ ok: true })
    stubRelay('DELETE', `/api/sm-relay/clients/${ORPHAN_ID}`, 401, { error: 'unauthorized' })
    expect(await call('webRemote:relay-client-revoke', { clientId: ORPHAN_ID })).toEqual({ ok: false, error: 'device_token_invalid' })
  })

  it('revokeAllDevices also clears local services', async () => {
    await setup()
    await pairedService()
    await webRemote.__test.revokeAllDevices()
    expect(store.list()).toEqual([])
  })
})
