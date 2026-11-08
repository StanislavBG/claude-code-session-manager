// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { formatSourceAge, useFileAges, type FileAge, type FileAgeSource } from '../useFileAges'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SEC = 1_000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0)

describe('formatSourceAge', () => {
  it('reads a missing source as "created on first save"', () => {
    expect(formatSourceAge(null, NOW)).toBe('created on first save')
  })

  it('shows no age for an existing directory (the path alone)', () => {
    expect(formatSourceAge('present', NOW)).toBeNull()
  })

  it('shows no age for a path still loading (a record lookup with no key yet)', () => {
    const ages: Record<string, FileAge> = {}
    expect(formatSourceAge(ages['/not/loaded/yet'], NOW)).toBeNull()
  })

  it('says "just now" under 60 s, including a clock-skewed future mtime', () => {
    expect(formatSourceAge(NOW, NOW)).toBe('just now')
    expect(formatSourceAge(NOW - (59 * SEC + 999), NOW)).toBe('just now')
    expect(formatSourceAge(NOW + 5 * SEC, NOW)).toBe('just now')
  })

  it('counts whole minutes under 60 min', () => {
    expect(formatSourceAge(NOW - MIN, NOW)).toBe('1m ago')
    expect(formatSourceAge(NOW - (59 * MIN + 59 * SEC), NOW)).toBe('59m ago')
  })

  it('shows hours and minutes under 24 h', () => {
    expect(formatSourceAge(NOW - HOUR, NOW)).toBe('1h 0m ago')
    expect(formatSourceAge(NOW - (9 * HOUR + 31 * MIN + 12 * SEC), NOW)).toBe('9h 31m ago')
    expect(formatSourceAge(NOW - (23 * HOUR + 59 * MIN + 59 * SEC), NOW)).toBe('23h 59m ago')
  })

  it('counts whole days from 24 h on', () => {
    expect(formatSourceAge(NOW - DAY, NOW)).toBe('1d ago')
    expect(formatSourceAge(NOW - (15 * DAY + 3 * HOUR), NOW)).toBe('15d ago')
  })

  it('measures against Date.now() when no clock is passed', () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    try {
      expect(formatSourceAge(NOW - 5 * MIN)).toBe('5m ago')
    } finally {
      spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// useFileAges — stub window.api.config backed by an in-memory file/dir table.
// ---------------------------------------------------------------------------

const HOME = '/home/u'
const SETTINGS = `${HOME}/.claude/settings.json`
const INSTALLED = `${HOME}/.claude/plugins/installed_plugins.json`
const SKILLS = `${HOME}/.claude/skills`
const NO_DIR = `${HOME}/.claude/commands`

type ChangedEvent = { path: string; mtimeMs: number; kind: 'add' | 'change' | 'unlink' }
type TextResult = { exists: boolean; text: string; mtimeMs: number; error: string | null; truncated: boolean }

const found = (mtimeMs: number): TextResult => ({ exists: true, text: '', mtimeMs, error: null, truncated: false })
const absent = (): TextResult => ({ exists: false, text: '', mtimeMs: 0, error: null, truncated: false })

function installApi() {
  const files = new Map<string, number>() // existing file → mtimeMs
  const dirs = new Set<string>()
  const listeners = new Set<(e: ChangedEvent) => void>()
  const readText = vi.fn(async (path: string, _opts?: { maxBytes?: number }): Promise<TextResult> => {
    // The real IPC fails a read on a directory path (EISDIR) — the bug the hook must avoid.
    if (dirs.has(path)) throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${path}'`), { code: 'EISDIR' })
    const mtime = files.get(path)
    return mtime === undefined ? absent() : found(mtime)
  })
  const exists = vi.fn(async (path: string): Promise<boolean> => dirs.has(path) || files.has(path))
  const off = vi.fn()
  const onChanged = vi.fn((handler: (e: ChangedEvent) => void) => {
    listeners.add(handler)
    return () => {
      off()
      listeners.delete(handler)
    }
  })
  ;(window as unknown as { api: unknown }).api = { config: { readText, exists, onChanged } }
  return {
    files,
    dirs,
    readText,
    exists,
    onChanged,
    off,
    listenerCount: () => listeners.size,
    emit: (path: string, kind: ChangedEvent['kind'] = 'change') => {
      for (const l of [...listeners]) l({ path, mtimeMs: files.get(path) ?? 0, kind })
    },
  }
}

const roots: Root[] = []

afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount())
  delete (window as unknown as { api?: unknown }).api
})

/** Let the hook's IPC promise chain resolve and its state update commit. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

async function mount(initial: ReadonlyArray<FileAgeSource>) {
  let latest: Record<string, FileAge> = {}
  let renders = 0
  const Probe = ({ sources }: { sources: ReadonlyArray<FileAgeSource> }) => {
    latest = useFileAges(sources)
    renders++
    return null
  }
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  const render = (sources: ReadonlyArray<FileAgeSource>) => act(() => { root.render(createElement(Probe, { sources })) })
  render(initial)
  await settle()
  return {
    ages: () => latest,
    renders: () => renders,
    rerender: async (sources: ReadonlyArray<FileAgeSource>) => { render(sources); await settle() },
    unmount: () => {
      roots.splice(roots.indexOf(root), 1)
      act(() => root.unmount())
    },
  }
}

describe('useFileAges', () => {
  it('reads a file mtime via readText(path, { maxBytes: 1 }); a missing file reads null', async () => {
    const api = installApi()
    api.files.set(SETTINGS, NOW - 9 * HOUR)
    const h = await mount([
      { path: SETTINGS, kind: 'file' },
      { path: INSTALLED, kind: 'file' },
    ])
    expect(h.ages()).toEqual({ [SETTINGS]: NOW - 9 * HOUR, [INSTALLED]: null })
    expect(api.readText).toHaveBeenCalledWith(SETTINGS, { maxBytes: 1 })
    expect(api.readText).toHaveBeenCalledWith(INSTALLED, { maxBytes: 1 })
    expect(api.exists).not.toHaveBeenCalled()
  })

  it('checks a directory with exists (present or null) and never calls readText on it', async () => {
    const api = installApi()
    api.dirs.add(SKILLS)
    const h = await mount([
      { path: SKILLS, kind: 'dir' },
      { path: NO_DIR, kind: 'dir' },
    ])
    expect(h.ages()).toEqual({ [SKILLS]: 'present', [NO_DIR]: null })
    expect(api.exists).toHaveBeenCalledWith(SKILLS)
    expect(api.exists).toHaveBeenCalledWith(NO_DIR)
    expect(api.readText).not.toHaveBeenCalled()
  })

  it('leaves a source out of the record while its age is unknown (read failed)', async () => {
    const api = installApi()
    const UNREADABLE = `${HOME}/.claude.json`
    api.readText.mockImplementation(async (path: string) => {
      if (path === INSTALLED) throw new Error('IPC channel closed')
      // The real IPC folds every non-ENOENT failure (EACCES, EISDIR, a rejected
      // path) into exists:false with the error message set: not a missing file.
      if (path === UNREADABLE) return { ...absent(), error: `EACCES: permission denied, open '${path}'` }
      return found(NOW)
    })
    api.exists.mockRejectedValue(new Error('denied'))
    const h = await mount([
      { path: SETTINGS, kind: 'file' },
      { path: INSTALLED, kind: 'file' },
      { path: UNREADABLE, kind: 'file' },
      { path: SKILLS, kind: 'dir' },
    ])
    expect(h.ages()).toEqual({ [SETTINGS]: NOW })
  })

  it('refreshes when config.onChanged fires for a source path or a path inside a dir source', async () => {
    const api = installApi()
    api.files.set(SETTINGS, NOW - DAY)
    api.dirs.add(SKILLS)
    const h = await mount([
      { path: SETTINGS, kind: 'file' },
      { path: SKILLS, kind: 'dir' },
    ])
    expect(h.ages()).toEqual({ [SETTINGS]: NOW - DAY, [SKILLS]: 'present' })
    expect(api.onChanged).toHaveBeenCalledTimes(1)

    // An unrelated path does not trigger a read.
    const readsBefore = api.readText.mock.calls.length + api.exists.mock.calls.length
    act(() => api.emit(`${HOME}/.claude.json`))
    await settle()
    expect(api.readText.mock.calls.length + api.exists.mock.calls.length).toBe(readsBefore)

    // The file itself changed.
    api.files.set(SETTINGS, NOW)
    act(() => api.emit(SETTINGS))
    await settle()
    expect(h.ages()[SETTINGS]).toBe(NOW)

    // Something inside the directory changed (here: the directory went away).
    api.dirs.delete(SKILLS)
    act(() => api.emit(`${SKILLS}/review/SKILL.md`, 'unlink'))
    await settle()
    expect(h.ages()).toEqual({ [SETTINGS]: NOW, [SKILLS]: null })
  })

  it('removes the onChanged listener on unmount', async () => {
    const api = installApi()
    api.files.set(SETTINGS, NOW)
    const h = await mount([{ path: SETTINGS, kind: 'file' }])
    expect(api.listenerCount()).toBe(1)
    h.unmount()
    expect(api.off).toHaveBeenCalledTimes(1)
    expect(api.listenerCount()).toBe(0)
  })

  it('never lets an older read overwrite a newer one', async () => {
    const api = installApi()
    const pending: Array<(r: TextResult) => void> = []
    api.readText.mockImplementation(() => new Promise<TextResult>((resolve) => { pending.push(resolve) }))
    const h = await mount([{ path: SETTINGS, kind: 'file' }])
    act(() => api.emit(SETTINGS))
    await settle()
    expect(pending).toHaveLength(2)

    // The newer read lands first, then the older one arrives late.
    pending[1](found(NOW))
    await settle()
    expect(h.ages()[SETTINGS]).toBe(NOW)
    pending[0](found(NOW - DAY))
    await settle()
    expect(h.ages()[SETTINGS]).toBe(NOW)
  })

  it('does not re-read when re-rendered with a fresh array of the same sources', async () => {
    const api = installApi()
    api.files.set(SETTINGS, NOW)
    const h = await mount([{ path: SETTINGS, kind: 'file' }])
    expect(api.readText).toHaveBeenCalledTimes(1)
    const renders = h.renders()
    await h.rerender([{ path: SETTINGS, kind: 'file' }])
    await h.rerender([{ path: SETTINGS, kind: 'file' }])
    expect(api.readText).toHaveBeenCalledTimes(1)
    expect(api.onChanged).toHaveBeenCalledTimes(1)
    expect(h.renders()).toBe(renders + 2) // the two re-renders themselves, no read-driven loop
  })

  it('reads the new sources when the list changes and drops ages for sources no longer listed', async () => {
    const api = installApi()
    api.files.set(SETTINGS, NOW)
    api.dirs.add(SKILLS)
    const h = await mount([{ path: SETTINGS, kind: 'file' }])
    expect(h.ages()).toEqual({ [SETTINGS]: NOW })
    await h.rerender([{ path: SKILLS, kind: 'dir' }])
    expect(h.ages()).toEqual({ [SKILLS]: 'present' })
    expect(api.off).toHaveBeenCalledTimes(1) // the old subscription was released
    expect(api.listenerCount()).toBe(1)
  })
})
