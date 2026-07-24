import { describe, it, expect, beforeEach } from 'vitest'
import { useEditor } from '../editor'

/**
 * renameOpenFile(oldPath, newPath) keeps a renamed file's tab, buffer, dirty
 * state, and view-mode choice alive across the rename instead of forcing a
 * close+reopen (which would drop unsaved edits).
 */

describe('useEditor.renameOpenFile', () => {
  beforeEach(() => {
    useEditor.setState({
      openFiles: [],
      activeFilePath: null,
      buffers: {},
      baselines: {},
      dirty: {},
      viewMode: {},
      pendingReveal: null,
    })
  })

  it('remaps openFiles/buffers/dirty/viewMode/baselines keys from old path to new path', () => {
    const { openFile, loadBuffer, setBuffer, setViewMode, renameOpenFile } = useEditor.getState()
    openFile('/dir/old.md')
    loadBuffer('/dir/old.md', 'hello')
    setBuffer('/dir/old.md', 'hello world')
    setViewMode('/dir/old.md', 'preview')

    renameOpenFile('/dir/old.md', '/dir/new.md')

    const s = useEditor.getState()
    expect(s.openFiles.map((f) => f.path)).toEqual(['/dir/new.md'])
    expect(s.openFiles[0].name).toBe('new.md')
    expect(s.buffers['/dir/old.md']).toBeUndefined()
    expect(s.buffers['/dir/new.md']).toBe('hello world')
    expect(s.baselines['/dir/new.md']).toBe('hello')
    expect(s.viewMode['/dir/new.md']).toBe('preview')
    expect(s.dirty['/dir/old.md']).toBeUndefined()
  })

  it('preserves dirty state across the rename', () => {
    const { openFile, loadBuffer, setBuffer, renameOpenFile } = useEditor.getState()
    openFile('/a.md')
    loadBuffer('/a.md', 'hello')
    setBuffer('/a.md', 'hello world')
    expect(useEditor.getState().dirty['/a.md']).toBe(true)

    renameOpenFile('/a.md', '/b.md')

    expect(useEditor.getState().dirty['/b.md']).toBe(true)
  })

  it('updates activeFilePath when the renamed file was active', () => {
    const { openFile, renameOpenFile } = useEditor.getState()
    openFile('/a.md')

    renameOpenFile('/a.md', '/renamed.md')

    expect(useEditor.getState().activeFilePath).toBe('/renamed.md')
  })

  it('is a no-op when the old path is not open', () => {
    const { openFile, renameOpenFile } = useEditor.getState()
    openFile('/a.md')

    renameOpenFile('/not-open.md', '/also-not-open.md')

    expect(useEditor.getState().openFiles.map((f) => f.path)).toEqual(['/a.md'])
  })
})
