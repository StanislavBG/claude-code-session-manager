'use strict';

/**
 * web-remote-invalid-token.test.cjs — an invalid_token ticket failure is terminal
 * (no reconnect, status repair-needed); transient failures keep the backoff.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-invalid-token.test.cjs
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'

const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const https = require('node:https')
const { EventEmitter } = require('node:events')

let tmpHome
let origHome
let origRequest
let webRemote
let handlers

// Fake https.request: `outcome` is { status, body } or { netError }.
function stubHttps(outcome) {
  https.request = (_opts, cb) => {
    const req = new EventEmitter()
    req.setTimeout = () => {}
    req.destroy = () => {}
    req.write = () => {}
    req.end = () => {
      if (outcome.netError) { req.emit('error', new Error(outcome.netError)); return }
      const res = new EventEmitter()
      res.statusCode = outcome.status
      cb(res)
      res.emit('data', JSON.stringify(outcome.body || {}))
      res.emit('end')
    }
    return req
  }
}

beforeAll(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-remote-invalid-token-'))
  origHome = process.env.HOME
  process.env.HOME = tmpHome
  origRequest = https.request

  handlers = new Map()
  const electronPath = require.resolve('electron')
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: {
      ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: () => {} },
      app: { getPath: () => tmpHome, getVersion: () => '0.0.0-test' },
    },
  }
  for (const mod of ['../webRemote.cjs', '../config.cjs', '../logs.cjs', './e2eStateMachine.cjs']) {
    try { delete require.cache[require.resolve(mod)] } catch { /* not yet loaded */ }
  }
  webRemote = require('../webRemote.cjs')
  webRemote.registerRemoteHandlers()

  const cfgPath = path.join(tmpHome, '.claude', 'session-manager', 'web-remote.json')
  await fsp.mkdir(path.dirname(cfgPath), { recursive: true })
  await fsp.writeFile(cfgPath, JSON.stringify({
    remoteEnabled: true,
    devices: [{ deviceId: 'd1', deviceToken: 'tok', issuedAt: new Date(0).toISOString() }],
  }))
  webRemote.__test.invalidateConfigCache()
})

afterEach(() => {
  webRemote.__test.cancelReconnect()
  https.request = origRequest
})

afterAll(async () => {
  https.request = origRequest
  process.env.HOME = origHome
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

describe('web-remote invalid_token handling', () => {
  it('invalid_token → no reconnect timer, status repair-needed', async () => {
    stubHttps({ status: 400, body: { error: 'invalid_token' } })
    await webRemote.__test.connect()
    expect(webRemote.__test.hasReconnectTimer()).toBe(false)
    const status = await handlers.get('webRemote:get-status')()
    expect(status.linkState).toBe('repair-needed')
  })

  it('HTTP 401 is also terminal', async () => {
    stubHttps({ status: 401, body: {} })
    await webRemote.__test.connect()
    expect(webRemote.__test.hasReconnectTimer()).toBe(false)
  })

  it('network error → reconnect scheduled', async () => {
    stubHttps({ netError: 'ECONNRESET' })
    await webRemote.__test.connect()
    expect(webRemote.__test.hasReconnectTimer()).toBe(true)
  })

  it('5xx → reconnect scheduled', async () => {
    stubHttps({ status: 503, body: {} })
    await webRemote.__test.connect()
    expect(webRemote.__test.hasReconnectTimer()).toBe(true)
  })
})
