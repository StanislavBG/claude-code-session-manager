import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __flushProjectsPrefsForTests, __resetProjectsPrefsHydrateForTests, useProjectsPrefs } from '../projectsPrefs'
import { useToast } from '../toast'

type Pins = Record<string, boolean>

let disk: { pinned: Pins } | null
let readJson: ReturnType<typeof vi.fn>
let writeJson: ReturnType<typeof vi.fn>

beforeEach(() => {
  disk = { pinned: { '/a': true } }
  readJson = vi.fn(async () =>
    disk ? { exists: true, data: JSON.parse(JSON.stringify(disk)) } : { exists: false, data: null })
  writeJson = vi.fn(async (_f: string, data: { pinned: Pins }) => { disk = data })
  ;(globalThis as unknown as { window: unknown }).window = { api: { config: { readJson, writeJson } } }
  __resetProjectsPrefsHydrateForTests()
  useProjectsPrefs.setState({ pinned: {}, hydrated: false })
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
})

describe('projectsPrefs', () => {
  it('togglePin before hydrate keeps the pins already on disk', async () => {
    useProjectsPrefs.getState().togglePin('/b')
    await __flushProjectsPrefsForTests()
    expect(writeJson).toHaveBeenCalledTimes(1)
    expect(writeJson.mock.calls[0][1]).toEqual({ pinned: { '/a': true, '/b': true } })
    expect(useProjectsPrefs.getState().pinned).toEqual({ '/a': true, '/b': true })
  })

  it('unpinning removes the key', async () => {
    useProjectsPrefs.getState().togglePin('/a')
    await __flushProjectsPrefsForTests()
    expect(writeJson.mock.calls[0][1]).toEqual({ pinned: {} })
  })

  it('two concurrent toggles both land', async () => {
    useProjectsPrefs.getState().togglePin('/b')
    useProjectsPrefs.getState().togglePin('/c')
    await __flushProjectsPrefsForTests()
    expect(disk).toEqual({ pinned: { '/a': true, '/b': true, '/c': true } })
    expect(useProjectsPrefs.getState().pinned).toEqual({ '/a': true, '/b': true, '/c': true })
  })

  it('a rejected write toasts and reverts to the last-read pins', async () => {
    writeJson.mockRejectedValueOnce(new Error('disk full'))
    useProjectsPrefs.getState().togglePin('/b')
    await __flushProjectsPrefsForTests()
    expect(useProjectsPrefs.getState().pinned).toEqual({ '/a': true })
    expect(useToast.getState().toasts.some((t) => t.kind === 'error')).toBe(true)
  })

  it('hydrate is idempotent and loads the file', async () => {
    const s = useProjectsPrefs.getState()
    await Promise.all([s.hydrate(), s.hydrate()])
    await s.hydrate()
    expect(readJson).toHaveBeenCalledTimes(1)
    expect(useProjectsPrefs.getState()).toMatchObject({ hydrated: true, pinned: { '/a': true } })
  })

  it('a read failure warns and still marks hydrated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    readJson.mockRejectedValueOnce(new Error('EACCES'))
    await useProjectsPrefs.getState().hydrate()
    expect(warn).toHaveBeenCalled()
    expect(useProjectsPrefs.getState().hydrated).toBe(true)
    warn.mockRestore()
  })
})
