'use strict';

/**
 * web-remote-chat-send.test.cjs — cmd:chat:send awaits chatRunner.enqueueExternalPrompt and
 * returns { ok, disposition, reason? }; unknown/proposed targets are structured refusals.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-chat-send.test.cjs
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

let cwd
let send
let auditResultFor
const enqueue = vi.fn()

async function writeIndex(sessions) {
  const { opsPath } = require('../lib/opsOwnership.cjs')
  const file = opsPath(cwd, 'prompt-sessions', 'active-index.json')
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify({ sessions }))
}

beforeAll(async () => {
  const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-remote-chat-send-'))
  process.env.HOME = tmpHome
  cwd = path.join(tmpHome, 'proj')
  await fsp.mkdir(cwd, { recursive: true })

  const stub = (rel, exports) => {
    const p = require.resolve(rel)
    require.cache[p] = { id: p, filename: p, loaded: true, exports }
  }
  const electronPath = require.resolve('electron')
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      ipcMain: { handle: () => {}, on: () => {} },
      app: { getPath: () => tmpHome, getVersion: () => '0.0.0-test' },
    },
  }
  stub('../sessionsStore.cjs', {
    load: async () => ({ tabs: [{ id: 'tab-1', sessionId: 'sess-1', cwd }], activeTabId: 'tab-1' }),
  })
  stub('../chatRunner.cjs', { enqueueExternalPrompt: (...a) => enqueue(...a) })

  for (const mod of ['../webRemote.cjs', '../config.cjs', '../logs.cjs', '../lib/opsOwnership.cjs']) {
    try { delete require.cache[require.resolve(mod)] } catch { /* not yet loaded */ }
  }
  const webRemote = require('../webRemote.cjs')
  send = webRemote.__test.getDispatchMap()['cmd:chat:send']
  auditResultFor = webRemote.__test.auditResultFor
})

beforeEach(async () => {
  enqueue.mockReset()
  await writeIndex({})
})

describe('cmd:chat:send', () => {
  it.each([
    ['sent', { disposition: 'sent' }, { ok: true, disposition: 'sent' }],
    ['queued', { disposition: 'queued' }, { ok: true, disposition: 'queued' }],
    ['unconfirmed', { disposition: 'unconfirmed' }, { ok: true, disposition: 'unconfirmed' }],
    ['refused', { disposition: 'refused', reason: 'terminal-attached' }, { ok: false, disposition: 'refused', reason: 'terminal-attached' }],
  ])('open tab: %s', async (_n, r, expected) => {
    enqueue.mockResolvedValue(r)
    expect(await send({ tabId: 'sess-1', prompt: 'hi' })).toEqual(expected)
    expect(enqueue).toHaveBeenCalledWith('sess-1', 'hi')
  })

  it('active Epic passes sessionId + cwd', async () => {
    await writeIndex({ e1: { id: 'e1', status: 'active', claudeSessionId: 'cs-1', cwd } })
    enqueue.mockResolvedValue({ disposition: 'sent' })
    expect(await send({ tabId: 'e1', prompt: 'yo' })).toEqual({ ok: true, disposition: 'sent' })
    expect(enqueue).toHaveBeenCalledWith('e1', 'yo', { sessionId: 'cs-1', cwd })
  })

  it('proposed Epic → refused:proposed without enqueue', async () => {
    await writeIndex({ e2: { id: 'e2', status: 'proposed', cwd } })
    expect(await send({ tabId: 'e2', prompt: 'x' })).toEqual({ ok: false, disposition: 'refused', reason: 'proposed' })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('completed Epic → not-active', async () => {
    await writeIndex({ e3: { id: 'e3', status: 'completed', claudeSessionId: 'c', cwd } })
    expect(await send({ tabId: 'e3', prompt: 'x' })).toEqual({ ok: false, disposition: 'refused', reason: 'not-active' })
  })

  it('unknown target → refused:unknown-target', async () => {
    expect(await send({ tabId: 'nope', prompt: 'x' })).toEqual({ ok: false, disposition: 'refused', reason: 'unknown-target' })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('schema-invalid payload still throws', async () => {
    await expect(send({ prompt: 'x' })).rejects.toThrow()
  })
})

describe('auditResultFor', () => {
  it('logs refusals as refused[:reason], everything else ok', () => {
    expect(auditResultFor({ ok: false, disposition: 'refused', reason: 'proposed' })).toBe('refused:proposed')
    expect(auditResultFor({ ok: false, disposition: 'refused' })).toBe('refused')
    expect(auditResultFor({ ok: true, disposition: 'queued' })).toBe('ok')
    expect(auditResultFor({ ok: true })).toBe('ok')
    expect(auditResultFor(undefined)).toBe('ok')
  })
})
