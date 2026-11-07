import { describe, it, expect, beforeEach, vi } from 'vitest'
import { appSettingsFile } from '../appSettingsFile'

type Handler = (info: { path: string; mtimeMs: number; kind: 'change' }) => void

describe('appSettingsFile', () => {
  let disk: Record<string, unknown>
  let handlers: Handler[]
  beforeEach(() => {
    disk = {}
    handlers = []
    ;(globalThis as any).window = {
      api: {
        config: {
          readJson: vi.fn(async () => {
            const snap = { ...disk }
            await new Promise((r) => setTimeout(r, 5))
            return { exists: true, data: snap }
          }),
          writeJson: vi.fn(async (_p: string, data: Record<string, unknown>) => {
            await new Promise((r) => setTimeout(r, 5))
            disk = data
            return { ok: true }
          }),
          watch: vi.fn(),
          unwatch: vi.fn(),
          onChanged: vi.fn((h: Handler) => {
            handlers.push(h)
            return () => { handlers = handlers.filter((x) => x !== h) }
          }),
        },
      },
    }
  })

  it('lands two concurrent patches of different keys', async () => {
    const f = appSettingsFile<{ a?: number; b?: number }>('~/.claude/session-manager/t1.json')
    await Promise.all([f.patch({ a: 1 }), f.patch({ b: 2 })])
    expect(disk).toEqual({ a: 1, b: 2 })
    expect(await f.read()).toEqual({ a: 1, b: 2 })
  })

  it('delivers external changes to subscribers only for its file', () => {
    const f = appSettingsFile('~/.claude/session-manager/t2.json')
    const cb = vi.fn()
    const off = f.subscribe(cb)
    handlers.forEach((h) => h({ path: '/home/u/.claude/session-manager/t2.json', mtimeMs: 1, kind: 'change' }))
    handlers.forEach((h) => h({ path: '/home/u/.claude/session-manager/other.json', mtimeMs: 1, kind: 'change' }))
    expect(cb).toHaveBeenCalledTimes(1)
    off()
    expect(handlers).toHaveLength(0)
  })
})
