// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useEpicsPrefs } from '../epicsPrefs'
import { useToast } from '../toast'

const GLOBAL_FILE = '~/.claude/session-manager/epics-prefs.json'
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
  if (opts.global !== undefined) files.set(GLOBAL_FILE, opts.global)
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
  useEpicsPrefs.setState({ pins: {}, group: 'status', sort: 'recent', compact: false, hydrated: false, pinsCwd: null })
}

describe('epicsPrefs', () => {
  beforeEach(resetStore)
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('reads group/sort/compact from the global file, never pins', async () => {
    installApi({ global: { pins: { 'epic-x': true }, group: 'tag', sort: 'title', compact: true } })
    await useEpicsPrefs.getState().hydrate(CWD)
    expect(useEpicsPrefs.getState().group).toBe('tag')
    expect(useEpicsPrefs.getState().sort).toBe('title')
    expect(useEpicsPrefs.getState().compact).toBe(true)
  })

  it('on first read, seeds the per-project ui-prefs file from the legacy global pins map, keeping only ids known to this cwd', async () => {
    const { writeJson } = installApi({
      global: { pins: { 'epic-a': true, 'epic-b': true, 'epic-other-project': true } },
      knownIds: ['epic-a'],
      archivedIds: ['epic-b'],
    })
    await useEpicsPrefs.getState().hydrate(CWD)
    expect(useEpicsPrefs.getState().pins).toEqual({ 'epic-a': true, 'epic-b': true })
    expect(writeJson).toHaveBeenCalledWith(UI_PREFS_PATH, expect.objectContaining({ epicPins: { 'epic-a': true, 'epic-b': true } }), 'ui-prefs')
  })

  it('does not delete or touch the legacy global file during migration', async () => {
    const { writeJson } = installApi({
      global: { pins: { 'epic-a': true }, group: 'status', sort: 'recent', compact: false },
      knownIds: ['epic-a'],
    })
    await useEpicsPrefs.getState().hydrate(CWD)
    expect(writeJson).not.toHaveBeenCalledWith(GLOBAL_FILE, expect.anything())
  })

  it('once the project file has an epicPins field, reads it directly and skips migration', async () => {
    const { writeJson } = installApi({
      global: { pins: { 'epic-a': true } },
      uiPrefs: { epicPins: { 'epic-z': true } },
      knownIds: ['epic-a'],
    })
    await useEpicsPrefs.getState().hydrate(CWD)
    expect(useEpicsPrefs.getState().pins).toEqual({ 'epic-z': true })
    expect(writeJson).not.toHaveBeenCalled()
  })

  it('togglePin writes epicPins to the project ui-prefs file, not the global one', async () => {
    const { writeJson } = installApi({ uiPrefs: { epicPins: {} } })
    await useEpicsPrefs.getState().hydrate(CWD)
    useEpicsPrefs.getState().togglePin(CWD, 'epic-a')
    expect(useEpicsPrefs.getState().pins).toEqual({ 'epic-a': true })
    await vi.waitFor(() => {
      expect(writeJson).toHaveBeenCalledWith(UI_PREFS_PATH, expect.objectContaining({ epicPins: { 'epic-a': true } }), 'ui-prefs')
    })
  })

  it('togglePin reverts the optimistic update and toasts when the write rejects', async () => {
    installApi({ uiPrefs: { epicPins: {} } })
    await useEpicsPrefs.getState().hydrate(CWD)
    useToast.setState({ toasts: [], history: [], unreadCount: 0 })
    ;(window as unknown as { api: { config: { writeJson: unknown } } }).api.config.writeJson =
      vi.fn(async () => { throw new Error('boom') })

    useEpicsPrefs.getState().togglePin(CWD, 'epic-a')
    expect(useEpicsPrefs.getState().pins).toEqual({ 'epic-a': true })

    await vi.waitFor(() => {
      expect(useEpicsPrefs.getState().pins).toEqual({})
    })
    expect(useToast.getState().toasts.some((t) => t.kind === 'error' && /pinned Epics/.test(t.message))).toBe(true)
  })

  it('a failed togglePin write does not stomp a later, already-applied pin change (code-review: call-time-snapshot revert race)', async () => {
    const { writeJson } = installApi({ uiPrefs: { epicPins: {} } })
    await useEpicsPrefs.getState().hydrate(CWD)
    useToast.setState({ toasts: [], history: [], unreadCount: 0 })
    writeJson.mockRejectedValueOnce(new Error('boom'))

    // Fired back-to-back, synchronously — both optimistic updates land
    // before either write settles, mirroring a real fast double-click.
    useEpicsPrefs.getState().togglePin(CWD, 'epic-a')
    useEpicsPrefs.getState().togglePin(CWD, 'epic-b')
    expect(useEpicsPrefs.getState().pins).toEqual({ 'epic-a': true, 'epic-b': true })

    await vi.waitFor(() => expect(writeJson).toHaveBeenCalledTimes(2))
    // Let both writes' .catch/.then handlers flush.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    // epic-a's failed write must not wipe epic-b's successfully-applied pin.
    expect(useEpicsPrefs.getState().pins).toEqual({ 'epic-a': true, 'epic-b': true })
  })

  it('re-hydrating for a different cwd loads that project\'s own pins', async () => {
    installApi({ uiPrefs: { epicPins: { 'epic-a': true } } })
    await useEpicsPrefs.getState().hydrate(CWD)
    expect(useEpicsPrefs.getState().pins).toEqual({ 'epic-a': true })

    const otherCwd = '/proj-b'
    const otherApi = installApi({})
    otherApi.readJson.mockImplementation(async (path: string) => {
      if (path === `${otherCwd}/session-manager-operations/ui-prefs/prefs.json`) {
        return { exists: true, data: { epicPins: { 'epic-b': true } } }
      }
      if (path === `${otherCwd}/session-manager-operations/prompt-sessions/active-index.json`) {
        return { exists: true, data: { sessions: {} } }
      }
      return { exists: false, data: null }
    })
    await useEpicsPrefs.getState().hydrate(otherCwd)
    expect(useEpicsPrefs.getState().pins).toEqual({ 'epic-b': true })
  })
})
