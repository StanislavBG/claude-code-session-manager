import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

const requireCjs = createRequire(import.meta.url)

/**
 * Pins the atomic-write contract before B6 unifies the five duplicated
 * tmp+rename recipes (config.cjs, scheduler.cjs sync+async, sessionsStore,
 * voiceSettings, otelSettings).
 *
 * Invariants under test:
 *   1. Writing produces the target file with the expected content.
 *   2. On success no .tmp-* sibling lingers in the dir.
 *   3. The sync variant (used by child-exit handlers — see scheduler.cjs L141)
 *      completes without an event-loop yield. Replacing it with an async
 *      variant inside an exit handler would deadlock; B6 must preserve a sync
 *      path.
 *   4. The async variant under failure (tmp dir unwritable) does NOT leave
 *      orphaned tmp files in the parent of the target.
 */

describe('atomic write contract (config.cjs writeTextAtomic + scheduler.cjs atomicWriteJsonSync)', () => {
  let workdir: string
  let homeBackup: string | undefined

  beforeEach(async () => {
    workdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-atomic-write-'))
    homeBackup = process.env.HOME
    process.env.HOME = workdir
    // Force a fresh require so config.cjs's allowedRoots picks up the new HOME.
    delete requireCjs.cache?.[requireCjs.resolve('../../src/main/config.cjs')]
  })

  afterEach(async () => {
    if (homeBackup !== undefined) process.env.HOME = homeBackup
    else delete process.env.HOME
    await fsp.rm(workdir, { recursive: true, force: true })
  })

  describe('async writeTextAtomic (config.cjs)', () => {
    it('writes the file and produces the expected content', async () => {
      const config = requireCjs('../../src/main/config.cjs')
      const target = path.join(workdir, '.claude', 'foo.txt')
      const r = await config.writeTextAtomic(target, 'hello world\n')
      expect(r.ok).toBe(true)
      expect(fs.readFileSync(target, 'utf8')).toBe('hello world\n')
    })

    it('leaves no .tmp-* sibling after a successful write', async () => {
      const config = requireCjs('../../src/main/config.cjs')
      const target = path.join(workdir, '.claude', 'bar.txt')
      await config.writeTextAtomic(target, 'x')
      const siblings = fs.readdirSync(path.dirname(target))
      const tmps = siblings.filter((n) => n.includes('.tmp-'))
      expect(tmps).toEqual([])
    })

    it('overwrites an existing file atomically (no partial state visible)', async () => {
      const config = requireCjs('../../src/main/config.cjs')
      const target = path.join(workdir, '.claude', 'overwrite.txt')
      await config.writeTextAtomic(target, 'first content')
      await config.writeTextAtomic(target, 'second content')
      expect(fs.readFileSync(target, 'utf8')).toBe('second content')
      const tmps = fs.readdirSync(path.dirname(target)).filter((n) => n.includes('.tmp-'))
      expect(tmps).toEqual([])
    })

    it('rejects writes outside the allowed write boundary', async () => {
      const config = requireCjs('../../src/main/config.cjs')
      const target = path.join(workdir, 'not-claude-subdir', 'foo.txt')
      await expect(config.writeTextAtomic(target, 'x')).rejects.toThrow()
    })

    it('writeJson serializes with trailing newline', async () => {
      const config = requireCjs('../../src/main/config.cjs')
      const target = path.join(workdir, '.claude', 'obj.json')
      await config.writeJson(target, { a: 1, b: [2, 3] })
      const raw = fs.readFileSync(target, 'utf8')
      expect(raw.endsWith('\n')).toBe(true)
      expect(JSON.parse(raw)).toEqual({ a: 1, b: [2, 3] })
    })
  })

  describe('sync writeJsonSync path', () => {
    it('writeJsonSync writes and renames synchronously without event-loop yield', () => {
      const config = requireCjs('../../src/main/config.cjs')
      expect(typeof config.writeJsonSync).toBe('function')
      const target = path.join(workdir, '.claude', 'sync.json')
      const r = config.writeJsonSync(target, { x: 1 })
      expect(r.ok).toBe(true)
      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ x: 1 })
      const tmps = fs.readdirSync(path.dirname(target)).filter((n: string) => n.includes('.tmp'))
      expect(tmps).toEqual([])
    })

    it('writeJsonSync rejects writes outside the allowed write boundary', () => {
      const config = requireCjs('../../src/main/config.cjs')
      const target = path.join(workdir, 'not-claude-subdir', 'foo.json')
      expect(() => config.writeJsonSync(target, { x: 1 })).toThrow()
    })

    it('writeJsonSync cleans up tmp file on rename failure (no orphans)', () => {
      // Pre-create a directory at the target so rename fails with EISDIR
      const config = requireCjs('../../src/main/config.cjs')
      const target = path.join(workdir, '.claude', 'busy')
      fs.mkdirSync(target, { recursive: true })
      expect(() => config.writeJsonSync(target, { x: 1 })).toThrow()
      const tmps = fs.readdirSync(path.dirname(target)).filter((n: string) => n.includes('.tmp'))
      expect(tmps).toEqual([])
    })
  })

  describe('scheduler.cjs no longer owns its own atomic-write impl (post-B6)', () => {
    // After B6 (atomic-write unification), scheduler.cjs delegates to
    // config.writeJsonSync. We assert that the duplicate impl is gone so a
    // future regression to inline-tmp+rename gets caught immediately.
    it('source no longer contains the inline tmp+renameSync recipe', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'main', 'scheduler.cjs'),
        'utf8',
      )
      // None of: fs.writeFileSync(tmp, ...); fsp.writeFile(tmp, ...); fsp.rename(tmp, ...).
      // The line `* via fs.writeFileSync(tmp) + rename.` lives in the file-header
      // comment and is historical — exempt it.
      const codeOnly = src
        .split('\n')
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
        .join('\n')
      expect(codeOnly).not.toMatch(/fs\.writeFileSync\(tmp/)
      expect(codeOnly).not.toMatch(/fsp\.writeFile\(tmp/)
      // And that the helpers are bound to config.cjs's shared impl.
      expect(src).toMatch(/atomicWriteJsonSync\s*=\s*\(.*\)\s*=>\s*config\.writeJsonSync/)
    })
  })
})
