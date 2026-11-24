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
    expect(enqueue).toHaveBeenCalledWith('sess-1', 'hi', { relay: 'web-remote' })
  })

  it('active Epic passes sessionId + cwd', async () => {
    await writeIndex({ e1: { id: 'e1', status: 'active', claudeSessionId: 'cs-1', cwd } })
    enqueue.mockResolvedValue({ disposition: 'sent' })
    expect(await send({ tabId: 'e1', prompt: 'yo' })).toEqual({ ok: true, disposition: 'sent' })
    expect(enqueue).toHaveBeenCalledWith('e1', 'yo', { sessionId: 'cs-1', cwd, relay: 'web-remote' })
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

describe('cmd:chat:send with images', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')])
  const png = (name = 'shot.png') => ({ name, mime: 'image/png', data: PNG.toString('base64') })
  const attachDir = () => path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'attachments')
  const listAttach = async () => { try { return await fsp.readdir(attachDir()) } catch { return [] } }

  beforeEach(async () => {
    await fsp.rm(attachDir(), { recursive: true, force: true })
  })

  it('image + text to an active Epic saves identical bytes and appends the Attached line', async () => {
    await writeIndex({ e1: { id: 'e1', status: 'active', claudeSessionId: 'cs-1', cwd } })
    enqueue.mockResolvedValue({ disposition: 'sent' })
    const res = await send({ tabId: 'e1', prompt: 'look', images: [png()] })
    const files = await listAttach()
    expect(files).toHaveLength(1)
    const abs = path.join(attachDir(), files[0])
    expect(Buffer.compare(await fsp.readFile(abs), PNG)).toBe(0)
    expect(res).toEqual({ ok: true, disposition: 'sent', attachments: [files[0]] })
    const [id, prompt, extra] = enqueue.mock.calls[0]
    expect(id).toBe('e1')
    expect(prompt).toBe(`look\n\nAttached: ${abs}`)
    expect(prompt.endsWith(`Attached: ${abs}`)).toBe(true)
    expect(extra).toEqual({ sessionId: 'cs-1', cwd, relay: 'web-remote' })
  })

  it('image-only send to an open tab', async () => {
    enqueue.mockResolvedValue({ disposition: 'queued' })
    const res = await send({ tabId: 'sess-1', prompt: '', images: [png()] })
    const files = await listAttach()
    expect(files).toHaveLength(1)
    expect(res).toEqual({ ok: true, disposition: 'queued', attachments: files })
    expect(enqueue).toHaveBeenCalledWith('sess-1', `Attached: ${path.join(attachDir(), files[0])}`, { relay: 'web-remote' })
  })

  it('empty prompt without images still throws', async () => {
    await expect(send({ tabId: 'sess-1', prompt: '  ' })).rejects.toThrow()
  })

  it('7 images → attachment-invalid', async () => {
    const res = await send({ tabId: 'sess-1', prompt: 'x', images: Array.from({ length: 7 }, () => png()) })
    expect(res).toEqual({ ok: false, disposition: 'refused', reason: 'attachment-invalid' })
    expect(enqueue).not.toHaveBeenCalled()
    expect(await listAttach()).toEqual([])
  })

  it('bad mime → attachment-invalid', async () => {
    const res = await send({ tabId: 'sess-1', prompt: 'x', images: [{ ...png(), mime: 'image/svg+xml' }] })
    expect(res).toEqual({ ok: false, disposition: 'refused', reason: 'attachment-invalid' })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('bad magic bytes → attachment-invalid with nothing written', async () => {
    const res = await send({ tabId: 'sess-1', prompt: 'x', images: [{ ...png(), data: Buffer.from('not an image!').toString('base64') }] })
    expect(res).toEqual({ ok: false, disposition: 'refused', reason: 'attachment-invalid' })
    expect(enqueue).not.toHaveBeenCalled()
    expect(await listAttach()).toEqual([])
  })

  it('proposed Epic → refused with no file written', async () => {
    await writeIndex({ e2: { id: 'e2', status: 'proposed', cwd } })
    expect(await send({ tabId: 'e2', prompt: 'x', images: [png()] })).toEqual({ ok: false, disposition: 'refused', reason: 'proposed' })
    expect(await listAttach()).toEqual([])
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('enqueue refused → saved file removed', async () => {
    enqueue.mockResolvedValue({ disposition: 'refused', reason: 'terminal-attached' })
    const res = await send({ tabId: 'sess-1', prompt: 'x', images: [png()] })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('terminal-attached')
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(await listAttach()).toEqual([])
  })

  it('enqueue unconfirmed → saved file kept', async () => {
    enqueue.mockResolvedValue({ disposition: 'unconfirmed' })
    const res = await send({ tabId: 'sess-1', prompt: 'x', images: [png()] })
    const files = await listAttach()
    expect(files).toHaveLength(1)
    expect(res).toEqual({ ok: true, disposition: 'unconfirmed', attachments: files })
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
