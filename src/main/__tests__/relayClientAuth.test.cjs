'use strict'

/**
 * relayClientAuth.test.cjs — client-role relay credential with an injected fake transport.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/relayClientAuth.test.cjs
 */

import { describe, it, expect, afterEach, vi } from 'vitest'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRelayClientAuth, RELAY_CLIENT_API_BASE } = require('../lib/relayClientAuth.cjs')

const tmpDirs = []
function tmpTokenPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-client-auth-test-'))
  tmpDirs.push(dir)
  return path.join(dir, 'relay-client.json')
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true })
})

function paired(tokenPath) {
  fs.writeFileSync(tokenPath, JSON.stringify({ clientToken: 'tok-1', clientId: 'c1', pairedAt: 'x' }))
}

describe('relayClientAuth', () => {
  it('exposes the API base', () => {
    expect(RELAY_CLIENT_API_BASE).toBe('https://bilko.run/api/sm-relay')
  })

  it('pair success stores the token at 0600', async () => {
    const tokenPath = tmpTokenPath()
    const request = vi.fn(async () => ({ status: 200, json: { clientToken: 'tok-1', clientId: 'c1' } }))
    const auth = createRelayClientAuth({ tokenPath, request })
    const r = await auth.pair('  abcd-1234 ', 'My Desktop')
    expect(r).toEqual({ ok: true, clientId: 'c1' })
    const call = request.mock.calls[0][0]
    expect(call.url).toBe(`${RELAY_CLIENT_API_BASE}/client-pair`)
    expect(JSON.parse(call.body)).toEqual({ code: 'ABCD-1234', clientName: 'My Desktop' })
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(tokenPath, 'utf8'))).toMatchObject({ clientToken: 'tok-1', clientId: 'c1' })
    expect(auth.isPaired()).toBe(true)
    expect(auth.getClientId()).toBe('c1')
  })

  it('pair 404 maps to relay_client_auth_unavailable', async () => {
    const auth = createRelayClientAuth({ tokenPath: tmpTokenPath(), request: async () => ({ status: 404, json: null }) })
    expect(await auth.pair('CODE')).toEqual({ ok: false, error: 'relay_client_auth_unavailable' })
  })

  it('pair surfaces server error codes', async () => {
    const auth = createRelayClientAuth({ tokenPath: tmpTokenPath(), request: async () => ({ status: 400, json: { error: 'invalid_code' } }) })
    expect(await auth.pair('CODE')).toEqual({ ok: false, error: 'invalid_code' })
  })

  it('ticket happy path sends the Bearer header', async () => {
    const tokenPath = tmpTokenPath()
    paired(tokenPath)
    const request = vi.fn(async () => ({ status: 200, json: { ticket: 'tkt' } }))
    const auth = createRelayClientAuth({ tokenPath, request })
    expect(await auth.getBrowserTicket({ peerId: 'p' })).toBe('tkt')
    const call = request.mock.calls[0][0]
    expect(call.headers.Authorization).toBe('Bearer tok-1')
    expect(call.url).toBe(`${RELAY_CLIENT_API_BASE}/client-ticket`)
  })

  it('ticket 401 clears the token', async () => {
    const tokenPath = tmpTokenPath()
    paired(tokenPath)
    const auth = createRelayClientAuth({ tokenPath, request: async () => ({ status: 401, json: { error: 'invalid_token' } }) })
    await expect(auth.getBrowserTicket()).rejects.toThrow('relay_client_unpaired')
    expect(fs.existsSync(tokenPath)).toBe(false)
  })

  it('unpaired throws without sending a request', async () => {
    const request = vi.fn()
    const auth = createRelayClientAuth({ tokenPath: tmpTokenPath(), request })
    await expect(auth.getBrowserTicket()).rejects.toThrow('relay_client_unpaired')
    await expect(auth.listDevices()).rejects.toThrow('relay_client_unpaired')
    expect(request).not.toHaveBeenCalled()
  })

  it('404 maps to relay_client_auth_unavailable', async () => {
    const tokenPath = tmpTokenPath()
    paired(tokenPath)
    const auth = createRelayClientAuth({ tokenPath, request: async () => ({ status: 404, json: null }) })
    await expect(auth.getBrowserTicket()).rejects.toThrow('relay_client_auth_unavailable')
  })

  it('getDevicePubKey found / not found', async () => {
    const tokenPath = tmpTokenPath()
    paired(tokenPath)
    const devices = [{ deviceId: 'd1', devicePubKey: 'PK1' }, { deviceId: 'd2', devicePubKey: 'PK2' }]
    const auth = createRelayClientAuth({ tokenPath, request: async () => ({ status: 200, json: { devices } }) })
    expect(await auth.getDevicePubKey('d2')).toBe('PK2')
    await expect(auth.getDevicePubKey('nope')).rejects.toThrow('device_not_found')
  })
})
