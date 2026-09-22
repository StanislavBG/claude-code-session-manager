// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useChatPrefs, resolveEpicVerbosity, CHAT_PREFS_FILE } from '../chatPrefs'
import { CHAT_VERBOSITY_DEFAULT } from '../../lib/chatVerbosity'
import { useToast } from '../toast'

const CWD = '/proj-a'
const UI_PREFS_PATH = `${CWD}/session-manager-operations/ui-prefs/prefs.json`
const ACTIVE_INDEX_PATH = `${CWD}/session-manager-operations/prompt-sessions/active-index.json`

function installApi(opts: {
  global?: unknown
  uiPrefs?: unknown
  knownIds?: string[]
  archivedIds?: string[]
} = {}) {
  const files = new Map<string, unknown>()
  if (opts.global !== undefined) files.set(CHAT_PREFS_FILE, opts.global)
  if (opts.uiPrefs !== undefined) files.set(UI_PREFS_PATH, opts.uiPrefs)

  const readJson = vi.fn(async (path: string) => {
    if (path === ACTIVE_INDEX_PATH) {
      const sessions = Object.fromEntries((opts.knownIds ?? []).map((id) => [id, {}]))
      return { exists: true, data: { sessions } }
    }
    if (files.has(path)) return { exists: true, data: files.get(path) }
    return { exists: false, data: null }
  })
  const writeJson = vi.fn(async (path: string, data: unknown) => {
    files.set(path, data)
    return { ok: true }
  })
  const listDir = vi.fn(async () => ({
    ok: true,
    entries: (opts.archivedIds ?? []).map((id) => ({
      name: `${id}.json`,
      path: `${CWD}/session-manager-operations/prompt-sessions/${id}.json`,
      isDirectory: false,
      isFile: true,
      mtimeMs: 0,
      size: 0,
    })),
    error: null,
  }))
  ;(window as unknown as { api: unknown }).api = { config: { readJson, writeJson, listDir } }
  return { readJson, writeJson, listDir }
}

function resetStore() {
  useChatPrefs.setState({ verbosity: CHAT_VERBOSITY_DEFAULT, perEpic: {}, hydrated: false, perEpicCwd: null })
}

describe('chatPrefs', () => {
  beforeEach(resetStore)
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('migrates the retired 3-level "verbose" global default forward to "raw"', async () => {
    installApi({ global: { verbosity: 'verbose' } })
    await useChatPrefs.getState().hydrate(CWD)
    expect(useChatPrefs.getState().verbosity).toBe('raw')
  })

  it('drops an unrecognised global default rather than persisting it', async () => {
    installApi({ global: { verbosity: 'nonsense' } })
    await useChatPrefs.getState().hydrate(CWD)
    expect(useChatPrefs.getState().verbosity).toBe(CHAT_VERBOSITY_DEFAULT)
  })

  it('hydrate is one-shot per session for the global default', async () => {
    installApi({ global: { verbosity: 'summary' } })
    await useChatPrefs.getState().hydrate(CWD)
    expect(useChatPrefs.getState().verbosity).toBe('summary')
    installApi({ global: { verbosity: 'raw' } })
    await useChatPrefs.getState().hydrate(CWD)
    expect(useChatPrefs.getState().verbosity).toBe('summary')
  })

  it('on first read, seeds the per-project ui-prefs file from the legacy global perEpic map, keeping only ids known to this cwd and migrating legacy level names', async () => {
    const { writeJson } = installApi({
      global: { verbosity: 'standard', perEpic: { 'epic-a': 'verbose', 'epic-b': 'detail', 'epic-other-project': 'raw' } },
      knownIds: ['epic-a'],
      archivedIds: ['epic-b'],
    })
    await useChatPrefs.getState().hydrate(CWD)
    expect(useChatPrefs.getState().perEpic).toEqual({ 'epic-a': 'raw', 'epic-b': 'detail' })
    expect(writeJson).toHaveBeenCalledWith(
      UI_PREFS_PATH,
      expect.objectContaining({ chatVerbosityPerEpic: { 'epic-a': 'raw', 'epic-b': 'detail' } }),
      'ui-prefs',
    )
  })

  it('once the project file has a chatVerbosityPerEpic field, reads it directly and skips migration', async () => {
    const { writeJson } = installApi({
      global: { perEpic: { 'epic-a': 'raw' } },
      uiPrefs: { chatVerbosityPerEpic: { 'epic-z': 'detail' } },
      knownIds: ['epic-a'],
    })
    await useChatPrefs.getState().hydrate(CWD)
    expect(useChatPrefs.getState().perEpic).toEqual({ 'epic-z': 'detail' })
    expect(writeJson).not.toHaveBeenCalled()
  })

  it('setting an Epic to the current global level CLEARS its override and writes to the project file', async () => {
    const { writeJson } = installApi({ uiPrefs: { chatVerbosityPerEpic: {} } })
    await useChatPrefs.getState().hydrate(CWD)
    useChatPrefs.setState({ verbosity: 'standard', perEpic: { 'epic-a': 'raw' } })
    useChatPrefs.getState().setEpicVerbosity(CWD, 'epic-a', 'standard')
    expect(useChatPrefs.getState().perEpic).toEqual({})
    await vi.waitFor(() => {
      expect(writeJson).toHaveBeenCalledWith(UI_PREFS_PATH, expect.objectContaining({ chatVerbosityPerEpic: {} }), 'ui-prefs')
    })
  })

  it('setEpicVerbosity reverts the optimistic update and toasts when the write rejects', async () => {
    installApi({ uiPrefs: { chatVerbosityPerEpic: {} } })
    await useChatPrefs.getState().hydrate(CWD)
    useToast.setState({ toasts: [], history: [], unreadCount: 0 })
    ;(window as unknown as { api: { config: { writeJson: unknown } } }).api.config.writeJson =
      vi.fn(async () => { throw new Error('boom') })

    useChatPrefs.setState({ verbosity: 'standard', perEpic: {} })
    useChatPrefs.getState().setEpicVerbosity(CWD, 'epic-a', 'raw')
    expect(useChatPrefs.getState().perEpic).toEqual({ 'epic-a': 'raw' })

    await vi.waitFor(() => {
      expect(useChatPrefs.getState().perEpic).toEqual({})
    })
    expect(useToast.getState().toasts.some((t) => t.kind === 'error' && /chat verbosity/.test(t.message))).toBe(true)
  })

  it('resolveEpicVerbosity prefers the override, else the global default', () => {
    expect(resolveEpicVerbosity('standard', { 'epic-a': 'raw' }, 'epic-a')).toBe('raw')
    expect(resolveEpicVerbosity('standard', { 'epic-a': 'raw' }, 'epic-b')).toBe('standard')
  })
})
