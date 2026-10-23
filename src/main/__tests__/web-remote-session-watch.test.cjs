'use strict';

/**
 * web-remote-session-watch.test.cjs — phone live-state watcher: Main resolves the tab's
 * sessionId, late-appearing transcripts are picked up, and no summary push exists.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-session-watch.test.cjs
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { generateE2EKeyPair, deriveSessionKey, decryptBox } = require('../lib/feedback-remote/remoteE2eCrypto.cjs')

let tmpHome
let origHome
let webRemote
let cwd
let projDir

const assistantLine = (text) => JSON.stringify({
  type: 'assistant', uuid: 'u-' + text, message: { role: 'assistant', content: [{ type: 'text', text }] },
}) + '\n'

beforeAll(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-remote-session-watch-'))
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

  cwd = path.join(tmpHome, 'proj')
  await fsp.mkdir(cwd, { recursive: true })
  const { encodeCwd } = require('../lib/util/encodeCwd.cjs')
  projDir = path.join(tmpHome, '.claude', 'projects', encodeCwd(cwd))
  await fsp.mkdir(projDir, { recursive: true })

  const storePath = require.resolve('../sessionsStore.cjs')
  require.cache[storePath] = {
    id: storePath, filename: storePath, loaded: true,
    exports: { load: async () => ({ tabs: [{ id: 'tab-1', sessionId: 'sess-1', cwd }] }), save: async () => {} },
  }

  for (const mod of ['../webRemote.cjs', '../config.cjs', '../logs.cjs', '../transcripts.cjs']) {
    try { delete require.cache[require.resolve(mod)] } catch { /* not loaded */ }
  }
  webRemote = require('../webRemote.cjs')
})

afterAll(async () => {
  webRemote.__test.stopAllSessionWatches()
  process.env.HOME = origHome
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

describe('web-remote session watch', () => {
  it('Main subscribe watches <sessionId>.jsonl', async () => {
    const map = webRemote.__test.getDispatchMap()
    await map['cmd:session:subscribe']({ tabId: 'tab-1', cwd }, webRemote.__test.getClient('c1'))
    const w = webRemote.__test.getSessionWatcher('tab-1')
    expect(w.sessionId).toBe('sess-1')
    expect(path.basename(w.filePath)).toBe('sess-1.jsonl')
    webRemote.__test.stopAllSessionWatches()
  })

  it('picks up a transcript that appears after the watcher starts', async () => {
    webRemote.__test.startSessionWatch('late', cwd, 'late-sess')
    const w = webRemote.__test.getSessionWatcher('late')
    w.filePath = path.join(projDir, 'stale-missing.jsonl') // simulate a wrong/old resolution
    const real = path.join(projDir, 'late-sess.jsonl')
    await fsp.writeFile(real, assistantLine('hello'))
    await webRemote.__test.pollSessionWatcher(w)
    expect(w.filePath).toBe(real)
    expect(w.state).toBe('idle')
    webRemote.__test.stopAllSessionWatches()
  })

  it('pushes a state event on a new assistant line', async () => {
    const file = path.join(projDir, 'push-sess.jsonl')
    await fsp.writeFile(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n')
    webRemote.__test.startSessionWatch('push', cwd, 'push-sess')
    const w = webRemote.__test.getSessionWatcher('push')
    await webRemote.__test.pollSessionWatcher(w)
    expect(w.state).toBe('thinking')
    await fsp.appendFile(file, assistantLine('done'))
    await webRemote.__test.pollSessionWatcher(w)
    expect(w.state).toBe('idle')
    webRemote.__test.stopAllSessionWatches()
  })

  it('pushes a state event and never a summary event to a subscribed client', async () => {
    const a = generateE2EKeyPair()
    const b = generateE2EKeyPair()
    const key = deriveSessionKey(a.e2ePrivateKey, b.e2ePublicKey, 'device-watch')
    const sent = []
    webRemote.__test.setWs({ readyState: 1, send: (m) => sent.push(JSON.parse(m)), terminate: () => {} })
    webRemote.__test.setE2eAuthenticated(key, 'connS')
    webRemote.__test.getClient('connS').subscriptions.add('sum')
    try {
      const file = path.join(projDir, 'sum-sess.jsonl')
      await fsp.writeFile(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n')
      webRemote.__test.startSessionWatch('sum', cwd, 'sum-sess')
      const w = webRemote.__test.getSessionWatcher('sum')
      await webRemote.__test.pollSessionWatcher(w)
      await fsp.appendFile(file, assistantLine('finished'))
      await webRemote.__test.pollSessionWatcher(w)
      const types = sent
        .filter((m) => m.type === 'e2e:box')
        .map((m) => {
          const plain = decryptBox(m.payload.nonce, m.payload.ciphertext, key)
          return plain ? JSON.parse(plain).type : null
        })
      expect(types).toContain('event:session:state')
      expect(types).not.toContain('event:session:summary')
    } finally {
      webRemote.__test.stopAllSessionWatches()
      webRemote.__test.getClient('connS').subscriptions.clear()
      webRemote.__test.setWs(null)
    }
  })
})
