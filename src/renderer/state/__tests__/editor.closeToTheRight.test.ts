import { describe, it, expect, beforeEach } from 'vitest'
import { useEditor } from '../editor'

/**
 * closeToTheRight(path) mirrors closeOthers's shape: keeps `path` and
 * everything left of it, closes everything to its right, keyed on full
 * `path` (not filename) so same-named files in different dirs don't collide.
 */

describe('useEditor.closeToTheRight', () => {
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

  it('keeps the target tab and everything left of it, closes everything to the right', () => {
    const { openFile, closeToTheRight } = useEditor.getState()
    openFile('/a.ts')
    openFile('/b.ts')
    openFile('/c.ts')
    openFile('/d.ts')

    closeToTheRight('/b.ts')

    const { openFiles, activeFilePath } = useEditor.getState()
    expect(openFiles.map((f) => f.path)).toEqual(['/a.ts', '/b.ts'])
    expect(activeFilePath).toBe('/b.ts')
  })

  it('is a no-op when the target tab is already the last one', () => {
    const { openFile, closeToTheRight } = useEditor.getState()
    openFile('/a.ts')
    openFile('/b.ts')

    closeToTheRight('/b.ts')

    expect(useEditor.getState().openFiles.map((f) => f.path)).toEqual(['/a.ts', '/b.ts'])
  })

  it('is correct when two tabs share a filename but differ by path', () => {
    const { openFile, closeToTheRight } = useEditor.getState()
    openFile('/dir1/same.ts')
    openFile('/dir2/same.ts')
    openFile('/dir3/other.ts')

    closeToTheRight('/dir1/same.ts')

    const { openFiles } = useEditor.getState()
    expect(openFiles.map((f) => f.path)).toEqual(['/dir1/same.ts'])
  })

  it('clears buffers/dirty/viewMode/baselines for closed tabs to the right', () => {
    const { openFile, setBuffer, loadBuffer, setViewMode, closeToTheRight } = useEditor.getState()
    openFile('/a.ts')
    openFile('/b.ts')
    loadBuffer('/b.ts', 'hello')
    setBuffer('/b.ts', 'hello world')
    setViewMode('/b.ts', 'preview')

    closeToTheRight('/a.ts')

    const s = useEditor.getState()
    expect(s.buffers['/b.ts']).toBeUndefined()
    expect(s.dirty['/b.ts']).toBeUndefined()
    expect(s.viewMode['/b.ts']).toBeUndefined()
    expect(s.baselines['/b.ts']).toBeUndefined()
  })
})
