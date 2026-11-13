// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useMdCuration, type UseMdCuration } from '../useMdCuration'
import { useToast } from '../../state/toast'

const readJson = vi.fn()
const writeJson = vi.fn()
let files: Record<string, unknown>

beforeEach(() => {
  files = {}
  readJson.mockReset()
  readJson.mockImplementation(async (p: string) => (p in files ? { exists: true, data: files[p] } : { exists: false }))
  writeJson.mockReset()
  writeJson.mockImplementation(async (p: string, data: unknown) => {
    files[p] = data
  })
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
  ;(window as unknown as { api: unknown }).api = { config: { readJson, writeJson } }
})

let container: HTMLDivElement | null = null
let root: Root | null = null
let hook: UseMdCuration

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

function Probe({ cwd }: { cwd: string | null }) {
  hook = useMdCuration(cwd)
  return null
}

function render(cwd: string | null) {
  if (!root) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  act(() => root!.render(createElement(Probe, { cwd })))
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const prefsOf = (cwd: string) => `${cwd}/session-manager-operations/ui-prefs/prefs.json`

describe('useMdCuration', () => {
  it('loads mdCuration through normalizeCuration once per cwd; not ready until it lands', async () => {
    files[prefsOf('/p/a')] = {
      other: 1,
      mdCuration: { verdicts: { 'CLAUDE.md': 'keep', 'x.md': 'bogus' }, notes: { 'CLAUDE.md': 'fine' }, reviewedAt: {}, recordFolders: ['logs/'], docFolders: 7 },
    }
    render('/p/a')
    expect(hook.ready).toBe(false)
    expect(hook.curation.verdicts).toEqual({})
    await settle()
    expect(hook.ready).toBe(true)
    expect(hook.curation).toEqual({ verdicts: { 'CLAUDE.md': 'keep' }, notes: { 'CLAUDE.md': 'fine' }, reviewedAt: {}, recordFolders: ['logs/'], docFolders: [] })
    render('/p/a')
    await settle()
    expect(readJson).toHaveBeenCalledTimes(1)
  })

  it('switching cwd never shows the previous project\'s curation', async () => {
    files[prefsOf('/p/a')] = { mdCuration: { verdicts: { 'CLAUDE.md': 'delete' } } }
    render('/p/a')
    await settle()
    expect(hook.curation.verdicts).toEqual({ 'CLAUDE.md': 'delete' })
    render('/p/b')
    expect(hook.ready).toBe(false)
    expect(hook.curation.verdicts).toEqual({})
    await settle()
    expect(hook.ready).toBe(true)
    expect(hook.curation.verdicts).toEqual({})
  })

  it('updates optimistically and persists every change with writeUiPrefsPatch, keeping other prefs', async () => {
    files[prefsOf('/p/a')] = { queueFilterStatus: 'all' }
    render('/p/a')
    await settle()
    act(() => hook.setVerdict('a.md', 'merge'))
    expect(hook.curation.verdicts).toEqual({ 'a.md': 'merge' })
    act(() => hook.setNote('a.md', 'fold into b'))
    act(() => hook.markReviewed('a.md'))
    act(() => hook.setFolderKind('logs/', 'records'))
    act(() => hook.setFolderKind('notes/', 'docs'))
    act(() => hook.setFolderKind('logs/', 'docs'))
    await settle()
    const saved = files[prefsOf('/p/a')] as { queueFilterStatus: string; mdCuration: Record<string, unknown> }
    expect(saved.queueFilterStatus).toBe('all')
    expect(saved.mdCuration).toMatchObject({
      verdicts: { 'a.md': 'merge' },
      notes: { 'a.md': 'fold into b' },
      recordFolders: [],
      docFolders: ['notes/', 'logs/'],
    })
    expect(typeof (saved.mdCuration.reviewedAt as Record<string, number>)['a.md']).toBe('number')
    expect(writeJson.mock.calls.every((c) => c[2] === 'ui-prefs')).toBe(true)

    act(() => hook.setVerdict('a.md', null))
    act(() => hook.setNote('a.md', ''))
    act(() => hook.setFolderKind('logs/', null))
    await settle()
    expect((files[prefsOf('/p/a')] as { mdCuration: unknown }).mdCuration).toMatchObject({ verdicts: {}, notes: {}, docFolders: ['notes/'] })
  })

  it('a failed write toasts an error and keeps the in-memory state', async () => {
    render('/p/a')
    await settle()
    writeJson.mockRejectedValue(new Error('remote write refused'))
    act(() => hook.setVerdict('a.md', 'update'))
    await settle()
    expect(hook.curation.verdicts).toEqual({ 'a.md': 'update' })
    expect(useToast.getState().toasts.map((t) => [t.kind, t.message])).toEqual([['error', 'Could not save doc curation: remote write refused']])
  })
})
