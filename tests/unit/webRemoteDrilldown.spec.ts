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
})
