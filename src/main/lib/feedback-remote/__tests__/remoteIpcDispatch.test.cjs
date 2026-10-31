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

describe('chunking fits the relay after encoding', () => {
  const { encryptBox } = require('../remoteE2eCrypto.cjs')
  const key = require('crypto').randomBytes(32)
  const N = 1_400_000
  const values = {
    quotes: '"'.repeat(N),
    backslashes: '\\'.repeat(N),
    control: '\u0001\n\t'.repeat(Math.ceil(N / 3)),
    multibyte: '€😀é'.repeat(Math.ceil(N / 9)),
    mixed: '"\\\u0002é€😀x'.repeat(Math.ceil(N / 10)),
  }
  for (const [name, str] of Object.entries(values)) {
    it(`${name}: every e2e:box < 256 KiB and round-trips`, () => {
      const value = { s: str }
      const r = chunkFrames(value)
      expect(r.ok).toBe(true)
      for (const f of r.frames) {
        expect(Buffer.byteLength(JSON.stringify(f.data)) - 2).toBeLessThanOrEqual(180000)
        const inner = { type: 'ipc:result', id: 'call-1', seq: f.seq, total: f.total, data: f.data, ts: Date.now() }
        const { nonce, ciphertext } = encryptBox(JSON.stringify(inner), key)
        const out = { type: 'e2e:box', id: 'call-1', payload: { nonce, ciphertext }, ts: Date.now(), toConn: 'conn-1234567890' }
        expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(256 * 1024)
      }
      expect(joinFrames(r.frames)).toEqual(value)
    })
  }
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
  describe('home / ancestor roots are ignored', () => {
    const withRoots = (roots) => ({ ...mk(), projectRoots: () => roots })
    it('home registered as a root does not expose ~/notes.txt', () => {
      expect(f('files:read', '/home/u/notes.txt', withRoots(['/home/u']))).toEqual(fenced)
    })
    it('/ registered as a root does not expose ~/notes.txt or /etc/hosts', () => {
      expect(f('files:read', '/home/u/notes.txt', withRoots(['/']))).toEqual(fenced)
      expect(f('files:read', '/etc/hosts', withRoots(['/']))).toEqual(fenced)
    })
    it('win32 drive root is ignored', () => {
      const ctx = { ...mk('win32'), homeDir: 'C:\\Users\\u', projectRoots: () => ['C:\\'], realpath: (p) => p }
      expect(f('files:read', 'C:\\Users\\u\\notes.txt', ctx)).toEqual(fenced)
    })
    it('a real project root alongside a home root still reads its files', () => {
      expect(f('files:read', '/home/u/proj/a.ts', withRoots(['/home/u', '/home/u/proj']))).toEqual({ ok: true })
    })
    it('files:list of home itself still works with home registered', () => {
      expect(f('files:list', '/home/u', withRoots(['/home/u']))).toEqual({ ok: true })
    })
  })

  describe('credential stores are refused', () => {
    const denied = [
      '/home/u/.claude/session-manager/web-remote.json',
      '/home/u/proj/.claude/session-manager/x/y.json',
      '/home/u/proj/.claude.json',
      '/home/u/proj/.config/gh/hosts.yml',
      '/home/u/proj/.git-credentials',
      '/home/u/proj/.config/git/credentials',
      '/home/u/proj/.pypirc',
      '/home/u/proj/.cargo/credentials',
      '/home/u/proj/.cargo/credentials.toml',
      '/home/u/proj/.local/share/keyrings/login.keyring',
      '/home/u/proj/.password-store/a.gpg',
      '/home/u/proj/.azure/accessTokens.json',
      '/home/u/proj/.terraform.d/credentials.tfrc.json',
      '/home/u/proj/Library/Keychains/login.keychain-db',
      '/home/u/proj/AppData/Roaming/Microsoft/Credentials/abc',
      '/home/u/proj/AppData/Local/Microsoft/Credentials/abc',
    ]
    it.each(denied)('refuses %s', (p) => expect(f('files:read', p)).toEqual(fenced))
    it('does not refuse near-misses', () => {
      expect(f('files:read', '/home/u/proj/.config/ghx/a')).toEqual({ ok: true })
      expect(f('files:read', '/home/u/proj/.claude/other.json')).toEqual({ ok: true })
    })
    it('win32 upper-case variants are refused', () => {
      const ctx = { ...mk('win32'), homeDir: 'C:\\Users\\u', projectRoots: () => ['C:\\Users\\u\\proj'], realpath: (p) => p }
      expect(f('files:read', 'C:\\Users\\u\\proj\\.CLAUDE\\Session-Manager\\a.json', ctx)).toEqual(fenced)
      expect(f('files:read', 'C:\\Users\\u\\proj\\APPDATA\\ROAMING\\MICROSOFT\\CREDENTIALS\\x', ctx)).toEqual(fenced)
      expect(f('files:read', 'C:\\Users\\u\\proj\\.Claude.JSON', ctx)).toEqual(fenced)
    })
    it('win32 8.3 short names are refused once realpath expands them', () => {
      const ctx = {
        ...mk('win32'), homeDir: 'C:\\Users\\u', projectRoots: () => ['C:\\Users\\u\\proj'],
        realpath: (p) => p.replace('CLAUDE~1', '.claude').replace('SESSIO~1', 'session-manager'),
      }
      expect(f('files:read', 'C:\\Users\\u\\proj\\CLAUDE~1\\SESSIO~1\\web-remote.json', ctx)).toEqual(fenced)
      expect(f('files:read', 'proj\\CLAUDE~1\\SESSIO~1\\web-remote.json', ctx)).toEqual(fenced)
    })
    it('win32 trailing dots and spaces are ignored when matching', () => {
      const ctx = { ...mk('win32'), homeDir: 'C:\\Users\\u', projectRoots: () => ['C:\\Users\\u\\proj'], realpath: (p) => p }
      expect(f('files:read', 'C:\\Users\\u\\proj\\.claude.json.', ctx)).toEqual(fenced)
      expect(f('files:read', 'C:\\Users\\u\\proj\\.ssh \\id_ed25519', ctx)).toEqual(fenced)
    })
    it('posix does not strip trailing dots', () => {
      expect(f('files:read', '/home/u/proj/.claude.json.')).toEqual({ ok: true })
    })
    it('refuses a symlink inside a project pointing into ~/.claude/session-manager', () => {
      const ctx = {
        ...mk(),
        realpath: (p) => (p === '/home/u/proj/sm' || p.startsWith('/home/u/proj/sm/')
          ? '/home/u/.claude/session-manager' + p.slice('/home/u/proj/sm'.length) : p),
      }
      expect(f('files:read', '/home/u/proj/sm/web-remote.json', ctx)).toEqual(fenced)
    })
  })
})
