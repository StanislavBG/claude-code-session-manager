// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'

/**
 * editor.ts persists only the STRUCTURAL session (open paths, active path,
 * per-path view mode) to the active project's ui-prefs/prefs.json, debounced
 * like sessions.ts's autosave. Buffers/baselines/dirty are never written or
 * read back — hydrateEditorSession() re-reads each surviving path's CURRENT
 * on-disk content instead, so a restart never resurrects a stale unsaved edit.
 *
 * Each phase (`before restart` / `after restart`) re-imports both `sessions`
 * and `editor` via `vi.resetModules()` to get a genuinely fresh store, the
 * same way `editorPrefs.test.ts` simulates a reload. `window.api` itself is
 * installed once and stays in place across resets (module resets don't wipe
 * globals), so the mocked disk content it reads from carries over exactly
 * like a real restart reading the same files back. Every write triggered
 * within a phase is drained with `vi.waitFor` before the phase ends, so no
 * dangling debounce timer can fire during (and pollute) a later test.
 */

const CWD = '/proj-a'
const UI_PREFS_PATH = `${CWD}/session-manager-operations/ui-prefs/prefs.json`

function installApi() {
  const diskFiles: Record<string, string> = {}
  let uiPrefsFile: unknown
  const readJson = vi.fn(async (path: string) =>
    path === UI_PREFS_PATH && uiPrefsFile !== undefined
      ? { exists: true, data: uiPrefsFile }
      : { exists: false, data: null },
  )
  const writeJson = vi.fn(async (path: string, data: unknown) => {
    if (path === UI_PREFS_PATH) uiPrefsFile = data
    return { ok: true }
  })
  const read = vi.fn(async (path: string) =>
    path in diskFiles
      ? { ok: true, text: diskFiles[path], error: null, size: diskFiles[path].length }
      : { ok: false, text: '', error: 'ENOENT', size: 0 },
  )
  ;(window as unknown as { api: unknown }).api = {
    config: { readJson, writeJson },
    files: { read },
  }
  return {
    diskFiles,
    readJson,
    writeJson,
    read,
    seedUiPrefs: (data: unknown) => { uiPrefsFile = data },
  }
}

async function freshEditorModule(tabCwd: string) {
  vi.resetModules()
  const { useSessions } = await import('../sessions')
  useSessions.setState({
    tabs: [{
      id: 'tab-1',
      sessionId: 'tab-1',
      label: 'proj-a',
      cwd: tabCwd,
      pid: null,
      status: 'dormant',
      exitCode: null,
      startupCommand: null,
      presetId: null,
      generation: 0,
    }],
    activeTabId: 'tab-1',
  })
  return import('../editor')
}

describe('editor.ts session persistence', () => {
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('debounced-persists openFiles/activeFilePath/viewMode, then restores fresh on-disk content (not the pre-restart edit) after a restart', async () => {
    const api = installApi()
    api.diskFiles['/proj-a/a.md'] = 'on-disk content'

    const before = await freshEditorModule(CWD)
    await before.hydrateEditorSession()
    // Hydrating an empty (never-persisted) session still re-persists it once,
    // immediately (mirrors sessions.ts's own "initial flush") — drain it.
    await vi.waitFor(() => {
      expect(api.writeJson).toHaveBeenCalledWith(
        UI_PREFS_PATH,
        expect.objectContaining({ editorSession: { openFiles: [], activeFilePath: null, viewModeByPath: {} } }),
        'ui-prefs',
      )
    })

    before.useEditor.getState().openFile('/proj-a/a.md')
    before.useEditor.getState().loadBuffer('/proj-a/a.md', 'on-disk content')
    before.useEditor.getState().setBuffer('/proj-a/a.md', 'dirty unsaved edit')
    expect(before.useEditor.getState().dirty['/proj-a/a.md']).toBe(true)

    await vi.waitFor(() => {
      expect(api.writeJson).toHaveBeenCalledWith(
        UI_PREFS_PATH,
        expect.objectContaining({
          editorSession: { openFiles: ['/proj-a/a.md'], activeFilePath: '/proj-a/a.md', viewModeByPath: {} },
        }),
        'ui-prefs',
      )
    })
    // Buffers/dirty must never appear in what's written to disk.
    const lastPatch = api.writeJson.mock.calls.at(-1)?.[1] as { editorSession: unknown; buffers?: unknown; dirty?: unknown }
    expect(lastPatch.buffers).toBeUndefined()
    expect(lastPatch.dirty).toBeUndefined()

    // The file changed on disk after the dirty (unsaved, never-persisted) edit
    // — proves the restore below reads CURRENT disk content, not a cached buffer.
    api.diskFiles['/proj-a/a.md'] = 'current on-disk content'

    const after = await freshEditorModule(CWD)
    await after.hydrateEditorSession()

    const s = after.useEditor.getState()
    expect(s.openFiles.map((f) => f.path)).toEqual(['/proj-a/a.md'])
    expect(s.activeFilePath).toBe('/proj-a/a.md')
    expect(s.buffers['/proj-a/a.md']).toBe('current on-disk content')
    expect(s.baselines['/proj-a/a.md']).toBe('current on-disk content')
    expect(s.dirty['/proj-a/a.md']).toBeUndefined()

    // Drain this phase's own re-persist flush before the test ends.
    await vi.waitFor(() => expect(api.writeJson).toHaveBeenCalledTimes(3))
  })

  it('silently drops a persisted path that no longer exists on disk', async () => {
    const api = installApi()
    api.diskFiles['/proj-a/keep.md'] = 'kept'
    // A prefs.json already on disk (from an earlier, unrelated session)
    // referencing a path that has since been deleted.
    api.seedUiPrefs({
      editorSession: { openFiles: ['/proj-a/keep.md', '/proj-a/gone.md'], activeFilePath: '/proj-a/gone.md', viewModeByPath: {} },
    })

    const restored = await freshEditorModule(CWD)
    await restored.hydrateEditorSession()

    const s = restored.useEditor.getState()
    expect(s.openFiles.map((f) => f.path)).toEqual(['/proj-a/keep.md'])
    expect(s.activeFilePath).toBe('/proj-a/keep.md')

    // Drain the post-hydrate re-persist flush before the test ends.
    await vi.waitFor(() => {
      expect(api.writeJson).toHaveBeenCalledWith(
        UI_PREFS_PATH,
        expect.objectContaining({
          editorSession: { openFiles: ['/proj-a/keep.md'], activeFilePath: '/proj-a/keep.md', viewModeByPath: {} },
        }),
        'ui-prefs',
      )
    })
  })
})
