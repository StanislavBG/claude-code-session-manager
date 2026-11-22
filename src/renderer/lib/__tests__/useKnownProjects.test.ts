// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import {
  __resetKnownProjectsForTests,
  buildWorktreeOwnerMap,
  CWD_RESOLVE_MAX_BYTES,
  KNOWN_PROJECTS_REFRESH_MIN_GAP_MS,
  refreshKnownProjects,
  useKnownProjects,
} from '../useKnownProjects'

const ROOT = '/home/u/.claude/projects'
const file = (dir: string, name: string, mtimeMs: number, size = 10) => ({
  name,
  path: `${dir}/${name}`,
  mtimeMs,
  size,
})

beforeEach(() => __resetKnownProjectsForTests())
afterEach(() => vi.restoreAllMocks())

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

describe('buildWorktreeOwnerMap', () => {
  it('maps sha1(cwd) hex sliced to 16 chars to the cwd', async () => {
    const a = '/home/bilko/Projects/social-signals-trader'
    const b = '/home/bilko/Projects/session-manager'
    expect((await buildWorktreeOwnerMap([a])).get('ddb972d7a48ee4b5')).toBe(a)
    expect((await buildWorktreeOwnerMap([b])).get('fd076eb59c21f399')).toBe(b)
  })
})

type Hook = ReturnType<typeof useKnownProjects>
type Snapshot = Pick<Hook, 'rows' | 'recentSessions' | 'enriched' | 'projects' | 'loading' | 'resolving'>

/**
 * A fake ~/.claude/projects with two folders: -p-a (resolves to /p/a) and
 * -p-b (resolves to /p/b). `folders` is mutable so a test can add transcripts
 * between scans; `rootGate` can hold the root listDir to keep a scan in flight.
 */
function setupFs() {
  const a = `${ROOT}/-p-a`
  const b = `${ROOT}/-p-b`
  const folders: Record<string, ReturnType<typeof file>[]> = {
    [a]: [file(a, 's1.jsonl', 100)],
    [b]: [file(b, 's2.jsonl', 200)],
  }
  const cwdOf: Record<string, string> = { [a]: '/p/a', [b]: '/p/b' }
  const ctl = {
    a, b, folders,
    rootGate: null as Promise<void> | null,
    rootFail: false,
    /** package.json path → gate; holds that cwd's enrichment until released. */
    jsonGate: {} as Record<string, Promise<void>>,
  }
  const listDir = vi.fn(async (path: string) => {
    if (path === ROOT) {
      if (ctl.rootGate) await ctl.rootGate
      if (ctl.rootFail) throw new Error('boom')
      return { entries: Object.keys(folders).map((p) => ({ name: p.slice(ROOT.length + 1), path: p })) }
    }
    return { entries: folders[path] ?? [] }
  })
  const readText = vi.fn(async (path: string, opts?: { maxBytes?: number }) => {
    const dir = path.slice(0, path.lastIndexOf('/'))
    if (opts?.maxBytes === CWD_RESOLVE_MAX_BYTES && cwdOf[dir]) {
      return { exists: true, text: `{"type":"user","cwd":"${cwdOf[dir]}"}\n`, mtimeMs: 0, error: null, truncated: false }
    }
    return { exists: false, text: '', mtimeMs: 0, error: null, truncated: false }
  })
  const archiveProject = vi.fn(async () => ({ ok: true }))
  const readJson = vi.fn(async (path: string) => {
    const gate: Promise<void> | undefined = ctl.jsonGate[path]
    if (gate) await gate
    return { exists: false, data: null }
  })
  ;(globalThis as any).window.api = {
    app: { homeDir: vi.fn(async () => '/home/u'), archiveProject },
    config: {
      listDir,
      readText,
      readJson,
    },
  }
  return { ...ctl, ctl, cwdOf, listDir, readText, readJson, archiveProject }
}

async function mountProbe() {
  const ref: { current: Hook | null; snapshots: Snapshot[] } = { current: null, snapshots: [] }
  const Probe = () => {
    const h = useKnownProjects()
    ref.current = h
    ref.snapshots.push({
      rows: h.rows, recentSessions: h.recentSessions, enriched: h.enriched,
      projects: h.projects, loading: h.loading, resolving: h.resolving,
    })
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => { root.render(createElement(Probe)) })
  // Wait for home to resolve and the hook's effect to start the first scan.
  for (let i = 0; i < 50 && ref.current!.loading && ref.snapshots.length < 2; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)) })
  }
  // refreshKnownProjects returns the in-flight (first) scan's promise.
  await act(async () => { await refreshKnownProjects() })
  return { ref, unmount: () => act(() => root.unmount()) }
}

const cwdReadsFor = (readText: ReturnType<typeof setupFs>['readText'], dir: string) =>
  readText.mock.calls.filter(([p, o]) => (o as any)?.maxBytes === CWD_RESOLVE_MAX_BYTES && String(p).startsWith(`${dir}/`))

describe('refreshKnownProjects', () => {
  it('resolves without scanning before the hook has started a first scan', async () => {
    const fs = setupFs()
    await refreshKnownProjects({ force: true })
    expect(fs.listDir).not.toHaveBeenCalled()
  })

  it('first scan resolves projects and its promise resolves only after enrichment', async () => {
    setupFs()
    const { ref, unmount } = await mountProbe()
    expect(ref.current!.loading).toBe(false)
    expect(ref.current!.resolving).toBe(false)
    expect(ref.current!.projects.map((p) => p.cwd).sort()).toEqual(['/p/a', '/p/b'])
    expect(ref.current!.enriched['-p-a']).toMatchObject({ cwd: '/p/a', name: 'a' })
    unmount()
  })

  it('picks up a new transcript on a forced rescan, newest first', async () => {
    const fs = setupFs()
    const { ref, unmount } = await mountProbe()
    fs.folders[fs.a].push(file(fs.a, 's9.jsonl', 999))
    await act(async () => { await refreshKnownProjects({ force: true }) })
    expect(ref.current!.recentSessions[0].sessionId).toBe('s9')
    expect(ref.current!.recentSessions.map((r) => r.sessionId)).toEqual(['s9', 's2', 's1'])
    unmount()
  })

  it('never flickers: no loading/resolving true and resolved projects stay listed on every published state', async () => {
    const fs = setupFs()
    const { ref, unmount } = await mountProbe()
    const before = ref.snapshots.length
    fs.folders[fs.b].push(file(fs.b, 's3.jsonl', 500))
    await act(async () => { await refreshKnownProjects({ force: true }) })
    const during = ref.snapshots.slice(before)
    expect(during.length).toBeGreaterThan(0)
    for (const snap of during) {
      expect(snap.loading).toBe(false)
      expect(snap.resolving).toBe(false)
      expect(Object.keys(snap.enriched).sort()).toEqual(['-p-a', '-p-b'])
      expect(snap.enriched['-p-a']).toMatchObject({ cwd: '/p/a', name: 'a' })
      expect(snap.projects.map((p) => p.cwd).sort()).toEqual(['/p/a', '/p/b'])
    }
    unmount()
  })

  it('does not re-read transcripts of a folder whose cwd already resolved; retries unresolved ones', async () => {
    const fs = setupFs()
    const c = `${ROOT}/-p-c`
    fs.folders[c] = [file(c, 's5.jsonl', 50)] // no cwd mapping → never resolves
    const { unmount } = await mountProbe()
    expect(cwdReadsFor(fs.readText, fs.a)).toHaveLength(1)
    expect(cwdReadsFor(fs.readText, c)).toHaveLength(1)
    await act(async () => { await refreshKnownProjects({ force: true }) })
    expect(cwdReadsFor(fs.readText, fs.a)).toHaveLength(1)
    expect(cwdReadsFor(fs.readText, fs.b)).toHaveLength(1)
    expect(cwdReadsFor(fs.readText, c)).toHaveLength(2)
    unmount()
  })

  it('skips unforced calls within the 30 s gap and dedupes concurrent calls', async () => {
    const fs = setupFs()
    const t0 = 1_000_000
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0)
    const { unmount } = await mountProbe()
    const rootCalls = () => fs.listDir.mock.calls.filter(([p]) => p === ROOT).length
    expect(rootCalls()).toBe(1)

    now.mockReturnValue(t0 + KNOWN_PROJECTS_REFRESH_MIN_GAP_MS - 1)
    await act(async () => { await refreshKnownProjects() })
    expect(rootCalls()).toBe(1)

    now.mockReturnValue(t0 + KNOWN_PROJECTS_REFRESH_MIN_GAP_MS)
    let release!: () => void
    fs.ctl.rootGate = new Promise<void>((r) => { release = r })
    const p1 = refreshKnownProjects()
    const p2 = refreshKnownProjects()
    const p3 = refreshKnownProjects({ force: true })
    expect(p2).toBe(p1)
    expect(p3).toBe(p1)
    release()
    fs.ctl.rootGate = null
    await act(async () => { await Promise.all([p1, p2, p3]) })
    expect(rootCalls()).toBe(2)

    // force ignores the gap
    await act(async () => { await refreshKnownProjects({ force: true }) })
    expect(rootCalls()).toBe(3)
    unmount()
  })

  it('rejects on a failed rescan and keeps the previous data', async () => {
    const fs = setupFs()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ref, unmount } = await mountProbe()
    const prev = ref.current!
    fs.ctl.rootFail = true
    let caught: unknown = null
    await act(async () => { await refreshKnownProjects({ force: true }).catch((e) => { caught = e }) })
    expect(caught).toBeInstanceOf(Error)
    expect(err).toHaveBeenCalled()
    expect(ref.current!.rows).toBe(prev.rows)
    expect(ref.current!.recentSessions).toBe(prev.recentSessions)
    expect(ref.current!.enriched).toBe(prev.enriched)
    unmount()
  })

  it('drops a folder archived while a scan is in flight', async () => {
    const fs = setupFs()
    const { ref, unmount } = await mountProbe()
    let release!: () => void
    fs.ctl.rootGate = new Promise<void>((r) => { release = r })
    const p = refreshKnownProjects({ force: true })
    await act(async () => {
      const r = await ref.current!.archiveProject('-p-b')
      expect(r.ok).toBe(true)
    })
    // The archive happened on disk only after the root listing was requested;
    // the in-flight listing still reports the folder.
    release()
    fs.ctl.rootGate = null
    await act(async () => { await p })
    expect(fs.archiveProject).toHaveBeenCalledWith('-p-b')
    expect(ref.current!.rows.map((r) => r.encoded)).toEqual(['-p-a'])
    expect(ref.current!.recentSessions.map((r) => r.projectEncoded)).toEqual(['-p-a'])
    expect(ref.current!.projects.map((p) => p.cwd)).toEqual(['/p/a'])
    expect(ref.current!.enriched['-p-b']).toBeUndefined()
    unmount()
  })
})

/** Every enrichProject read (package.json via readJson; .git/config, .git/HEAD, CLAUDE.md via readText) under `cwd`. */
const enrichReadsFor = (fs: ReturnType<typeof setupFs>, cwd: string) => [
  ...fs.readJson.mock.calls.map(([p]) => String(p)),
  ...fs.readText.mock.calls
    .filter(([, o]) => (o as any)?.maxBytes !== CWD_RESOLVE_MAX_BYTES)
    .map(([p]) => String(p)),
].filter((p) => p.startsWith(`${cwd}/`))

describe('enrichment stage', () => {
  const WT = '/home/u/.local/state/session-manager/session-manager-job-worktrees/0123456789abcdef/some-slug'

  it('never enriches a managed worktree cwd, initial or refresh, while enriching /p/a', async () => {
    const fs = setupFs()
    const w = `${ROOT}/-wt`
    fs.folders[w] = [file(w, 'w1.jsonl', 300)]
    fs.cwdOf[w] = WT
    const { ref, unmount } = await mountProbe()
    expect(ref.current!.enriched['-wt']).toMatchObject({ cwd: WT })
    expect(enrichReadsFor(fs, WT)).toEqual([])
    expect(enrichReadsFor(fs, '/p/a').sort()).toEqual(
      ['/p/a/.git/HEAD', '/p/a/.git/config', '/p/a/CLAUDE.md', '/p/a/package.json'],
    )
    fs.folders[w].push(file(w, 'w2.jsonl', 900))
    await act(async () => { await refreshKnownProjects({ force: true }) })
    expect(enrichReadsFor(fs, WT)).toEqual([])
    unmount()
  })

  it('a forced rescan with unchanged folders makes no enrichment read and keeps details', async () => {
    const fs = setupFs()
    const { ref, unmount } = await mountProbe()
    const jsonBefore = fs.readJson.mock.calls.length
    const textBefore = fs.readText.mock.calls.length
    await act(async () => { await refreshKnownProjects({ force: true }) })
    expect(fs.readJson.mock.calls.length).toBe(jsonBefore)
    expect(fs.readText.mock.calls.length).toBe(textBefore)
    expect(ref.current!.enriched['-p-a']).toMatchObject({ cwd: '/p/a', name: 'a' })
    expect(ref.current!.enriched['-p-b']).toMatchObject({ cwd: '/p/b', name: 'b' })
    unmount()
  })

  it('re-enriches only a folder whose newest transcript mtime grew', async () => {
    const fs = setupFs()
    const { unmount } = await mountProbe()
    expect(enrichReadsFor(fs, '/p/a')).toHaveLength(4)
    expect(enrichReadsFor(fs, '/p/b')).toHaveLength(4)
    fs.folders[fs.a].push(file(fs.a, 's7.jsonl', 700))
    await act(async () => { await refreshKnownProjects({ force: true }) })
    expect(enrichReadsFor(fs, '/p/a')).toHaveLength(8)
    expect(enrichReadsFor(fs, '/p/b')).toHaveLength(4)
    unmount()
  })

  it('publishes the enrichment stage once', async () => {
    const fs = setupFs()
    const c = `${ROOT}/-p-c`
    fs.folders[c] = [file(c, 's3.jsonl', 300)]
    fs.cwdOf[c] = '/p/c'
    // Hold each cwd's enrichment so every one settles in its own act turn — a
    // per-cwd publish would then show up as its own rendered `enriched` object.
    const releases: Array<() => void> = []
    for (const cwd of ['/p/a', '/p/b', '/p/c']) {
      fs.ctl.jsonGate[`${cwd}/package.json`] = new Promise<void>((r) => { releases.push(r) })
    }
    const snapshots: Snapshot[] = []
    const ref: { current: Hook | null } = { current: null }
    const Probe = () => {
      const h = useKnownProjects()
      ref.current = h
      snapshots.push({
        rows: h.rows, recentSessions: h.recentSessions, enriched: h.enriched,
        projects: h.projects, loading: h.loading, resolving: h.resolving,
      })
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => { root.render(createElement(Probe)) })
    for (let i = 0; i < 100 && (!ref.current || ref.current.resolving); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)) })
    }
    expect(ref.current!.resolving).toBe(false)
    for (const release of releases) {
      await act(async () => {
        release()
        await new Promise((r) => setTimeout(r, 5))
      })
    }
    await act(async () => { await refreshKnownProjects() })
    const firstResolved = snapshots.findIndex((s) => !s.resolving)
    const resolveStage = snapshots[firstResolved].enriched
    const after = new Set(snapshots.slice(firstResolved).map((s) => s.enriched).filter((e) => e !== resolveStage))
    expect(after.size).toBe(1)
    const [final] = [...after]
    expect(final['-p-a']).toMatchObject({ cwd: '/p/a', name: 'a' })
    expect(final['-p-c']).toMatchObject({ cwd: '/p/c', name: 'c' })
    act(() => root.unmount())
  })
})
