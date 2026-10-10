import { beforeEach, describe, expect, it, vi } from 'vitest'

const disk = new Map<string, { raw: string; mtimeMs: number }>()
let clock = 1000

const writeJson = vi.fn(async (p: string, data: unknown) => {
  disk.set(p, { raw: JSON.stringify(data, null, 2), mtimeMs: ++clock })
  return { ok: true }
})
const writeText = vi.fn(async (p: string, text: string) => {
  disk.set(p, { raw: text, mtimeMs: ++clock })
  return { ok: true }
})

const readJson = vi.fn(async (p: string) => {
  const f = disk.get(p)
  if (!f) return { exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: null }
  return { exists: true, raw: f.raw, data: JSON.parse(f.raw), parseError: null, mtimeMs: f.mtimeMs, error: null }
})
const readText = vi.fn(async (p: string) => {
  const f = disk.get(p)
  if (!f) return { exists: false, text: '', mtimeMs: 0, error: null, truncated: false }
  return { exists: true, text: f.raw, mtimeMs: f.mtimeMs, error: null, truncated: false }
})

;(globalThis as any).window = { api: { config: { readJson, readText, writeJson, writeText, watch: vi.fn(), unwatch: vi.fn() } } }

import { useConfig } from '../config'
import { useToast } from '../toast'

const P = '/x/settings.json'

function external(raw: string) {
  disk.set(P, { raw, mtimeMs: ++clock })
}

beforeEach(() => {
  disk.clear()
  clock = 1000
  writeJson.mockClear()
  writeText.mockClear()
  useConfig.setState({ files: {}, watchRefs: {} })
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
})

describe('config save conflict guard', () => {
  it('refuses a save when the file changed on disk, keeps the draft, and toasts', async () => {
    external('{"a":1}')
    await useConfig.getState().loadJson(P)
    useConfig.getState().setDraft(P, '{"a":2}')
    external('{"a":99}')
    // watcher refresh keeps the dirty draft but must not re-base it
    useConfig.getState().onExternalChange(P)
    await new Promise((r) => setTimeout(r, 0))
    const res = await useConfig.getState().saveJson(P)
    expect(res).toEqual({ ok: false, error: 'conflict' })
    expect(writeJson).not.toHaveBeenCalled()
    expect(useConfig.getState().files[P].draftRaw).toBe('{"a":2}')
    const t = useToast.getState().toasts[0]
    expect(t.kind).toBe('error')
    expect(t.message).toContain(P)
    expect(t.message).toContain('changed on disk')
  })

  it('force overwrites despite the conflict', async () => {
    external('{"a":1}')
    await useConfig.getState().loadJson(P)
    useConfig.getState().setDraft(P, '{"a":2}')
    external('{"a":99}')
    const res = await useConfig.getState().saveJson(P, { force: true })
    expect(res).toEqual({ ok: true })
    expect(JSON.parse(disk.get(P)!.raw)).toEqual({ a: 2 })
  })

  it('two saves in a row never conflict with each other', async () => {
    external('{"a":1}')
    await useConfig.getState().loadJson(P)
    useConfig.getState().setDraft(P, '{"a":2}')
    expect((await useConfig.getState().saveJson(P)).ok).toBe(true)
    useConfig.getState().setDraft(P, '{"a":3}')
    expect((await useConfig.getState().saveJson(P)).ok).toBe(true)
    expect(writeJson).toHaveBeenCalledTimes(2)
  })

  it('saves a brand-new file', async () => {
    await useConfig.getState().loadJson(P)
    useConfig.getState().setDraft(P, '{"n":1}')
    expect((await useConfig.getState().saveJson(P)).ok).toBe(true)
    expect(JSON.parse(disk.get(P)!.raw)).toEqual({ n: 1 })
  })

  it('applies the same guard to saveText', async () => {
    const T = '/x/CLAUDE.md'
    disk.set(T, { raw: 'one', mtimeMs: ++clock })
    await useConfig.getState().loadText(T)
    useConfig.getState().setDraft(T, 'two')
    disk.set(T, { raw: 'ext', mtimeMs: ++clock })
    expect(await useConfig.getState().saveText(T)).toEqual({ ok: false, error: 'conflict' })
    expect((await useConfig.getState().saveText(T, { force: true })).ok).toBe(true)
    expect(disk.get(T)!.raw).toBe('two')
  })
})
