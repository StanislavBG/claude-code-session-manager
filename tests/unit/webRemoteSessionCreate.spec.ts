import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ipc = require('../../src/main/ipcSchemas.cjs')
const { schemas, MUTATE_COMMANDS, SAS_GATED_READS, ALLOWED_COMMANDS, READ_COMMANDS } = ipc

const valid = {
  cwd: '/tmp/proj',
  agentName: 'dev-lead',
  tag: 'feature',
  title: 'Hello',
  prompt: 'do the thing',
}

describe('remoteSessionCreate schema', () => {
  it('accepts valid input', () => {
    expect(schemas.remoteSessionCreate.safeParse(valid).success).toBe(true)
  })
  it('rejects a bad tag', () => {
    expect(schemas.remoteSessionCreate.safeParse({ ...valid, tag: 'nope' }).success).toBe(false)
  })
  it('rejects an oversize prompt', () => {
    const prompt = 'a'.repeat(100 * 1024 + 1)
    expect(schemas.remoteSessionCreate.safeParse({ ...valid, prompt }).success).toBe(false)
  })
  it('rejects a bad agentName', () => {
    expect(schemas.remoteSessionCreate.safeParse({ ...valid, agentName: '../evil' }).success).toBe(false)
  })
})

describe('command tiers', () => {
  it('session:create is MUTATE, session:options is SAS-gated read', () => {
    expect(MUTATE_COMMANDS.has('cmd:session:create')).toBe(true)
    expect(SAS_GATED_READS.has('cmd:session:options')).toBe(true)
    expect(READ_COMMANDS.has('cmd:session:create')).toBe(false)
    expect(READ_COMMANDS.has('cmd:session:options')).toBe(false)
    expect(ALLOWED_COMMANDS.has('cmd:session:create')).toBe(true)
    expect(ALLOWED_COMMANDS.has('cmd:session:options')).toBe(true)
  })
})

describe('dispatch handlers', () => {
  const sessionsStore = require('../../src/main/sessionsStore.cjs')
  const agentLibrary = require('../../src/main/agentLibrary.cjs')
  const chatRunner = require('../../src/main/chatRunner.cjs')
  const webRemote = require('../../src/main/webRemote.cjs')

  afterEach(() => vi.restoreAllMocks())

  function setup() {
    vi.spyOn(sessionsStore, 'load').mockResolvedValue({
      tabs: [{ sessionId: 's1', cwd: '/tmp/proj', label: 'Proj' }],
      activeTabId: null,
      freshStart: false,
    })
    vi.spyOn(agentLibrary, 'listPersonas').mockResolvedValue([{ name: 'dev-lead', description: 'd' }])
    const spy = vi.spyOn(chatRunner, 'requestExternalNewSession').mockImplementation(() => {})
    return { map: webRemote.__test.getDispatchMap(), spy }
  }

  it('rejects an unknown cwd', async () => {
    const { map, spy } = setup()
    await expect(map['cmd:session:create']({ ...valid, cwd: '/etc' })).rejects.toThrow()
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects an unknown persona', async () => {
    const { map, spy } = setup()
    await expect(map['cmd:session:create']({ ...valid, agentName: 'ghost' })).rejects.toThrow()
    expect(spy).not.toHaveBeenCalled()
  })

  it('valid call triggers requestExternalNewSession', async () => {
    const { map, spy } = setup()
    await expect(map['cmd:session:create'](valid)).resolves.toEqual({ ok: true })
    expect(spy).toHaveBeenCalledWith(valid)
  })

  it('options returns projects and agents', async () => {
    const { map } = setup()
    const out = await map['cmd:session:options']()
    expect(out.projects).toEqual([{ cwd: '/tmp/proj', title: 'Proj' }])
    expect(out.agents).toEqual([{ name: 'dev-lead', description: 'd' }])
    expect(Array.isArray(out.tags)).toBe(true)
    expect(Array.isArray(out.macros)).toBe(true)
  })
})
