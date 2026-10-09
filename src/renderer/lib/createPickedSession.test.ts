// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessions } from '../state/sessions'
import { openProjectAt, startNewProject } from './createPickedSession'

const createProjectFolder = vi.fn()

beforeEach(() => {
  createProjectFolder.mockReset()
  ;(window as unknown as { api: unknown }).api = { app: { createProjectFolder } }
  useSessions.setState({ tabs: [], activeTabId: null })
})

describe('openProjectAt', () => {
  it('dedupes by cwd', () => {
    const a = openProjectAt('/tmp/proj')
    const b = openProjectAt('/tmp/proj')
    expect(b).toBe(a)
    expect(useSessions.getState().tabs).toHaveLength(1)
    expect(useSessions.getState().activeTabId).toBe(a)
  })
})

describe('startNewProject', () => {
  it('adds one tab with the new path on success', async () => {
    createProjectFolder.mockResolvedValue({ ok: true, path: '/tmp/parent/new' })
    const r = await startNewProject('/tmp/parent', 'new')
    expect(createProjectFolder).toHaveBeenCalledWith('/tmp/parent', 'new')
    expect(r.ok).toBe(true)
    const tabs = useSessions.getState().tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0].cwd).toBe('/tmp/parent/new')
    expect(r.tabId).toBe(tabs[0].id)
  })

  it('adds no tab on failure', async () => {
    const fail = { ok: false, code: 'exists', error: 'exists' }
    createProjectFolder.mockResolvedValue(fail)
    const r = await startNewProject('/tmp/parent', 'new')
    expect(r).toEqual(fail)
    expect(useSessions.getState().tabs).toHaveLength(0)
  })
})
