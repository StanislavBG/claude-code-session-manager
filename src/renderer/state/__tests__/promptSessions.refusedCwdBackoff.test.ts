import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const FENCE = "Error invoking remote method 'promptSessions:load-active-index': Error: cwd is not a registered project root"

function install() {
  const api = {
    promptSessions: {
      onEventAppended: vi.fn(),
      loadActiveIndex: vi.fn().mockRejectedValue(new Error(FENCE)),
      listArchived: vi.fn().mockResolvedValue({ ok: true, ids: [] }),
      readArchived: vi.fn().mockResolvedValue({ exists: false, data: null }),
    },
    logs: { write: vi.fn() },
  }
  vi.stubGlobal('window', { api })
  return api
}

async function load() {
  const mod = await import('../promptSessions')
  mod._resetForTests()
  return mod.usePromptSessions.getState()
}

describe('promptSessions refused-cwd backoff', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('skips the second hydrate inside the window', async () => {
    const api = install()
    const s = await load()
    await s.hydrate('/tmp/x')
    await s.hydrate('/tmp/x')
    expect(api.promptSessions.loadActiveIndex).toHaveBeenCalledTimes(1)
  })

  it('resumes after the window passes', async () => {
    const api = install()
    const s = await load()
    await s.hydrate('/tmp/x')
    vi.setSystemTime(new Date('2026-01-01T00:05:01Z'))
    await s.hydrate('/tmp/x')
    expect(api.promptSessions.loadActiveIndex).toHaveBeenCalledTimes(2)
  })

  it('writes exactly one warn for two refused polls, naming the cwd', async () => {
    const api = install()
    const s = await load()
    await s.hydrate('/tmp/x')
    await s.hydrate('/tmp/x')
    expect(api.logs.write).toHaveBeenCalledTimes(1)
    expect(api.logs.write.mock.calls[0][2]).toContain('/tmp/x')
  })

  it('does not mark on a non-refusal error', async () => {
    const api = install()
    api.promptSessions.loadActiveIndex.mockRejectedValue(new Error('EACCES: permission denied'))
    const s = await load()
    await s.hydrate('/p')
    await s.hydrate('/p')
    expect(api.promptSessions.loadActiveIndex).toHaveBeenCalledTimes(2)
    expect(api.logs.write).toHaveBeenCalledTimes(2)
  })

  it('hydrateArchived skips a cwd refused by hydrate', async () => {
    const api = install()
    const s = await load()
    await s.hydrate('/tmp/x')
    await s.hydrateArchived('/tmp/x')
    expect(api.promptSessions.listArchived).not.toHaveBeenCalled()
  })

  it('a path_fenced listArchived rejection marks the cwd so hydrate is skipped', async () => {
    const api = install()
    api.promptSessions.listArchived.mockRejectedValue(new Error('path_fenced'))
    const s = await load()
    await s.hydrateArchived('/tmp/y')
    await s.hydrate('/tmp/y')
    expect(api.promptSessions.loadActiveIndex).not.toHaveBeenCalled()
    expect(api.logs.write).toHaveBeenCalledTimes(1)
  })

  it('a resolved loadActiveIndex clears the mark', async () => {
    const api = install()
    const s = await load()
    await s.hydrate('/tmp/x')
    vi.setSystemTime(new Date('2026-01-01T00:06:00Z'))
    api.promptSessions.loadActiveIndex.mockResolvedValue({ exists: false, data: null })
    await s.hydrate('/tmp/x')
    api.promptSessions.loadActiveIndex.mockRejectedValue(new Error(FENCE))
    await s.hydrate('/tmp/x')
    expect(api.promptSessions.loadActiveIndex).toHaveBeenCalledTimes(3)
  })
})
