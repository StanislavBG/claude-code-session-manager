'use strict'

import { describe, it, expect, vi } from 'vitest'
const {
  captureIpcHandlers,
  createRemoteIpcDispatcher,
  chunkFrames,
  joinFrames,
  remoteArgFence,
} = require('../remoteIpcDispatch.cjs')

const surface = [
  { channel: 'r:read', kind: 'invoke', remote: 'read' },
  { channel: 'm:mut', kind: 'invoke', remote: 'mutate' },
  { channel: 'd:deny', kind: 'invoke', remote: 'deny' },
  { channel: 'boom', kind: 'invoke', remote: 'read' },
  { channel: 'evt', kind: 'on', remote: 'read' },
]
const authed = { key: 'c1', e2e: { state: 'authenticated' } }
const unauthed = { key: 'c2', e2e: { state: 'idle' } }
const fullCfg = { remoteEnabled: true, remoteControlEnabled: true }

function setup(cfg = fullCfg) {
  const fns = {
    'r:read': vi.fn(async (_e, a) => ({ got: a })),
    'm:mut': vi.fn(async () => 'done'),
    'd:deny': vi.fn(),
    boom: vi.fn(async () => { throw new Error('kaboom') }),
    evt: vi.fn(),
  }
  const handlers = new Map(Object.entries(fns))
  return { fns, d: createRemoteIpcDispatcher({ surface, handlers, getConfig: () => cfg }) }
}

describe('captureIpcHandlers', () => {
  it('records and still calls original', () => {
    const orig = vi.fn()
    const ipcMain = { handle: orig }
    const map = captureIpcHandlers(ipcMain)
    const fn = () => 1
    ipcMain.handle('x', fn)
    expect(map.get('x')).toBe(fn)
    expect(orig).toHaveBeenCalledWith('x', fn)
  })
})

describe('invoke refusals', () => {
  it('unknown channel, non-invokable kind, deny', async () => {
    const { d, fns } = setup()
    expect(await d.invoke(authed, 'nope', [])).toEqual({ ok: false, reason: 'not_in_surface' })
    expect(await d.invoke(authed, 'evt', [])).toEqual({ ok: false, reason: 'not_in_surface' })
    expect(await d.invoke(authed, 'd:deny', [])).toEqual({ ok: false, reason: 'denied' })
    expect(fns['d:deny']).not.toHaveBeenCalled()
  })
  it('unauthenticated client', async () => {
    const { d, fns } = setup()
    expect(await d.invoke(unauthed, 'r:read', [])).toEqual({ ok: false, reason: 'e2e_not_authenticated' })
    expect(fns['r:read']).not.toHaveBeenCalled()
  })
  it('mutate needs both flags', async () => {
    for (const cfg of [{ remoteEnabled: true }, { remoteEnabled: true, remoteControlEnabled: false }]) {
      const { d, fns } = setup(cfg)
      expect(await d.invoke(authed, 'm:mut', [])).toEqual({ ok: false, reason: 'mutate_not_allowed' })
      expect(fns['m:mut']).not.toHaveBeenCalled()
    }
    const { d } = setup({ remoteEnabled: false, remoteControlEnabled: true })
    expect((await d.invoke(authed, 'm:mut', [])).ok).toBe(false)
  })
})

describe('invoke allowed', () => {
  it('read runs handler with synthetic event', async () => {
    const { d, fns } = setup({ remoteEnabled: true })
    expect(await d.invoke(authed, 'r:read', [1, 2])).toEqual({ ok: true, result: { got: 1 } })
    expect(fns['r:read']).toHaveBeenCalledWith({ sender: null, remoteClientId: 'c1' }, 1, 2)
  })
  it('mutate runs when enabled', async () => {
    const { d } = setup()
    expect(await d.invoke(authed, 'm:mut', [])).toEqual({ ok: true, result: 'done' })
  })
  it('handler error', async () => {
    const { d } = setup()
    expect(await d.invoke(authed, 'boom', [])).toEqual({ ok: false, reason: 'handler_error', message: 'kaboom' })
  })
})

describe('chunking', () => {
  const sizes = [1, 180000, 2 * 1024 * 1024]
  for (const n of sizes) {
    it(`round-trips ${n} bytes`, () => {
      const value = { s: 'é'.repeat(Math.ceil(n / 2)).slice(0, n), n }
      const r = chunkFrames(value)
      expect(r.ok).toBe(true)
      r.frames.forEach((f, i) => {
        expect(f.seq).toBe(i)
        expect(f.total).toBe(r.frames.length)
        expect(Buffer.byteLength(f.data)).toBeLessThan(180000)
      })
      expect(joinFrames([...r.frames].reverse())).toEqual(value)
    })
  }
  it('refuses over 50 MB', () => {
    const r = chunkFrames('x'.repeat(50 * 1024 * 1024 + 1))
    expect(r).toEqual({ ok: false, reason: 'too_large' })
  })
})

describe('remoteArgFence', () => {
  const links = { '/home/u/proj/link': '/home/u/.ssh' }
  const mk = (platform = 'linux') => ({
    homeDir: '/home/u',
    projectRoots: () => ['/home/u/proj'],
    realpath: (p) => {
      for (const [k, v] of Object.entries(links)) if (p === k || p.startsWith(k + '/')) return v + p.slice(k.length)
      return p
    },
    platform,
  })
  const f = (ch, p, ctx = mk()) => remoteArgFence(ch, [{ path: p }], ctx)
  const fenced = { ok: false, reason: 'path_fenced' }
  it('allows a project file', () => expect(f('files:read', '/home/u/proj/a.ts')).toEqual({ ok: true }))
  it('refuses home file outside projects', () => expect(f('files:read', '/home/u/notes.txt')).toEqual(fenced))
  it('refuses ~/.ssh key', () => expect(f('files:read', '/home/u/.ssh/id_ed25519')).toEqual(fenced))
  it('refuses symlink into ~/.ssh', () => expect(f('files:read', '/home/u/proj/link/key')).toEqual(fenced))
  it('refuses .env and .env.local inside project', () => {
    expect(f('files:read', '/home/u/proj/.env')).toEqual(fenced)
    expect(f('files:read', '/home/u/proj/.env.local')).toEqual(fenced)
  })
  it('refuses win32 upper-case variant', () => {
    const ctx = { ...mk('win32'), homeDir: 'C:\\Users\\u', projectRoots: () => ['C:\\Users\\u\\proj'], realpath: (p) => p }
    expect(f('files:read', 'C:\\Users\\u\\proj\\.SSH\\ID_RSA', ctx)).toEqual(fenced)
    expect(f('files:read', 'C:\\Users\\u\\proj\\a.ts', ctx)).toEqual({ ok: true })
  })
  it('allows home listing only for files:list', () => {
    expect(f('files:list', '/home/u')).toEqual({ ok: true })
    expect(f('files:read', '/home/u')).toEqual(fenced)
    expect(f('files:list', '/home/u/other')).toEqual(fenced)
  })
  it('ignores unfenced channels and fences invoke before the handler', async () => {
    expect(remoteArgFence('app:version', [], mk())).toEqual({ ok: true })
    const fn = vi.fn(async () => 'x')
    const d = createRemoteIpcDispatcher({
      surface: [{ channel: 'files:read', kind: 'invoke', remote: 'read' }],
      handlers: new Map([['files:read', fn]]),
      getConfig: () => ({ remoteEnabled: true }),
      fenceCtx: mk(),
    })
    expect(await d.invoke(authed, 'files:read', [{ path: '/home/u/.ssh/id_rsa' }])).toEqual(fenced)
    expect(fn).not.toHaveBeenCalled()
    expect((await d.invoke(authed, 'files:read', [{ path: '/home/u/proj/a' }])).ok).toBe(true)
  })
})
