// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useKnownProjects } from '../useKnownProjects'

const ROOT = '/home/u/.claude/projects'
const file = (dir: string, name: string, mtimeMs: number, size = 10) => ({
  name,
  path: `${dir}/${name}`,
  mtimeMs,
  size,
})

describe('useKnownProjects recentSessions', () => {
  it('collects the newest .jsonl files from the scan listings with no extra listDir calls', async () => {
    const a = `${ROOT}/-p-a`
    const b = `${ROOT}/-p-b`
    const folders: Record<string, ReturnType<typeof file>[]> = {
      [a]: [file(a, 's1.jsonl', 100), file(a, 'notes.txt', 900), file(a, 's3.jsonl', 300)],
      [b]: [file(b, 's2.jsonl', 200)],
    }
    const listDir = vi.fn(async (path: string) => {
      if (path === ROOT) {
        return { entries: [{ name: '-p-a', path: a }, { name: '-p-b', path: b }] }
      }
      return { entries: folders[path] ?? [] }
    })
    ;(globalThis as any).window.api = {
      app: { homeDir: vi.fn(async () => '/home/u') },
      config: {
        listDir,
        readText: vi.fn(async () => ({ exists: false, text: '', mtimeMs: 0, error: null, truncated: false })),
      },
    }

    let current: ReturnType<typeof useKnownProjects> | null = null
    const Probe = () => {
      current = useKnownProjects()
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => { root.render(createElement(Probe)) })
    for (let i = 0; i < 50 && current!.loading; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    }
    const result = { current: current! }
    expect(result.current.loading).toBe(false)

    expect(result.current.recentSessions.map((r) => r.sessionId)).toEqual(['s3', 's2', 's1'])
    expect(result.current.recentSessions[0]).toEqual({
      sessionId: 's3',
      projectEncoded: '-p-a',
      path: `${a}/s3.jsonl`,
      mtimeMs: 300,
      sizeBytes: 10,
    })
    // The scan itself lists the root plus each folder exactly once; the calls
    // after those belong to cwd resolution, which is a separate stage.
    act(() => root.unmount())
    expect(listDir.mock.calls.slice(0, 3).map((c) => c[0])).toEqual([ROOT, a, b])
  })
})
