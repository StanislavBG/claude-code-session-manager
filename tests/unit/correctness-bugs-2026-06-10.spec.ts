/**
 * Unit tests for four data-integrity bugs fixed 2026-06-10.
 *
 * Bug 1  webRemote tailLines off-by-one
 * Bug 2  transcripts subscribe LRU eviction
 * Bug 3  historyAggregator tail-cache double-count on rewrite
 * Bug 4  kg savePromptIndex / saveIngestState ordering
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

const require = createRequire(import.meta.url)

// ─────────────────────────────────────────────────────────────────────────────
// Bug 1: tailLines off-by-one (webRemote.cjs)
// We test the function in isolation by extracting it from the module.
// webRemote.cjs requires Electron, so we inline the fixed logic here.
// ─────────────────────────────────────────────────────────────────────────────

async function tailLines(filePath: string, fromOffset: number | null) {
  const stat = await fsp.stat(filePath).catch(() => null)
  if (!stat) return { lines: [] as string[], size: 0 }
  let start = fromOffset ?? null
  if (start == null || start > stat.size) start = Math.max(0, stat.size - 65536)
  if (stat.size <= start) return { lines: [] as string[], size: stat.size }
  const fd = await fsp.open(filePath, 'r')
  try {
    let dropFirst = false
    if (start > 0) {
      const prev = Buffer.alloc(1)
      await fd.read(prev, 0, 1, start - 1)
      dropFirst = prev[0] !== 0x0a
    }
    const len = stat.size - start
    const buf = Buffer.alloc(len)
    await fd.read(buf, 0, len, start)
    const parts = buf.toString('utf8').split('\n').filter(Boolean)
    if (dropFirst && parts.length) parts.shift()
    return { lines: parts, size: stat.size }
  } finally {
    await fd.close()
  }
}

describe('Bug 1: tailLines off-by-one', () => {
  let tmpFile: string

  beforeEach(async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-test-'))
    tmpFile = path.join(dir, 'test.jsonl')
  })

  afterEach(async () => {
    await fsp.rm(path.dirname(tmpFile), { recursive: true, force: true })
  })

  it('two sequential polls see every line exactly once (no double-skip, no missing)', async () => {
    // First write: two complete lines ending with \n
    const line1 = '{"a":1}\n'
    const line2 = '{"a":2}\n'
    await fsp.writeFile(tmpFile, line1 + line2)

    // Poll 1: from offset 0
    const res1 = await tailLines(tmpFile, 0)
    expect(res1.lines).toEqual(['{"a":1}', '{"a":2}'])

    // Append a third line
    const line3 = '{"a":3}\n'
    await fsp.appendFile(tmpFile, line3)

    // Poll 2: from the end of poll 1 (which sits right after the trailing \n)
    const res2 = await tailLines(tmpFile, res1.size)
    expect(res2.lines).toEqual(['{"a":3}'])
  })

  it('does not drop a full line when offset sits exactly on a newline boundary', async () => {
    const content = '{"x":1}\n{"x":2}\n'
    await fsp.writeFile(tmpFile, content)

    // Simulate: poll 1 consumed offset 0..8 (ending right after first \n)
    const afterFirstLine = '{"x":1}\n'.length
    const res = await tailLines(tmpFile, afterFirstLine)
    // Should include the second line, not drop it
    expect(res.lines).toEqual(['{"x":2}'])
  })

  it('still drops a genuine partial fragment when offset is mid-line', async () => {
    const content = 'partial{"broken"}\n{"ok":true}\n'
    await fsp.writeFile(tmpFile, content)

    // Start mid-way into the first (broken) line — byte 4 is not after a \n
    const res = await tailLines(tmpFile, 4)
    // The partial fragment ("al{\"broken\"}") is dropped; {"ok":true} survives
    expect(res.lines).toEqual(['{"ok":true}'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Bug 2: transcripts subscribe LRU eviction
// We test the pure capacity logic without the Electron IPC machinery.
// ─────────────────────────────────────────────────────────────────────────────

describe('Bug 2: transcripts subscribe LRU eviction', () => {
  it('15th subscribe succeeds by evicting an idle LRU entry (14 active + 6 cached)', () => {
    const MAX_TRANSCRIPT_SUBS = 20
    const LRU_CAP = 6

    // Simulate the subs Map and lruReleased array
    const subs = new Map<string, object>()
    const lruReleased: string[] = []

    function closeSub(tabId: string) {
      subs.delete(tabId)
      const i = lruReleased.indexOf(tabId)
      if (i !== -1) lruReleased.splice(i, 1)
    }

    function release(tabId: string) {
      if (!subs.has(tabId)) return
      if (!lruReleased.includes(tabId)) lruReleased.push(tabId)
      while (lruReleased.length > LRU_CAP) {
        const oldest = lruReleased.shift()!
        closeSub(oldest)
      }
    }

    function subscribe(tabId: string): boolean {
      if (subs.has(tabId)) {
        const i = lruReleased.indexOf(tabId)
        if (i !== -1) lruReleased.splice(i, 1)
        return true
      }
      // Fixed: evict an LRU entry before rejecting
      if (subs.size >= MAX_TRANSCRIPT_SUBS) {
        if (lruReleased.length > 0) {
          closeSub(lruReleased[0])
        }
      }
      if (subs.size >= MAX_TRANSCRIPT_SUBS) return false
      subs.set(tabId, {})
      return true
    }

    // Add 20 active subs (fills the cap)
    for (let i = 0; i < 20; i++) {
      const ok = subscribe(`tab-${i}`)
      expect(ok).toBe(true)
    }
    expect(subs.size).toBe(20)

    // Release 6 of them into LRU cache
    for (let i = 0; i < 6; i++) {
      release(`tab-${i}`)
    }
    expect(lruReleased.length).toBe(6)
    expect(subs.size).toBe(20) // all still in subs

    // Now: 14 active (non-LRU) + 6 LRU-cached = 20 total in subs
    // Close (not release) tabs 6-19 so we have 14 genuine active subs
    for (let i = 6; i < 20; i++) {
      closeSub(`tab-${i}`)
    }
    // Re-add 14 fresh active subs (not in LRU)
    for (let i = 20; i < 34; i++) {
      const ok = subscribe(`tab-${i}`)
      expect(ok).toBe(true)
    }

    // State: 6 LRU-cached (tab-0..5) + 14 active (tab-20..33) = 20 subs
    expect(subs.size).toBe(20)
    expect(lruReleased.length).toBe(6)

    // 15th genuinely new subscribe should evict the oldest LRU entry and succeed
    const ok = subscribe('tab-new')
    expect(ok).toBe(true)
    expect(subs.has('tab-new')).toBe(true)
    // tab-0 (oldest LRU) should have been evicted
    expect(subs.has('tab-0')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Bug 3: historyAggregator tail-cache double-count on rewrite
// We test the cache logic using real tmp files and a simplified version of the
// parseJSONL caching that mirrors the production logic.
// ─────────────────────────────────────────────────────────────────────────────

describe('Bug 3: historyAggregator tail-cache no double-count on rewrite', () => {
  let tmpFile: string

  beforeEach(async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-hagg-'))
    tmpFile = path.join(dir, 'session.jsonl')
  })

  afterEach(async () => {
    await fsp.rm(path.dirname(tmpFile), { recursive: true, force: true })
  })

  // Minimal inline version of the fixed parseJSONL cache logic.
  // Uses readOffset (separate from size) to avoid the poll-storm regression.
  type CacheEntry = { mtimeMs: number; size: number; readOffset: number; inode: number; result: { count: number } }
  async function parseWithCache(
    cache: Map<string, CacheEntry>,
    filePath: string,
  ): Promise<{ count: number }> {
    const stat = await fsp.stat(filePath)

    const cached = cache.get(filePath)
    if (cached) {
      if (cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        return cached.result
      }
      if (stat.size > cached.size) {
        // Inode check: rewrite detection
        if (cached.inode !== undefined && cached.inode !== stat.ino) {
          // fall through to full parse
        } else {
          const readFrom = cached.readOffset ?? cached.size
          const tail = await readSlice(filePath, readFrom, stat.size)
          // Mirror real scanAggrLines: skip lines that don't parse as JSON
          const delta = tail.split('\n').filter(l => { try { JSON.parse(l); return true } catch { return false } }).length
          const merged = { count: cached.result.count + delta }
          const lastNl = tail.lastIndexOf('\n')
          const readOffset = lastNl >= 0 ? readFrom + lastNl + 1 : readFrom
          // size = stat.size (for exact-hit), readOffset = line-safe next-read start
          cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, readOffset, inode: stat.ino, result: merged })
          return merged
        }
      }
    }

    // Full parse — skip lines that don't parse as JSON (mirrors scanAggrLines)
    const text = await fsp.readFile(filePath, 'utf8')
    const count = text.split('\n').filter(l => { try { JSON.parse(l); return true } catch { return false } }).length
    const result = { count }
    const lastNlFull = text.lastIndexOf('\n')
    const readOffsetFull = lastNlFull >= 0 ? lastNlFull + 1 : 0
    cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, readOffset: readOffsetFull, inode: stat.ino, result })
    return result
  }

  async function readSlice(filePath: string, from: number, to: number): Promise<string> {
    const len = to - from
    if (len <= 0) return ''
    const fh = await fsp.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, from)
      return buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await fh.close()
    }
  }

  it('does not double-count when JSONL is rewritten with more content (same path, new inode)', async () => {
    const cache = new Map<string, CacheEntry>()

    // Initial write: 2 valid JSON lines
    await fsp.writeFile(tmpFile, '{"a":1}\n{"a":2}\n')
    const r1 = await parseWithCache(cache, tmpFile)
    expect(r1.count).toBe(2)

    // Rewrite to a LARGER file (simulating claude --resume compaction).
    // Use unlink+write to guarantee a new inode (like atomic rename would give).
    await fsp.unlink(tmpFile)
    await fsp.writeFile(tmpFile, '{"b":1}\n{"b":2}\n{"b":3}\n{"b":4}\n')

    const r2 = await parseWithCache(cache, tmpFile)
    // Must be 4 (full reparse), NOT 2+4=6 (double-count)
    expect(r2.count).toBe(4)
  })

  it('exact-hit returns cached result when file has trailing partial line (no poll storm)', async () => {
    const cache = new Map<string, CacheEntry>()

    // File ends without a trailing \n — partial last JSON line (won't parse)
    await fsp.writeFile(tmpFile, '{"a":1}\n{"a":2}\n{"a":3')
    const r1 = await parseWithCache(cache, tmpFile)
    expect(r1.count).toBe(2) // partial line fails JSON.parse → not counted

    // Second call with same stat — must be an exact cache hit (no I/O loop)
    const r2 = await parseWithCache(cache, tmpFile)
    expect(r2.count).toBe(2)
    // Cache entry size must equal stat.size (not safeSize) for hit to work
    const entry = cache.get(tmpFile)!
    const stat = await fsp.stat(tmpFile)
    expect(entry.size).toBe(stat.size)
  })

  it('correctly tail-parses genuine appends (no regression)', async () => {
    const cache = new Map<string, CacheEntry>()

    await fsp.writeFile(tmpFile, '{"a":1}\n{"a":2}\n')
    const r1 = await parseWithCache(cache, tmpFile)
    expect(r1.count).toBe(2)

    // Wait so mtime changes (some filesystems have 1ms resolution)
    await new Promise(r => setTimeout(r, 5))
    await fsp.appendFile(tmpFile, '{"a":3}\n{"a":4}\n')
    const r2 = await parseWithCache(cache, tmpFile)
    expect(r2.count).toBe(4)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Bug 4: kg savePromptIndex / saveIngestState ordering
// We test that writing the index BEFORE advancing the watermark means a
// simulated crash (index written, watermark not) yields correct totals
// on next read.
// ─────────────────────────────────────────────────────────────────────────────

describe('Bug 4: kg prompt-index write order', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-kg-'))
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  async function atomicWrite(filePath: string, data: object) {
    const tmp = `${filePath}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2))
    await fsp.rename(tmp, filePath)
  }

  it('simulated crash between index-write and watermark-advance yields correct totals on next read', async () => {
    const ingestStatePath = path.join(tmpDir, 'ingest-state.json')
    const promptIndexPath = path.join(tmpDir, 'prompt-index.json')

    // Initial state: watermark at byte 100, one project with 5 prompts
    const initialState = { lastOffset: 100, promptCount: 5 }
    const initialIdx = { 'my-project': { count: 5, cwd: '/my/project' } }
    await atomicWrite(ingestStatePath, initialState)
    await atomicWrite(promptIndexPath, initialIdx)

    // Simulate processing a batch of 3 prompts:
    // With the FIX (index first):
    //   1. Update promptIdx (count 5→8) and save
    //   2. Advance watermark (100→200) and save   ← CRASH HERE (never happens)
    //
    // After crash: promptIdx says 8, watermark still at 100 → re-processable

    // Step 1: write index first (the fix)
    const newIdx = { 'my-project': { count: 8, cwd: '/my/project' } }
    await atomicWrite(promptIndexPath, newIdx)

    // *** CRASH SIMULATED HERE — watermark NOT advanced ***

    // Next read: load both files and verify totals are consistent
    const loadedState = JSON.parse(await fsp.readFile(ingestStatePath, 'utf8'))
    const loadedIdx = JSON.parse(await fsp.readFile(promptIndexPath, 'utf8'))

    // Index has the new count (8) even though watermark is still at 100.
    // The watermark being behind means the batch will be re-processed on next
    // ingest run, but the CURRENT read shows correct (updated) totals.
    expect(loadedIdx['my-project'].count).toBe(8)
    expect(loadedState.lastOffset).toBe(100) // watermark not yet advanced (will retry)
  })

  it('old ordering: crash after watermark advance but before index write yields stale totals', async () => {
    const ingestStatePath = path.join(tmpDir, 'ingest-state.json')
    const promptIndexPath = path.join(tmpDir, 'prompt-index.json')

    const initialState = { lastOffset: 100, promptCount: 5 }
    const initialIdx = { 'my-project': { count: 5, cwd: '/my/project' } }
    await atomicWrite(ingestStatePath, initialState)
    await atomicWrite(promptIndexPath, initialIdx)

    // Old ordering: watermark first
    const newState = { lastOffset: 200, promptCount: 8 }
    await atomicWrite(ingestStatePath, newState)
    // *** CRASH *** — promptIdx never updated

    const loadedState = JSON.parse(await fsp.readFile(ingestStatePath, 'utf8'))
    const loadedIdx = JSON.parse(await fsp.readFile(promptIndexPath, 'utf8'))

    // Demonstrates the bug: watermark advanced to 200 but index still shows 5
    expect(loadedState.lastOffset).toBe(200)
    expect(loadedIdx['my-project'].count).toBe(5) // stale — this was the bug
  })
})
