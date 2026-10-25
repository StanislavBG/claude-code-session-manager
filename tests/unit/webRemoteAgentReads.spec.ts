import { describe, it, expect, vi, afterEach } from 'vitest'
import os from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { READ_COMMANDS, SAS_GATED_READS, ALLOWED_COMMANDS } = require('../../src/main/ipcSchemas.cjs')
// Outside Electron require('electron') is a path string; stub it so `app` exists.
const electronPath = require.resolve('electron')
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { ipcMain: { handle: () => {}, on: () => {} }, app: { getPath: () => '/tmp', getVersion: () => '1.2.3-test' } },
} as unknown as NodeJS.Module
const webRemote = require('../../src/main/webRemote.cjs')

afterEach(() => vi.restoreAllMocks())

describe('cmd:app:info', () => {
  it('returns version, platform and hostname', async () => {
    const r = await webRemote.__test.getDispatchMap()['cmd:app:info']()
    expect(Object.keys(r).sort()).toEqual(['hostname', 'platform', 'version'])
    expect(r).toEqual({ version: '1.2.3-test', platform: process.platform, hostname: os.hostname() })
  })

  it('is SAS-gated, not an ungated read', () => {
    expect(SAS_GATED_READS.has('cmd:app:info')).toBe(true)
    expect(READ_COMMANDS.has('cmd:app:info')).toBe(false)
    expect(ALLOWED_COMMANDS.has('cmd:app:info')).toBe(true)
  })

  it('removed desktop-client commands have no dispatch entry', () => {
    const map = webRemote.__test.getDispatchMap()
    for (const c of ['cmd:sessions:load', 'cmd:sessions:list', 'cmd:sessions:save', 'cmd:history:aggregate', 'cmd:app:version'])
      expect(map[c]).toBeUndefined()
  })
})
