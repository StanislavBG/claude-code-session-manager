'use strict'

/**
 * remoteClient.test.cjs — the desktop client role against an in-memory fake
 * agent that uses the real agent-side crypto.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/remoteClient.test.cjs
 */

import { describe, it, expect, afterEach, vi } from 'vitest'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const {
  generateE2EKeyPair, deriveSessionKey, deriveSas, encryptBox, decryptBox,
} = require('../lib/feedback-remote/remoteE2eCrypto.cjs')
const { createRemoteClient } = require('../remoteClient.cjs')

const DEVICE_ID = 'dev-agent-1'
const tmpDirs = []

function tmpConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-client-test-'))
  tmpDirs.push(dir)
  return path.join(dir, 'remote-peers.json')
}

afterEach(() => {
  vi.useRealTimers()
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true })
})

/** Fake agent: owns the device keypair, answers e2e:hello, serves cmd:app:version. */
function makeAgent({ respond = true, info = { version: '9.9.9', platform: 'win32' } } = {}) {
  const kp = generateE2EKeyPair()
  const agent = {
    kp,
    sessionKey: null,
    sas: null,
    sockets: [],
    sockets_sent: [],
    factory(url) {
      const ws = new EventEmitter()
      ws.readyState = 1
      ws.url = url
      ws.sent = []
      ws.close = () => { ws.readyState = 3; ws.emit('close') }
      ws.send = (raw) => {
        const msg = JSON.parse(raw)
        ws.sent.push(msg)
        if (msg.type === 'e2e:hello') {
          agent.sessionKey = deriveSessionKey(kp.e2ePrivateKey, msg.payload.pubKey, DEVICE_ID)
          agent.sas = deriveSas(kp.e2ePrivateKey, msg.payload.pubKey, DEVICE_ID)
          ws.emit('message', JSON.stringify({ type: 'e2e:ready', id: msg.id, ts: Date.now() }))
        } else if (msg.type === 'e2e:box' && respond) {
          const plain = decryptBox(msg.payload.nonce, msg.payload.ciphertext, agent.sessionKey)
          const inner = JSON.parse(plain)
          agent.lastCmd = inner
          const out = { type: `resp:${inner.id}`, id: inner.id, payload: inner.type === 'cmd:app:info' ? info : { version: '9.9.9' }, ts: Date.now() }
          ws.emit('message', JSON.stringify({ type: 'e2e:box', id: inner.id, payload: encryptBox(JSON.stringify(out), agent.sessionKey) }))
        }
      }
      agent.sockets.push(ws)
      // relay accepts the ticket
      setImmediate(() => ws.emit('message', JSON.stringify({ type: 'auth:ok', ts: Date.now() })))
      return ws
    },
  }
  return agent
}

async function until(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('until timed out')
}

function setup(agent, pubKeyOverride) {
  const configPath = tmpConfig()
  const relayAuth = {
    getBrowserTicket: async () => 'secret-ticket',
    getDevicePubKey: async () => pubKeyOverride?.() ?? agent.kp.e2ePublicKey,
  }
  const client = createRemoteClient({ relayAuth, wsFactory: (u) => agent.factory(u), configPath })
  client.addPeer({ peerId: 'p1', deviceId: DEVICE_ID, machineName: 'win-box' })
  return { client, configPath }
}

async function connectToSas(client) {
  await client.connect('p1')
  await until(() => client.getStatus('p1').status === 'pending_sas')
}

describe('remoteClient', () => {
  it('persists peers at 0600 and matches SAS with the agent', async () => {
    const agent = makeAgent()
    const { client, configPath } = setup(agent)
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600)
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf8')).peers[0]
    expect(stored.clientPrivateKey).toBeTruthy()
    expect(stored.verifiedDevicePubKey).toBeNull()
    await connectToSas(client)
    expect(client.getStatus('p1').sas).toBe(agent.sas)
    expect(agent.sockets[0].url).toContain('?ticket=secret-ticket')
    expect(client.listPeers()[0].clientPrivateKey).toBeUndefined()
  })

  it('round-trips an encrypted cmd:app:version', async () => {
    const agent = makeAgent()
    const { client } = setup(agent)
    await connectToSas(client)
    const res = await client.send('p1', 'cmd:app:version', {})
    expect(res).toEqual({ version: '9.9.9' })
    expect(agent.lastCmd.type).toBe('cmd:app:version')
    // nothing plaintext on the wire after the handshake
    const boxes = agent.sockets[0].sent.filter((m) => m.type !== 'e2e:hello')
    expect(boxes.every((m) => m.type === 'e2e:box')).toBe(true)
  })

  it('routes event:* boxes to subscribers and answers app-level ping', async () => {
    const agent = makeAgent()
    const { client } = setup(agent)
    await connectToSas(client)
    const events = []
    client.onEvent('p1', (e) => events.push(e))
    const ws = agent.sockets[0]
    const ev = { type: 'event:pty:data', id: 'x', payload: { d: 1 }, ts: 1 }
    ws.emit('message', JSON.stringify({ type: 'e2e:box', payload: encryptBox(JSON.stringify(ev), agent.sessionKey) }))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('event:pty:data')
    ws.emit('message', JSON.stringify({ type: 'ping', id: 'k1' }))
    expect(ws.sent.some((m) => m.type === 'pong' && m.id === 'k1')).toBe(true)
  })

  it('rejects send after 15 s without a response', async () => {
    const agent = makeAgent({ respond: false })
    const { client } = setup(agent)
    await connectToSas(client)
    vi.useFakeTimers()
    const p = client.send('p1', 'cmd:app:version', {})
    const assertion = expect(p).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(15_000)
    await assertion
  })

  it('rejects non-allowlisted types locally', async () => {
    const agent = makeAgent()
    const { client } = setup(agent)
    await connectToSas(client)
    await expect(client.send('p1', 'cmd:not:real', {})).rejects.toThrow('command_not_allowed')
    expect(agent.sockets[0].sent.filter((m) => m.type === 'e2e:box')).toHaveLength(0)
  })

  it('pins the key on confirmSas and fails closed when it changes', async () => {
    const agent = makeAgent()
    let pub = agent.kp.e2ePublicKey
    const { client, configPath } = setup(agent, () => pub)
    await connectToSas(client)
    expect(client.confirmSas('p1').ok).toBe(true)
    expect(client.getStatus('p1').status).toBe('authenticated')
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).peers[0].verifiedDevicePubKey).toBe(agent.kp.e2ePublicKey)

    // same key reconnects straight to authenticated
    await client.connect('p1')
    await until(() => client.getStatus('p1').status === 'authenticated')

    pub = generateE2EKeyPair().e2ePublicKey
    const s = await client.connect('p1')
    expect(s.status).toBe('failed')
    expect(s.reason).toBe('device_key_changed')
    await expect(client.send('p1', 'cmd:app:version', {})).rejects.toThrow('not_connected')
  })

  it('fails with relay_client_auth_unavailable when relayAuth cannot mint a ticket', async () => {
    const relayAuth = {
      getBrowserTicket: async () => { throw new Error('relay_client_auth_unavailable') },
      getDevicePubKey: async () => 'unused',
    }
    const client = createRemoteClient({ relayAuth, wsFactory: () => { throw new Error('no network') }, configPath: tmpConfig() })
    client.addPeer({ peerId: 'p1', deviceId: DEVICE_ID })
    const s = await client.connect('p1')
    expect(s.status).toBe('failed')
    expect(s.reason).toBe('relay_client_auth_unavailable')
  })

  function setupWithClear(agent) {
    const clearToken = vi.fn()
    const relayAuth = {
      getBrowserTicket: async () => 'secret-ticket',
      getDevicePubKey: async () => agent.kp.e2ePublicKey,
      clearToken,
    }
    const client = createRemoteClient({ relayAuth, wsFactory: (u) => agent.factory(u), configPath: tmpConfig() })
    client.addPeer({ peerId: 'p1', deviceId: DEVICE_ID })
    return { client, clearToken }
  }

  it('close code 4001 clears the token and fails with token_revoked', async () => {
    const agent = makeAgent({ respond: false })
    const { client, clearToken } = setupWithClear(agent)
    await connectToSas(client)
    const p = client.send('p1', 'cmd:app:version', {})
    const assertion = expect(p).rejects.toThrow('token_revoked')
    agent.sockets[0].emit('close', 4001, Buffer.from('token_revoked'))
    await assertion
    expect(client.getStatus('p1').status).toBe('failed')
    expect(client.getStatus('p1').reason).toBe('token_revoked')
    expect(clearToken).toHaveBeenCalledTimes(1)
  })

  it('relay token_revoked error message clears the token and fails', async () => {
    const agent = makeAgent()
    const { client, clearToken } = setupWithClear(agent)
    await connectToSas(client)
    agent.sockets[0].emit('message', JSON.stringify({ type: 'error', code: 'token_revoked' }))
    expect(client.getStatus('p1').reason).toBe('token_revoked')
    expect(clearToken).toHaveBeenCalledTimes(1)
  })

  it.each(['device_offline', 'not_your_device'])('relay %s error fails the peer with that reason', async (code) => {
    const agent = makeAgent()
    const { client, clearToken } = setupWithClear(agent)
    await connectToSas(client)
    agent.sockets[0].emit('message', JSON.stringify({ type: 'error', code }))
    expect(client.getStatus('p1').status).toBe('failed')
    expect(client.getStatus('p1').reason).toBe(code)
    expect(clearToken).not.toHaveBeenCalled()
  })

  it('relay rate_limited error leaves the status unchanged', async () => {
    const agent = makeAgent()
    const { client } = setupWithClear(agent)
    await connectToSas(client)
    const before = client.getStatus('p1').status
    agent.sockets[0].emit('message', JSON.stringify({ type: 'error', code: 'rate_limited' }))
    expect(client.getStatus('p1').status).toBe(before)
  })

  it('a normal 1000 close returns to idle without clearing the token', async () => {
    const agent = makeAgent()
    const { client, clearToken } = setupWithClear(agent)
    await connectToSas(client)
    agent.sockets[0].emit('close', 1000, Buffer.from(''))
    expect(client.getStatus('p1').status).toBe('idle')
    expect(clearToken).not.toHaveBeenCalled()
  })

  it('removePeer closes the socket and deletes the entry', async () => {
    const agent = makeAgent()
    const { client, configPath } = setup(agent)
    await connectToSas(client)
    client.removePeer('p1')
    expect(agent.sockets[0].readyState).toBe(3)
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).peers).toEqual([])
  })

  it('learns and persists the remote os on authentication, surviving a disconnect', async () => {
    const agent = makeAgent()
    const { client, configPath } = setup(agent)
    expect(client.listPeers()[0].os).toBeNull()
    await connectToSas(client)
    client.confirmSas('p1')
    await until(() => client.listPeers()[0].os === 'win32')
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).peers[0].os).toBe('win32')
    expect(client.listPeers()[0].clientPrivateKey).toBeUndefined()
    expect(agent.sockets[0].sent.filter((m) => m.type === 'e2e:box')).toHaveLength(1)
    agent.sockets[0].emit('message', JSON.stringify({ type: 'error', code: 'device_offline' }))
    expect(client.getStatus('p1').status).toBe('failed')
    expect(client.listPeers()[0].os).toBe('win32')
  })

  it('a rejected cmd:app:info leaves the peer authenticated with os null', async () => {
    const agent = makeAgent({ info: { error: 'unknown_command' } })
    const { client } = setup(agent)
    await connectToSas(client)
    client.confirmSas('p1')
    await until(() => agent.lastCmd?.type === 'cmd:app:info')
    await new Promise((r) => setTimeout(r, 20))
    expect(client.getStatus('p1').status).toBe('authenticated')
    expect(client.listPeers()[0].os).toBeNull()
  })

  it('an unanswered cmd:app:info times out without failing the connection', async () => {
    const agent = makeAgent({ respond: false })
    const { client } = setup(agent)
    await connectToSas(client)
    vi.useFakeTimers()
    client.confirmSas('p1')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(client.getStatus('p1').status).toBe('authenticated')
    expect(client.listPeers()[0].os).toBeNull()
  })
})
