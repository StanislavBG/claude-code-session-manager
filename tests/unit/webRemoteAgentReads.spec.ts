import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { READ_COMMANDS, SAS_GATED_READS, ALLOWED_COMMANDS } = require('../../src/main/ipcSchemas.cjs')
const sessionsStore = require('../../src/main/sessionsStore.cjs')
const epicMint = require('../../src/main/lib/epicMint.cjs')
// Outside Electron require('electron') is a path string; stub it so `app` exists.
const electronPath = require.resolve('electron')
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { ipcMain: { handle: () => {}, on: () => {} }, app: { getPath: () => '/tmp', getVersion: () => '1.2.3-test' } },
} as unknown as NodeJS.Module
const webRemote = require('../../src/main/webRemote.cjs')

afterEach(() => vi.restoreAllMocks())

describe('cmd:app:info / cmd:sessions:list', () => {
  it('app:info returns exactly version and platform', async () => {
    const r = await webRemote.__test.getDispatchMap()['cmd:app:info']()
    expect(Object.keys(r).sort()).toEqual(['platform', 'version'])
    expect(r).toEqual({ version: '1.2.3-test', platform: process.platform })
  })

  it('sessions:list returns project rows followed by active Epic rows', async () => {
    vi.spyOn(sessionsStore, 'load').mockResolvedValue({
      tabs: [{ sessionId: 't1', cwd: '/p/alpha', label: '' }],
      activeTabId: 't1',
    })
    vi.spyOn(epicMint, 'readActiveIndex').mockReturnValue({
      sessions: {
        a: { id: 'a', claudeSessionId: 'cs-a', cwd: '/p/alpha', status: 'active', goalText: 'Goal a', tag: 'build', agentType: 'dev-lead' },
      },
    })
    const r = await webRemote.__test.getDispatchMap()['cmd:sessions:list']()
    expect(r.activeTabId).toBe('t1')
    expect(r.sessions.map((s: any) => s.kind)).toEqual(['project', 'epic'])
    expect(r.sessions[1].epicId).toBe('a')
  })

  it('sessions:list defaults activeTabId to null', async () => {
    vi.spyOn(sessionsStore, 'load').mockResolvedValue({ tabs: [] })
    const r = await webRemote.__test.getDispatchMap()['cmd:sessions:list']()
    expect(r).toEqual({ sessions: [], activeTabId: null })
  })

  it('sessions:list is SAS-gated, app:info is an ungated read', () => {
    expect(SAS_GATED_READS.has('cmd:sessions:list')).toBe(true)
    expect(READ_COMMANDS.has('cmd:sessions:list')).toBe(false)
    expect(READ_COMMANDS.has('cmd:app:info')).toBe(true)
    expect(SAS_GATED_READS.has('cmd:app:info')).toBe(false)
    expect(ALLOWED_COMMANDS.has('cmd:sessions:list')).toBe(true)
    expect(ALLOWED_COMMANDS.has('cmd:app:info')).toBe(true)
  })
})
