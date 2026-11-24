'use strict';

/**
 * remote-service-e2e.test.cjs — the whole paired-service path, in one process,
 * without the loopback admin HTTP port:
 *
 *   real serviceClient ──fake WS──▶ in-process fake relay ──fake WS──▶ real webRemote agent
 *        (fetchImpl)        (client-otp, client-pair, client-ticket,          │ (https.request stub)
 *                            client/devices, clients GET/DELETE,               ▼
 *                            device-ticket, routing by userId,          adminHttp.invoke ─▶ real
 *                            4001 token_revoked + client:disconnected)  crossProjectFeedback / epic routes
 *
 * The owner starts the pairing (webRemote:service-pair-start), the service
 * redeems the code, the owner confirms the SAS (webRemote.confirmServiceSas),
 * the service opens a proposed Epic in a temp project with an externalRef,
 * repeats it (status existing), reads it back by externalRef (epic_get), is
 * refused macro_run (outside its scope), and is revoked (relay DELETE, 4001,
 * serviceClient state 'revoked', no reconnect).
 *
 * Temp HOME + SM_SCHEDULER_HOME; never ~/.claude, never the live relay.
 *
 * Run: timeout 600 npx vitest run src/main/__tests__/remote-service-e2e.test.cjs
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const http = require('node:http')
const https = require('node:https')
const { EventEmitter } = require('node:events')

const RELAY_HOST = 'relay.test'
const RELAY_PREFIX = '/api/sm-relay'

// ─── Bounded waits ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll `pred` every 10 ms; throw after `timeoutMs`. */
async function waitFor(pred, label, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await pred()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`)
    await sleep(10)
  }
}

/** Race a promise against a timeout. */
function within(promise, label, timeoutMs = 5000) {
  let t
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${timeoutMs} ms: ${label}`)), timeoutMs) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t))
}

// ─── Fake WebSocket (both ends: the webRemote agent and the serviceClient) ──

let relay // the FakeRelay instance sockets attach to

class FakeSocket extends EventEmitter {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  constructor(url, opts) {
    super()
    this.url = url
    this.opts = opts
    this.readyState = FakeSocket.CONNECTING
    this.closeInfo = null
    const u = new URL(url)
    this.ticket = u.searchParams.get('ticket')
    setImmediate(() => relay.attach(this, u))
  }

  /** Relay → this peer. */
  deliver(obj) {
    if (this.readyState !== FakeSocket.OPEN) return
    const buf = Buffer.from(JSON.stringify(obj))
    setImmediate(() => { if (this.readyState === FakeSocket.OPEN) this.emit('message', buf) })
  }

  /** This peer → relay. */
  send(data) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error('socket not open')
    const text = String(data)
    setImmediate(() => relay.receive(this, text))
  }

  close(code = 1000, reason = '') {
    if (this.readyState === FakeSocket.CLOSED || this.readyState === FakeSocket.CLOSING) return
    this.readyState = FakeSocket.CLOSING
    this.closeInfo = { code, reason: String(reason) }
    setImmediate(() => {
      this.readyState = FakeSocket.CLOSED
      relay.detach(this)
      this.emit('close', code, Buffer.from(String(reason)))
    })
  }

  terminate() { this.close(1006, '') }
  ping() {}
  removeAllListeners(...a) { return super.removeAllListeners(...a) }
}

// ─── In-process fake relay mirroring the live sm-relay routes ──────────────

class FakeRelay {
  constructor({ userId, device }) {
    this.userId = userId
    this.device = device // { deviceId, deviceToken, devicePubKey, deviceName }
    this.otps = new Map() // code → userId
    this.clients = new Map() // clientId → { clientId, clientName, token, userId, issuedAt }
    this.tickets = new Map() // ticket → { role, userId, deviceId?, clientId? }
    this.deviceConns = new Map() // deviceId → { ws, userId, deviceId }
    this.browserConns = new Map() // connId → { ws, id, userId, clientId, revoked }
    this.calls = [] // every REST call: { method, path, auth }
    this.wsFrames = [] // every routed frame: { dir, type, fromConn?, toConn? }
  }

  userOfDeviceToken(token) {
    return token && token === this.device.deviceToken ? this.userId : null
  }

  clientOfToken(token) {
    if (!token) return null
    for (const c of this.clients.values()) if (c.token === token) return c
    return null
  }

  /** One REST call. Returns { status, json }. */
  http(method, pathname, headers, bodyText) {
    const auth = /^Bearer (.+)$/.exec(String(headers?.Authorization || headers?.authorization || ''))?.[1] || null
    this.calls.push({ method, path: pathname, auth: auth ? 'bearer' : null })
    if (!pathname.startsWith(RELAY_PREFIX)) return { status: 404, json: { error: 'not_found' } }
    const route = pathname.slice(RELAY_PREFIX.length)
    let body = {}
    try { body = bodyText ? JSON.parse(bodyText) : {} } catch { return { status: 400, json: { error: 'invalid_json' } } }
    const unauthorized = { status: 401, json: { error: 'invalid_token' } }

    if (method === 'POST' && route === '/device-ticket') {
      const userId = this.userOfDeviceToken(auth)
      if (!userId) return unauthorized
      const ticket = crypto.randomBytes(16).toString('hex')
      this.tickets.set(ticket, { role: 'agent', userId, deviceId: this.device.deviceId })
      return { status: 200, json: { ticket } }
    }
    if (method === 'POST' && route === '/client-otp') {
      // The owner's paired desktop (device token) mints the one-time code.
      const userId = this.userOfDeviceToken(auth)
      if (!userId) return unauthorized
      const code = crypto.randomBytes(8).toString('hex').toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(8, 'Z').slice(0, 8)
      this.otps.set(code, userId)
      return { status: 200, json: { code, expiresInSec: 300 } }
    }
    if (method === 'POST' && route === '/client-pair') {
      const userId = this.otps.get(String(body.code || '').toUpperCase())
      if (!userId) return { status: 400, json: { error: 'invalid_code' } }
      this.otps.delete(String(body.code).toUpperCase())
      const clientId = crypto.randomUUID()
      const token = `client-token-${crypto.randomBytes(12).toString('hex')}`
      this.clients.set(clientId, { clientId, clientName: String(body.clientName || ''), token, userId, issuedAt: new Date().toISOString() })
      return { status: 200, json: { clientToken: token, clientId } }
    }
    if (method === 'GET' && route === '/client/devices') {
      const c = this.clientOfToken(auth)
      if (!c) return unauthorized
      return { status: 200, json: { devices: [{ deviceId: this.device.deviceId, deviceName: this.device.deviceName, devicePubKey: this.device.devicePubKey }] } }
    }
    if (method === 'POST' && route === '/client-ticket') {
      const c = this.clientOfToken(auth)
      if (!c) return unauthorized
      const ticket = crypto.randomBytes(16).toString('hex')
      this.tickets.set(ticket, { role: 'browser', userId: c.userId, clientId: c.clientId })
      return { status: 200, json: { ticket } }
    }
    if (method === 'GET' && route === '/clients') {
      const userId = this.userOfDeviceToken(auth)
      if (!userId) return unauthorized
      const clients = [...this.clients.values()].filter((c) => c.userId === userId)
        .map(({ clientId, clientName, issuedAt }) => ({ clientId, clientName, issuedAt }))
      return { status: 200, json: { clients } }
    }
    const del = /^\/clients\/([^/]+)$/.exec(route)
    if (method === 'DELETE' && del) {
      const userId = this.userOfDeviceToken(auth)
      if (!userId) return unauthorized
      const clientId = decodeURIComponent(del[1])
      const c = this.clients.get(clientId)
      if (!c || c.userId !== userId) return { status: 404, json: { error: 'client_not_found' } }
      this.clients.delete(clientId)
      // notifyClientRevoked: every live conn of that client closes 4001 token_revoked.
      for (const conn of this.browserConns.values()) {
        if (conn.clientId === clientId) { conn.revoked = true; conn.ws.close(4001, 'token_revoked') }
      }
      return { status: 200, json: { ok: true } }
    }
    return { status: 404, json: { error: 'not_found' } }
  }

  attach(ws, url) {
    const t = this.tickets.get(ws.ticket)
    if (!t || url.hostname !== RELAY_HOST && url.hostname !== 'bilko.run') {
      ws.readyState = FakeSocket.OPEN
      ws.close(4401, 'invalid_ticket')
      return
    }
    this.tickets.delete(ws.ticket) // one-time
    ws.readyState = FakeSocket.OPEN
    if (t.role === 'agent') {
      const conn = { ws, userId: t.userId, deviceId: t.deviceId, role: 'agent' }
      ws.relayConn = conn
      this.deviceConns.set(t.deviceId, conn)
      ws.emit('open')
      ws.deliver({ type: 'auth:ok', id: crypto.randomUUID(), deviceId: t.deviceId, ts: Date.now() })
      return
    }
    const conn = { ws, id: crypto.randomUUID(), userId: t.userId, clientId: t.clientId, role: 'browser', revoked: false }
    ws.relayConn = conn
    this.browserConns.set(conn.id, conn)
    ws.emit('open')
    ws.deliver({ type: 'auth:ok', id: crypto.randomUUID(), ts: Date.now() })
  }

  detach(ws) {
    const conn = ws.relayConn
    if (!conn) return
    ws.relayConn = null
    if (conn.role === 'agent') {
      if (this.deviceConns.get(conn.deviceId) === conn) this.deviceConns.delete(conn.deviceId)
      return
    }
    this.browserConns.delete(conn.id)
    const reason = conn.revoked ? 'token_revoked' : 'closed'
    for (const d of this.deviceConns.values()) {
      if (d.userId === conn.userId) {
        d.ws.deliver({ type: 'event:client:disconnected', id: crypto.randomUUID(), fromConn: conn.id, reason, ts: Date.now() })
      }
    }
  }

  receive(ws, text) {
    const conn = ws.relayConn
    if (!conn) return
    let env
    try { env = JSON.parse(text) } catch { ws.deliver({ type: 'error', code: 'invalid_json' }); return }
    if (!env || typeof env.type !== 'string') { ws.deliver({ type: 'error', code: 'invalid_envelope' }); return }
    if (env.type === 'ping') { ws.deliver({ type: 'pong', id: env.id, ts: Date.now() }); return }
    if (env.type === 'pong') return

    if (conn.role === 'browser') {
      const device = this.deviceConns.get(env.deviceId)
      if (!device) { ws.deliver({ type: 'error', code: 'device_offline' }); return }
      if (device.userId !== conn.userId) { ws.deliver({ type: 'error', code: 'not_your_device' }); return }
      // Sender identity comes from the authenticated conn; any toConn is dropped.
      const { toConn: _ignored, ...rest } = env
      this.wsFrames.push({ dir: 'up', type: env.type, fromConn: conn.id })
      device.ws.deliver({ ...rest, fromConn: conn.id, relay_ts: Date.now() })
      return
    }
    const { toConn, ...rest } = env
    const out = { ...rest, deviceId: conn.deviceId, relay_ts: Date.now() }
    this.wsFrames.push({ dir: 'down', type: env.type, toConn })
    if (toConn !== undefined) {
      const b = this.browserConns.get(toConn)
      if (b && b.userId === conn.userId) b.ws.deliver(out)
      return
    }
    for (const b of this.browserConns.values()) if (b.userId === conn.userId) b.ws.deliver(out)
  }
}

/** https.request stand-in: webRemote's relay REST calls land on the fake relay. */
function fakeHttpsRequest(opts, cb) {
  const req = new EventEmitter()
  let body = ''
  req.setTimeout = () => req
  req.write = (c) => { body += c }
  req.destroy = (e) => req.emit('error', e)
  req.end = () => {
    setImmediate(() => {
      if (opts.hostname !== 'bilko.run') { req.emit('error', new Error(`unexpected host ${opts.hostname}`)); return }
      const r = relay.http(opts.method, opts.path, opts.headers, body)
      const res = new EventEmitter()
      res.statusCode = r.status
      cb(res)
      res.emit('data', JSON.stringify(r.json))
      res.emit('end')
    })
  }
  return req
}

/** fetch stand-in for serviceClient. */
async function fakeFetch(url, init = {}) {
  const u = new URL(url)
  if (u.protocol !== 'https:' || u.hostname !== RELAY_HOST) throw new Error(`unexpected url ${url}`)
  await sleep(0)
  const r = relay.http(init.method || 'GET', u.pathname, init.headers || {}, init.body)
  return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.json }
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

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
let origSchedHome
let origTokenPath
let origHttpsRequest
let origHttpRequest
let origHttpGet
let wsCacheEntry
let wsPath
let webRemote
let handlers
let adminHttp
let config
let readActiveIndex
let createServiceClient
let createServicePairings
let configPath
const invokeCalls = []
const loopbackCalls = []

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

function mkProject(name) {
  const cwd = path.join(tmpHome, 'projects', name)
  fs.mkdirSync(path.join(cwd, 'session-manager-operations'), { recursive: true })
  // ensureEpic checks the persona exists; keep it hermetic (no ~/.claude/agents).
  const agentsDir = path.join(cwd, '.claude', 'agents')
  fs.mkdirSync(agentsDir, { recursive: true })
  fs.writeFileSync(path.join(agentsDir, 'architect.md'), '---\nname: architect\nmodel: sonnet\n---\nFixture persona for tests.\n')
  const real = fs.realpathSync(cwd)
  config.addAllowedRoot(real)
  return real
}

beforeAll(async () => {
  tmpHome = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 'remote-service-e2e-')))
  origHome = process.env.HOME
  origSchedHome = process.env.SM_SCHEDULER_HOME
  origTokenPath = process.env.SM_ADMIN_TOKEN_PATH
  process.env.HOME = tmpHome
  process.env.SM_SCHEDULER_HOME = path.join(tmpHome, '.claude', 'session-manager')
  process.env.SM_ADMIN_TOKEN_PATH = path.join(tmpHome, 'admin-api.test.json')
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager', 'logs'), { recursive: true })

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
  // webRemote does `require('ws')` at load: hand it the fake socket.
  wsPath = require.resolve('ws')
  wsCacheEntry = require.cache[wsPath]
  require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: FakeSocket }

  for (const mod of ['../webRemote.cjs', '../config.cjs', '../logs.cjs']) {
    try { delete require.cache[require.resolve(mod)] } catch { /* not yet loaded */ }
  }
  origHttpsRequest = https.request
  https.request = fakeHttpsRequest
  // Any loopback HTTP call (the admin port) is recorded — the test asserts none happen.
  origHttpRequest = http.request
  origHttpGet = http.get
  http.request = (...a) => { loopbackCalls.push(a[0]); return origHttpRequest.apply(http, a) }
  http.get = (...a) => { loopbackCalls.push(a[0]); return origHttpGet.apply(http, a) }

  webRemote = require('../webRemote.cjs')
  config = require('../config.cjs')
  ;({ readActiveIndex } = require('../lib/epic/epicMint.cjs'))
  ;({ createServiceClient } = require('../lib/feedback-remote/serviceClient.cjs'))
  ;({ createServicePairings } = require('../lib/feedback-remote/servicePairings.cjs'))
  const { createAdminHttp } = require('../lib/feedback-remote/localAdminHttp.cjs')
  adminHttp = createAdminHttp()
  require('../lib/feedback-remote/crossProjectFeedback.cjs').registerAdminRoute(adminHttp)
  require('../lib/epic/epicAdminRoutes.cjs').registerAdminRoute(adminHttp, { isTabBusy: () => false, listJobs: () => [] })
  // Bound exactly as index.cjs binds it: the in-process route call, never the port.
  webRemote.setServiceInvoker((method, routePath, opts) => {
    invokeCalls.push({ method, routePath })
    return adminHttp.invoke(method, routePath, opts)
  })
  configPath = path.join(tmpHome, '.claude', 'session-manager', 'web-remote.json')
  webRemote.registerRemoteHandlers()
})

afterAll(async () => {
  try { webRemote?.destroy() } catch { /* */ }
  https.request = origHttpsRequest
  http.request = origHttpRequest
  http.get = origHttpGet
  if (wsCacheEntry) require.cache[wsPath] = wsCacheEntry
  else delete require.cache[wsPath]
  delete require.cache[require.resolve('../webRemote.cjs')]
  process.env.HOME = origHome
  if (origSchedHome === undefined) delete process.env.SM_SCHEDULER_HOME
  else process.env.SM_SCHEDULER_HOME = origSchedHome
  if (origTokenPath === undefined) delete process.env.SM_ADMIN_TOKEN_PATH
  else process.env.SM_ADMIN_TOKEN_PATH = origTokenPath
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

// ─── The test ───────────────────────────────────────────────────────────────

describe('paired service over the relay, end to end', () => {
  it('pairs, confirms the SAS, opens a proposed Epic by externalRef, reads it back, is refused out of scope, then is revoked', async () => {
    const deviceKeys = genP256KeyPairB64()
    const device = {
      deviceId: crypto.randomUUID(),
      deviceToken: 'device-token-e2e',
      e2ePrivateKey: deviceKeys.priv,
      e2ePublicKey: deviceKeys.pub,
      deviceName: 'Desk',
      issuedAt: new Date().toISOString(),
      lastConnectedAt: null,
      verifiedPeerPubKey: null,
    }
    relay = new FakeRelay({
      userId: 'user-owner',
      device: { deviceId: device.deviceId, deviceToken: device.deviceToken, devicePubKey: deviceKeys.pub, deviceName: 'Desk' },
    })
    await fsp.mkdir(path.dirname(configPath), { recursive: true })
    await fsp.writeFile(configPath, JSON.stringify({ remoteEnabled: true, remoteControlEnabled: false, devices: [device] }, null, 2) + '\n')
    webRemote.__test.invalidateConfigCache()
    const store = createServicePairings({ filePath: path.join(tmpHome, '.claude', 'session-manager', 'remote-services.json') })
    webRemote.__test.setServiceStore(store)

    const homeCwd = mkProject('kiln')
    const toCwd = mkProject('receiver')

    // ── The desktop agent connects to the relay (device-ticket → WSS). ──
    await webRemote.__test.connect()
    await waitFor(() => relay.deviceConns.has(device.deviceId), 'webRemote device socket on the relay')
    expect(relay.calls.some((c) => c.method === 'POST' && c.path === `${RELAY_PREFIX}/device-ticket`)).toBe(true)

    // ── Owner starts a pairing: relay client-otp with the device token. ──
    const start = await handlers.get('webRemote:service-pair-start')({}, {
      name: 'Kiln', homeCwd, scope: ['feedback_open_session', 'epic_get'],
    })
    expect(start).toMatchObject({ ok: true, deviceId: device.deviceId })
    expect(start.code).toMatch(/^[A-Z0-9]{8}$/)

    // ── The service redeems it and connects. ──
    let sasSeen = null
    const sc = createServiceClient({
      stateDir: path.join(tmpHome, 'kiln-state'),
      relayBase: `https://${RELAY_HOST}${RELAY_PREFIX}`,
      wssUrl: `wss://${RELAY_HOST}/projects/session-manager/relay`,
      fetchImpl: fakeFetch,
      WebSocketImpl: FakeSocket,
      onSas: (s) => { sasSeen = s },
    })
    const paired = await within(sc.pair({ code: start.code, name: 'Kiln' }), 'serviceClient.pair')
    expect(paired.deviceId).toBe(device.deviceId)
    expect(relay.clients.has(paired.clientId)).toBe(true)

    const connected = within(sc.connect(), 'serviceClient.connect', 8000)
    const sas = await waitFor(() => sasSeen, 'service SAS at e2e:ready')
    expect(sas).toMatch(/^[0-9]{6}$/)
    expect(sc.state).not.toBe('ready') // unpinned: waits for the owner

    // ── Owner confirms the SAS on the desktop. ──
    const confirmed = await webRemote.confirmServiceSas(start.pairingId, sas)
    expect(confirmed.ok).toBe(true)
    expect(confirmed.service.relayClientId).toBe(paired.clientId)
    expect(await connected).toEqual({ sas })
    expect(sc.state).toBe('ready')

    // ── feedback_open_session with an externalRef → a proposed Epic in toCwd. ──
    const externalRef = 'kiln:idea-42'
    const args = {
      toCwd,
      title: 'Kiln idea 42',
      motivation: 'Prove a paired service can hand work to a project.',
      acceptanceCriteria: ['A proposed Epic exists in the receiving project'],
      body: 'Opened end to end over the fake relay.',
      externalRef,
    }
    const parse = (r) => JSON.parse(r.content[0].text)
    const first = parse(await sc.callTool('feedback_open_session', args, { timeoutMs: 15000 }))
    expect(first).toMatchObject({ ok: true, status: 'proposed', externalRef, toCwd, fromCwd: homeCwd })
    const epicId = first.epicId
    expect(typeof epicId).toBe('string')
    const row = readActiveIndex(toCwd).sessions[epicId]
    expect(row).toBeTruthy()
    expect(row.status).toBe('proposed')
    expect(row.source.externalRef).toBe(externalRef)
    expect(row.source.fromCwd).toBe(homeCwd)

    // ── Repeat: status existing, same Epic, nothing new minted. ──
    const again = parse(await sc.callTool('feedback_open_session', args, { timeoutMs: 15000 }))
    expect(again).toMatchObject({ ok: true, status: 'existing', existing: true, epicId })
    expect(Object.values(readActiveIndex(toCwd).sessions).filter((s) => s.source?.externalRef === externalRef)).toHaveLength(1)

    // ── epic_get by externalRef reads it back. ──
    const got = parse(await sc.callTool('epic_get', { cwd: toCwd, externalRef }, { timeoutMs: 15000 }))
    expect(got.ok).toBe(true)
    expect(got.epic.epicId).toBe(epicId)

    // ── The ledger holds project + id: the same id asked under another project is refused, no route call. ──
    const svcId = store.list()[0].serviceId
    expect(store.hasOpened(svcId, toCwd, epicId)).toBe(true)
    expect(store.hasOpened(svcId, homeCwd, epicId)).toBe(false)
    const elsewhere = await sc.callTool('epic_get', { cwd: homeCwd, id: epicId }, { timeoutMs: 15000 })
    expect(elsewhere.isError).toBe(true)
    expect(parse(elsewhere)).toEqual({ ok: false, error: 'not found' })

    // ── macro_run is outside this service's scope: refused, audited, never invoked. ──
    const invokesBefore = invokeCalls.length
    const refused = await sc.callTool('macro_run', { cwd: toCwd, id: 'anything' }, { timeoutMs: 15000 }).then(
      () => null, (e) => e)
    expect(refused).toBeTruthy()
    expect(refused.code).toBe('mcp_error')
    expect(refused.rpcCode).toBe(-32001)
    expect(invokeCalls.length).toBe(invokesBefore)
    await waitFor(async () => /mcp:macro_run\s+deviceId=\S+\s+client=\S+\s+msgId=\S+\s+result=refused:scope/.test(await readAudit()),
      'macro_run refused:scope audit line')

    // ── invoke was the path: no request reached an admin HTTP port. ──
    expect(invokeCalls.map((c) => `${c.method} ${new URL(c.routePath, 'http://x').pathname}`)).toEqual([
      'POST /admin/feedback/open-session',
      'POST /admin/feedback/open-session',
      'GET /admin/epic',
    ])
    expect(adminHttp.server).toBe(null)
    expect(loopbackCalls).toEqual([])
    expect(relay.wsFrames.filter((f) => f.dir === 'up' && f.type === 'e2e:box').length).toBeGreaterThanOrEqual(4)

    // ── Revoke through webRemote's revoke path: relay DELETE, 4001, 'revoked'. ──
    const svc = store.list()[0]
    expect(svc.relayClientId).toBe(paired.clientId)
    const serviceSocket = [...relay.browserConns.values()].find((c) => c.clientId === paired.clientId)?.ws
    expect(serviceSocket).toBeTruthy()
    const revoked = await handlers.get('webRemote:service-revoke')({}, { serviceId: svc.serviceId })
    expect(revoked).toEqual({ ok: true, relayRevoked: true })
    expect(relay.calls.some((c) => c.method === 'DELETE' && c.path === `${RELAY_PREFIX}/clients/${encodeURIComponent(paired.clientId)}`)).toBe(true)
    expect(relay.clients.has(paired.clientId)).toBe(false)
    await waitFor(() => sc.state === 'revoked', "serviceClient state 'revoked'")
    expect(serviceSocket.closeInfo).toEqual({ code: 4001, reason: 'token_revoked' })
    await waitFor(async () => /client:disconnected\s+deviceId=\S+\s+client=\S+\s+msgId=\S+\s+result=reason=token_revoked/.test(await readAudit()),
      'event:client:disconnected token_revoked audit line')

    // No reconnect: past the 1 s minimum backoff, no new client-ticket and no new socket.
    const ticketCalls = () => relay.calls.filter((c) => c.path === `${RELAY_PREFIX}/client-ticket`).length
    const before = ticketCalls()
    await sleep(1600)
    expect(ticketCalls()).toBe(before)
    expect([...relay.browserConns.values()].some((c) => c.clientId === paired.clientId)).toBe(false)
    expect(sc.state).toBe('revoked')
    await expect(sc.connect()).rejects.toMatchObject({ code: 'revoked' })
  }, 60_000)
})
