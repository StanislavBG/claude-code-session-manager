import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { SAS_GATED_READS, ALLOWED_COMMANDS } = require('../../src/main/ipcSchemas.cjs')
const sessionsStore = require('../../src/main/sessionsStore.cjs')
const epicMint = require('../../src/main/lib/epic/epicMint.cjs')
const epicPath = require('../../src/main/lib/epic/epicTranscriptPath.cjs')
const electronPath = require.resolve('electron')
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { ipcMain: { handle: () => {}, on: () => {} }, app: { getPath: () => '/tmp', getVersion: () => '1.2.3-test' } },
} as unknown as NodeJS.Module
const webRemote = require('../../src/main/webRemote.cjs')

const TYPES = ['cmd:projects:list', 'cmd:project:sessions', 'cmd:session:transcript']
const cwd = path.join(os.homedir(), 'drill-proj')
const dispatch = () => webRemote.__test.getDispatchMap()

function stubStore() {
  vi.spyOn(sessionsStore, 'load').mockResolvedValue({ tabs: [{ sessionId: 'main-1', cwd, label: 'Proj' }] })
  vi.spyOn(epicMint, 'readActiveIndex').mockReturnValue({
    sessions: { e1: { id: 'e1', claudeSessionId: 'cs-1', status: 'active', goalText: 'Do it', tag: 'build', agentType: 'dev-lead' } },
  })
}

afterEach(() => vi.restoreAllMocks())

describe('drill-down commands', () => {
  it('are SAS-gated and allowed', () => {
    for (const t of TYPES) {
      expect(SAS_GATED_READS.has(t)).toBe(true)
      expect(ALLOWED_COMMANDS.has(t)).toBe(true)
    }
  })

  it('projects:list and project:sessions return shapes', async () => {
    stubStore()
    const p = await dispatch()['cmd:projects:list']()
    expect(p.projects[0]).toMatchObject({ cwd, title: 'Proj', mainTabId: 'main-1' })
    const s = await dispatch()['cmd:project:sessions']({ cwd })
    expect(s.project.cwd).toBe(cwd)
    expect(s.sessions[0].epicId).toBe('e1')
  })

  it('unknown cwd throws', async () => {
    stubStore()
    await expect(dispatch()['cmd:project:sessions']({ cwd: '/nope' })).rejects.toThrow()
    await expect(dispatch()['cmd:session:transcript']({ cwd: '/nope', sessionKey: 'e1' })).rejects.toThrow()
  })

  it('transcript reads an Epic by id and by claudeSessionId; unknown => empty', async () => {
    stubStore()
    const dir = fs.mkdtempSync(path.join(os.homedir(), '.drill-'))
    const file = path.join(dir, 'cs-1.jsonl')
    fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n')
    try {
      vi.spyOn(epicPath, 'resolveEpicTranscriptPath').mockReturnValue({ path: file } as any)
      for (const sessionKey of ['e1', 'cs-1']) {
        const r = await dispatch()['cmd:session:transcript']({ cwd, sessionKey })
        expect(Array.isArray(r.messages)).toBe(true)
        expect(JSON.stringify(r.messages)).toContain('hello')
      }
      const none = await dispatch()['cmd:session:transcript']({ cwd, sessionKey: 'zzz' })
      expect(none).toEqual({ messages: [] })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('malformed sessionKey => ZodError', async () => {
    stubStore()
    await expect(dispatch()['cmd:session:transcript']({ cwd, sessionKey: '../x' })).rejects.toMatchObject({ name: 'ZodError' })
  })

  describe('cmd:session:prds', () => {
    const scheduler = require('../../src/main/scheduler.cjs')
    const entry = (slug: string, o: any = {}) => ({ slug, title: 't-' + slug, cwd, status: 'queued', archived: false, epicId: 'e1', body: 'SECRET', ...o })
    it('is SAS-gated', () => {
      expect(SAS_GATED_READS.has('cmd:session:prds')).toBe(true)
      expect(ALLOWED_COMMANDS.has('cmd:session:prds')).toBe(true)
    })
    it('projects, filters by epic, orders live first then slug, caps at 50', async () => {
      stubStore()
      const many = Array.from({ length: 60 }, (_, i) => entry('m' + String(i).padStart(2, '0')))
      vi.spyOn(scheduler, 'listPrdsInternal').mockResolvedValue([
        entry('b', { archived: true, status: 'completed' }), entry('z', { status: undefined }), entry('a'),
        entry('other', { epicId: 'e2' }), ...many,
      ])
      const r = await dispatch()['cmd:session:prds']({ cwd, epicId: 'e1' })
      expect(r.prds).toHaveLength(50)
      expect(r.prds[0]).toEqual({ slug: 'a', title: 't-a', status: 'queued', archived: false })
      expect(JSON.stringify(r)).not.toContain('SECRET')
      expect(r.prds.some((p: any) => p.slug === 'other')).toBe(false)
      vi.spyOn(scheduler, 'listPrdsInternal').mockResolvedValue([entry('b', { archived: true }), entry('z', { status: undefined }), entry('a')])
      const r2 = await dispatch()['cmd:session:prds']({ cwd, epicId: 'e1' })
      expect(r2.prds.map((p: any) => p.slug)).toEqual(['a', 'z', 'b'])
      expect(r2.prds[1].status).toBeNull()
      expect(r2.prds[2].archived).toBe(true)
    })
    it('unknown epic and unopened cwd throw', async () => {
      stubStore()
      vi.spyOn(scheduler, 'listPrdsInternal').mockResolvedValue([])
      await expect(dispatch()['cmd:session:prds']({ cwd, epicId: 'nope' })).rejects.toThrow()
      await expect(dispatch()['cmd:session:prds']({ cwd: '/nope', epicId: 'e1' })).rejects.toThrow()
    })
  })

  describe('cmd:chat:send target resolution', () => {
    const chatRunner = require('../../src/main/chatRunner.cjs')
    function stub(status: string) {
      vi.spyOn(sessionsStore, 'load').mockResolvedValue({ tabs: [{ sessionId: 'main-1', cwd, label: 'Proj' }] })
      vi.spyOn(epicMint, 'readActiveIndex').mockReturnValue({
        sessions: { e1: { id: 'e1', claudeSessionId: 'cs-1', status, cwd } },
      })
      return vi.spyOn(chatRunner, 'enqueueExternalPrompt').mockImplementation(() => {})
    }
    it('open tab id', async () => {
      const spy = stub('active')
      await expect(dispatch()['cmd:chat:send']({ tabId: 'main-1', prompt: 'hi' })).resolves.toEqual({ ok: true })
      expect(spy).toHaveBeenCalledWith('main-1', 'hi')
    })
    it('active Epic by epicId and claudeSessionId', async () => {
      const spy = stub('active')
      for (const tabId of ['e1', 'cs-1']) {
        await expect(dispatch()['cmd:chat:send']({ tabId, prompt: 'hi' })).resolves.toEqual({ ok: true })
        expect(spy).toHaveBeenLastCalledWith('e1', 'hi', { sessionId: 'cs-1', cwd })
      }
    })
    it('proposed, completed and unknown throw', async () => {
      const spy = stub('proposed')
      await expect(dispatch()['cmd:chat:send']({ tabId: 'e1', prompt: 'hi' })).rejects.toThrow()
      stub('completed')
      await expect(dispatch()['cmd:chat:send']({ tabId: 'cs-1', prompt: 'hi' })).rejects.toThrow()
      await expect(dispatch()['cmd:chat:send']({ tabId: 'nope', prompt: 'hi' })).rejects.toThrow()
      expect(spy).not.toHaveBeenCalled()
    })
  })

  it('finalizeE2eAuthenticated pushes event:remote:ready to that client only, never event:session:list', () => {
    const sent: string[] = []
    webRemote.__test.setWs({ readyState: 1, send: (m: string) => sent.push(m) })
    webRemote.__test.setConfigCache({ remoteEnabled: true })
    webRemote.__test.setE2eAuthenticated(Buffer.alloc(32, 7), 'ready-client')
    const client = webRemote.__test.getClient('ready-client')
    try {
      webRemote.__test.finalizeE2eAuthenticated('test', undefined)
      expect(sent).toHaveLength(0)
      webRemote.__test.finalizeE2eAuthenticated('test', client)
      expect(sent).toHaveLength(1)
      const out = JSON.parse(sent[0])
      expect(out.type).toBe('e2e:box')
      expect(out.toConn).toBe('ready-client')
      const { decryptBox } = require('../../src/main/lib/feedback-remote/remoteE2eCrypto.cjs')
      const inner = JSON.parse(decryptBox(out.payload.nonce, out.payload.ciphertext, client.e2e.sessionKey))
      expect(inner.type).toBe('event:remote:ready')
      expect(typeof inner.payload.ts).toBe('number')
      expect(sent.join('')).not.toContain('event:session:list')
    } finally {
      webRemote.__test.setWs(null)
      webRemote.__test.invalidateConfigCache()
    }
  })
})
