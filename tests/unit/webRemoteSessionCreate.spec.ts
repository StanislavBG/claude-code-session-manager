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
  it('accepts macroId + inputs', () => {
    expect(schemas.remoteSessionCreate.safeParse({ ...valid, macroId: 'abc-1', inputs: { mode: 'review' } }).success).toBe(true)
  })
  it('rejects a bad macroId', () => {
    expect(schemas.remoteSessionCreate.safeParse({ ...valid, macroId: 'Bad Id' }).success).toBe(false)
  })
  it('rejects a bad input key', () => {
    expect(schemas.remoteSessionCreate.safeParse({ ...valid, macroId: 'abc', inputs: { 'bad key!': 'x' } }).success).toBe(false)
  })
  it('rejects a 2001-char value', () => {
    expect(schemas.remoteSessionCreate.safeParse({ ...valid, macroId: 'abc', inputs: { mode: 'a'.repeat(2001) } }).success).toBe(false)
  })
  it('rejects 21 keys', () => {
    const inputs = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'x']))
    expect(schemas.remoteSessionCreate.safeParse({ ...valid, macroId: 'abc', inputs }).success).toBe(false)
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

  const portfolio = {
    id: 'startup-portfolio-fcec18',
    label: 'Portfolio Optimization',
    agentName: 'dev-lead',
    tag: 'discussion',
    projects: ['/tmp/proj'],
    surface: 'sessions',
    inputs: [
      { name: 'mode', label: 'Mode', default: 'auto', required: true, options: ['auto', 'early-check', 'review'] },
      { name: 'focus', label: 'Focus', default: 'none' },
      { name: 'instructions', label: 'Instructions', default: 'none' },
      { name: 'data', label: 'Data / links', default: 'none' },
    ],
    prompt: 'Owner inputs for this run:\n- Mode: {{mode}}\n- Focus: {{focus}}\n- Instructions: {{instructions}}\n- Data / links: {{data}}',
  }

  function setupMacro(macro = portfolio) {
    const ctx = setup()
    const macroLibrary = require('../../src/main/lib/persona-macro/macroLibrary.cjs')
    vi.spyOn(macroLibrary, 'listMacros').mockResolvedValue([macro])
    return ctx
  }

  it('macro without inputs forwards the default lines', async () => {
    const { map, spy } = setupMacro()
    await map['cmd:session:create']({ ...valid, tag: 'discussion', macroId: portfolio.id, prompt: portfolio.prompt })
    const sent = spy.mock.calls[0][0] as { prompt: string }
    expect(Object.keys(sent).sort()).toEqual(['agentName', 'cwd', 'prompt', 'tag', 'title'])
    expect(sent.prompt).not.toContain('{{')
    expect(sent.prompt.endsWith('- Mode: auto\n- Focus: none\n- Instructions: none\n- Data / links: none')).toBe(true)
  })

  it('macro forwards typed inputs', async () => {
    const { map, spy } = setupMacro()
    await map['cmd:session:create']({
      ...valid, tag: 'discussion', macroId: portfolio.id, prompt: portfolio.prompt,
      inputs: { mode: 'review', focus: 'Bilko' },
    })
    const p = (spy.mock.calls[0][0] as { prompt: string }).prompt
    expect(p).toContain('- Mode: review')
    expect(p).toContain('- Focus: Bilko')
    expect(p).not.toContain('{{')
  })

  it('rejects a bogus mode', async () => {
    const { map, spy } = setupMacro()
    await expect(map['cmd:session:create']({
      ...valid, tag: 'discussion', macroId: portfolio.id, prompt: portfolio.prompt, inputs: { mode: 'bogus' },
    })).rejects.toThrow()
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects a macro not visible to the cwd', async () => {
    const { map, spy } = setupMacro({ ...portfolio, projects: ['/elsewhere'] })
    await expect(map['cmd:session:create']({
      ...valid, tag: 'discussion', macroId: portfolio.id, prompt: portfolio.prompt,
    })).rejects.toThrow('unknown macro')
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects an unknown macro id', async () => {
    const { map, spy } = setupMacro()
    await expect(map['cmd:session:create']({ ...valid, macroId: 'nope' })).rejects.toThrow('unknown macro')
    expect(spy).not.toHaveBeenCalled()
  })

  it('options returns projects and agents', async () => {
    const { map } = setup()
    const out = await map['cmd:session:options']()
    expect(out.projects).toEqual([{ cwd: '/tmp/proj', title: 'Proj' }])
    expect(out.agents).toEqual([{ name: 'dev-lead', description: 'd' }])
    expect(Array.isArray(out.tags)).toBe(true)
    expect(Array.isArray(out.macros)).toBe(true)
    expect(out.macroInputs).toBe(true)
  })
})
