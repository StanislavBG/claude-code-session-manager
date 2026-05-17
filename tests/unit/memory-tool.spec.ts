import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

const requireCjs = createRequire(import.meta.url)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMod = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEntry = any

// Memory tab bug (renderer #2 from consolidation review): the renderer keeps
// its own draft/saved maps and does NOT subscribe to a chokidar watcher on the
// memories directory. Result: an external `claude` write clobbers the UI's
// stale state when the user saves. The fix in B5 adds a watcher subscription.
//
// This spec pins the *backend* invariant that makes that fix possible:
// memoryTool.list() must reflect external filesystem changes — no caching, no
// stale view. If this regresses (someone adds a cache for perf), the renderer
// fix becomes uncorrectable. Hence: pin before refactor.

describe('memoryTool list() reflects external filesystem changes', () => {
  let workdir: string
  let homeBackup: string | undefined
  let memoryTool: AnyMod

  beforeEach(async () => {
    workdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mem-test-'))
    // Point HOME at the temp dir so memoryTool's memoryRoot() resolves inside it.
    homeBackup = process.env.HOME
    process.env.HOME = workdir
    // Reset config.cjs's allowedRoots cache so validatePath honors the new HOME.
    // Done by re-requiring the modules from a fresh require cache.
    delete requireCjs.cache?.[requireCjs.resolve('../../src/main/memoryTool.cjs')]
    delete requireCjs.cache?.[requireCjs.resolve('../../src/main/config.cjs')]
    memoryTool = requireCjs('../../src/main/memoryTool.cjs')
    // Ensure workspace dir exists for the 'default' workspace
    const ws = path.join(workdir, '.claude', 'session-manager', 'memories', 'default')
    fs.mkdirSync(ws, { recursive: true })
  })

  afterEach(async () => {
    if (homeBackup !== undefined) process.env.HOME = homeBackup
    else delete process.env.HOME
    await fsp.rm(workdir, { recursive: true, force: true })
  })

  it('list() picks up a file written directly to the workspace dir', async () => {
    const ws = path.join(workdir, '.claude', 'session-manager', 'memories', 'default')
    const filename = 'external-write.md'
    const target = path.join(ws, filename)

    // The contract: a new file becomes visible on the next list().
    const list1 = await callList(memoryTool, 'default')
    expect(list1.entries.map((e: AnyEntry) => e.name)).not.toContain(filename)

    // External write (simulates `claude` writing memory while UI is open)
    await fsp.writeFile(target, '# external\n', 'utf8')

    const list2 = await callList(memoryTool, 'default')
    expect(list2.entries.map((e: AnyEntry) => e.name)).toContain(filename)
  })

  it('list() picks up a file deletion immediately', async () => {
    const ws = path.join(workdir, '.claude', 'session-manager', 'memories', 'default')
    const target = path.join(ws, 'temp.md')
    await fsp.writeFile(target, '# temp\n', 'utf8')

    const list1 = await callList(memoryTool, 'default')
    expect(list1.entries.map((e: AnyEntry) => e.name)).toContain('temp.md')

    await fsp.unlink(target)

    const list2 = await callList(memoryTool, 'default')
    expect(list2.entries.map((e: AnyEntry) => e.name)).not.toContain('temp.md')
  })
})

// The memoryTool module doesn't export list() directly (it's wrapped in
// registerMemoryHandlers). We replicate the IPC handler body here, reading
// directly via config.listDir against the workspace dir.
async function callList(mod: AnyMod, workspace: string) {
  const config = requireCjs('../../src/main/config.cjs')
  const r = await config.listDir(mod.workspaceDir(workspace), { filesOnly: true })
  return {
    entries: (r.ok ? r.entries : [])
      .filter((e: AnyEntry) => e.name.endsWith('.md'))
      .map((e: AnyEntry) => ({ name: e.name, path: e.path, bytes: e.size, mtimeMs: e.mtimeMs }))
      .sort((a: AnyEntry, b: AnyEntry) => a.name.localeCompare(b.name)),
  }
}
