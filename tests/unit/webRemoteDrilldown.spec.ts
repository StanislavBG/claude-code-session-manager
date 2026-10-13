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
