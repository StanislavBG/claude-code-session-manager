'use strict';

/**
 * web-remote-pty-stream.test.cjs — remote PTY output streaming.
 *
 * cmd:pty:spawn subscribes to the tab via PtyManager.addOutputListener and pushes
 * event:pty:data / event:pty:exit to the peer as E2E boxes, only while the E2E
 * session is authenticated, and tears every listener down on revoke.
 *
 * tmp HOME + electron/pty require.cache stubs, same pattern as
 * web-remote-e2e-pinning.test.cjs.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-pty-stream.test.cjs
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

let tmpHome
let origHome
let webRemote
let dispatch
let sent
let listeners // tabId -> Set<{onData,onExit}>
const sessionKey = crypto.randomBytes(32)

const fakeWs = { readyState: 1, send: (m) => sent.push(JSON.parse(m)) }

function stubModule(id, exports) {
  const p = require.resolve(id)
  require.cache[p] = { id: p, filename: p, loaded: true, exports }
}

function emit(tabId, data) {
  for (const l of [...(listeners.get(tabId) || [])]) l.onData(tabId, data)
}

function decryptAll() {
  const { decryptBox } = require('../lib/feedback-remote/remoteE2eCrypto.cjs')
  return sent.map((m) => {
    expect(m.type).toBe('e2e:box')
    return JSON.parse(decryptBox(m.payload.nonce, m.payload.ciphertext, sessionKey))
  })
}

beforeAll(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-remote-pty-stream-'))
  origHome = process.env.HOME
  process.env.HOME = tmpHome

  stubModule('electron', {
    ipcMain: { handle: () => {}, on: () => {} },
    app: { getPath: () => tmpHome, getVersion: () => '0.0.0-test' },
  })

  listeners = new Map()
  stubModule('../pty.cjs', {
    manager: {
      spawn: async () => ({ ok: true }),
      kill: () => {},
      write: () => {},
      resize: () => {},
      addOutputListener(tabId, onData, onExit) {
        const entry = { onData, onExit }
        if (!listeners.has(tabId)) listeners.set(tabId, new Set())
        listeners.get(tabId).add(entry)
        return () => listeners.get(tabId)?.delete(entry)
      },
    },
  })

  const cfgPath = path.join(tmpHome, '.claude', 'session-manager', 'web-remote.json')
  await fsp.mkdir(path.dirname(cfgPath), { recursive: true })
  await fsp.writeFile(cfgPath, JSON.stringify({ remoteEnabled: true, remoteControlEnabled: true, devices: [] }))

  for (const mod of ['../webRemote.cjs', '../config.cjs', '../logs.cjs']) {
    try { delete require.cache[require.resolve(mod)] } catch { /* not yet loaded */ }
  }
  webRemote = require('../webRemote.cjs')
  dispatch = webRemote.__test.getDispatchMap()
})

afterAll(async () => {
  process.env.HOME = origHome
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

describe('web-remote pty output streaming', () => {
  const spawnArgs = (tabId) => ({ tabId, cwd: os.homedir(), cols: 80, rows: 24 })

  it('pushes nothing before SAS authentication', async () => {
    sent = []
    webRemote.__test.setWs(fakeWs)
    await dispatch['cmd:pty:spawn'](spawnArgs('t1'))
    emit('t1', 'early')
    expect(sent).toHaveLength(0)
  })

  it('pushes event:pty:data / exit as e2e:box once authenticated; respawn replaces', async () => {
    webRemote.__test.setE2eAuthenticated(sessionKey)
    sent = []
    await dispatch['cmd:pty:spawn'](spawnArgs('t2'))
    await dispatch['cmd:pty:spawn'](spawnArgs('t2'))
    expect(listeners.get('t2').size).toBe(1)

    emit('t2', 'hello')
    for (const l of listeners.get('t2')) l.onExit('t2', { exitCode: 3, signal: undefined })

    const events = decryptAll()
    expect(events[0].type).toBe('event:pty:data')
    expect(events[0].payload).toEqual({ tabId: 't2', data: 'hello' })
    expect(events[1].type).toBe('event:pty:exit')
    expect(events[1].payload.exitCode).toBe(3)
  })

  it('kill unsubscribes that tab', async () => {
    webRemote.__test.setE2eAuthenticated(sessionKey)
    await dispatch['cmd:pty:spawn'](spawnArgs('t3'))
    await dispatch['cmd:pty:kill']({ tabId: 't3' })
    expect(listeners.get('t3').size).toBe(0)
  })

  it('pushes nothing after revokeAllDevices', async () => {
    webRemote.__test.setE2eAuthenticated(sessionKey)
    webRemote.__test.setWs(fakeWs)
    await dispatch['cmd:pty:spawn'](spawnArgs('t4'))
    expect(webRemote.__test.streamCount()).toBeGreaterThan(0)

    await webRemote.__test.revokeAllDevices()
    sent = []
    webRemote.__test.setWs(fakeWs)
    emit('t4', 'late')
    expect(listeners.get('t4').size).toBe(0)
    expect(webRemote.__test.streamCount()).toBe(0)
    expect(sent).toHaveLength(0)
  })
})
