// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveProjectCwd, CWD_RESOLVE_MAX_BYTES } from '../useKnownProjects'

function mockConfig(opts: {
  entries: Array<{ name: string; path: string; size: number }>
  textByPath: Record<string, { exists: boolean; text: string; truncated?: boolean }>
}) {
  const readText = vi.fn(async (path: string) => {
    const r = opts.textByPath[path] ?? { exists: false, text: '' }
    return { exists: r.exists, text: r.text, mtimeMs: 0, error: null, truncated: r.truncated ?? false }
  })
  ;(globalThis as any).window.api = {
    config: {
      listDir: vi.fn(async () => ({ entries: opts.entries })),
      readText,
    },
  }
  return readText
}

describe('resolveProjectCwd', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the cwd found in the smallest jsonl file, using a bounded read', async () => {
    const readText = mockConfig({
      entries: [
        { name: 'big.jsonl', path: '/p/big.jsonl', size: 5000 },
        { name: 'small.jsonl', path: '/p/small.jsonl', size: 100 },
      ],
      textByPath: {
        '/p/small.jsonl': { exists: true, text: '{"cwd":"/home/user/project-a","other":1}\n' },
      },
    })

    const cwd = await resolveProjectCwd('/p')
    expect(cwd).toBe('/home/user/project-a')
    // smallest-first: small.jsonl (which has the cwd) is read; big.jsonl is
    // never consulted once resolution succeeds.
    expect(readText).toHaveBeenCalledWith('/p/small.jsonl', { maxBytes: CWD_RESOLVE_MAX_BYTES })
    expect(readText).not.toHaveBeenCalledWith('/p/big.jsonl', expect.anything())
  })

  it('falls back to the next candidate file when the first has no cwd, and never fabricates one', async () => {
    const readText = mockConfig({
      entries: [
        { name: 'a.jsonl', path: '/p/a.jsonl', size: 10 },
        { name: 'b.jsonl', path: '/p/b.jsonl', size: 20 },
      ],
      textByPath: {
        '/p/a.jsonl': { exists: true, text: '{"noCwdHere":true}\n' },
        '/p/b.jsonl': { exists: true, text: '{"cwd":"/home/user/project-b"}\n' },
      },
    })

    const cwd = await resolveProjectCwd('/p')
    expect(cwd).toBe('/home/user/project-b')
    expect(readText).toHaveBeenCalledWith('/p/a.jsonl', { maxBytes: CWD_RESOLVE_MAX_BYTES })
    expect(readText).toHaveBeenCalledWith('/p/b.jsonl', { maxBytes: CWD_RESOLVE_MAX_BYTES })
  })

  it('returns null (never a guessed path) when no file has a cwd field', async () => {
    mockConfig({
      entries: [{ name: 'a.jsonl', path: '/p/a.jsonl', size: 10 }],
      textByPath: {
        '/p/a.jsonl': { exists: true, text: '{"noCwdHere":true}\n' },
      },
    })

    const cwd = await resolveProjectCwd('/p')
    expect(cwd).toBeNull()
  })
})
