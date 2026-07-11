/**
 * Unit tests for chatRunner.cjs (PRD 470): the silent `/context` probe.
 *
 * `vi.mock('electron', ...)` is set up per the PRD spec even though chatRunner.cjs's
 * top-level `require('electron')` is harmless outside a real Electron process (the
 * `electron` npm package resolves to a path string, so destructuring `ipcMain` off it
 * is simply `undefined` unless `registerChatHandlers()` is actually invoked) — this
 * spec never calls `registerChatHandlers()`, so the mock is defensive, not load-bearing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))

const require = createRequire(import.meta.url)

// This repo's .cjs main-process specs load their target module via createRequire,
// which bypasses vitest's vi.mock transform pipeline. Patching the shared
// node:child_process / exchanges.cjs exports in place (before chatRunner.cjs's own
// require() destructures them) is the pattern that actually reaches chatRunner.cjs.
const cp = require('node:child_process') as { spawn: (...args: unknown[]) => unknown }
type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number; kill: (sig?: string) => void }
let nextChild: FakeChild | null = null
cp.spawn = () => {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 12345
  child.kill = () => {}
  nextChild = child
  return child
}

const exchanges = require('../../src/main/exchanges.cjs') as { recordExchange: (...a: unknown[]) => Promise<unknown> }
const recordExchangeCalls: unknown[][] = []
exchanges.recordExchange = (...args: unknown[]) => {
  recordExchangeCalls.push(args)
  return Promise.resolve()
}

const chatRunner = require('../../src/main/chatRunner.cjs') as {
  run: (opts: Record<string, unknown>) => void
  attachWindow: (win: unknown) => void
  parseContextUsageMarkdown: (text: string) => {
    usedTokens: number
    totalTokens: number
    usedPct: number
    categories: Array<{ category: string; tokens: number; pct: number }>
  } | null
  probeContextUsage: (opts: { tabId: string; sessionId: string; cwd: string }) => void
  __setExecutor: (fn: ((job: Record<string, unknown>) => Promise<void>) | null) => void
}

function emitResultLine(child: FakeChild, resultText: string) {
  const assistantLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: resultText }] } })
  const resultLine = JSON.stringify({ type: 'result', subtype: 'success', result: resultText })
  child.stdout.emit('data', Buffer.from(`${assistantLine}\n${resultLine}\n`))
  child.emit('exit', 0, null)
}

async function flush() {
  await new Promise((r) => setTimeout(r, 20))
}

const CONTEXT_MARKDOWN = `## Context Usage

**Model:** claude-sonnet-5
**Tokens:** 40k / 967k (4%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 9k | 0.9% |
| System tools | 15.1k | 1.6% |
| MCP tools (deferred) | 5.5k | 0.6% |
| System tools (deferred) | 16.3k | 1.7% |
| Custom agents | 207 | 0.0% |
| Memory files | 10.6k | 1.1% |
| Skills | 5.1k | 0.5% |
| Messages | 8 | 0.0% |
| Free space | 894k | 92.5% |
| Autocompact buffer | 33k | 3.4% |

### MCP Tools

- nothing here for this test
`

describe('parseContextUsageMarkdown', () => {
  it('parses the summary line and the category table', () => {
    const result = chatRunner.parseContextUsageMarkdown(CONTEXT_MARKDOWN)
    expect(result).not.toBeNull()
    expect(result!.usedTokens).toBe(40000)
    expect(result!.totalTokens).toBe(967000)
    expect(result!.usedPct).toBe(4)
    expect(result!.categories).toContainEqual({ category: 'System prompt', tokens: 9000, pct: 0.9 })
    expect(result!.categories).toContainEqual({ category: 'Custom agents', tokens: 207, pct: 0 })
    expect(result!.categories).toContainEqual({ category: 'Free space', tokens: 894000, pct: 92.5 })
    expect(result!.categories).toHaveLength(10)
  })

  it('returns null for malformed input', () => {
    expect(chatRunner.parseContextUsageMarkdown('garbage with no sections')).toBeNull()
  })

  it('returns null for empty/non-string input', () => {
    expect(chatRunner.parseContextUsageMarkdown('')).toBeNull()
    expect(chatRunner.parseContextUsageMarkdown(undefined as unknown as string)).toBeNull()
  })
})

describe('silent flag threading (run -> waiting -> executor)', () => {
  let captured: Array<Record<string, unknown>>

  beforeEach(() => {
    captured = []
    chatRunner.__setExecutor((job) => {
      captured.push(job)
      return Promise.resolve()
    })
  })

  it('threads silent:true from run() into the executor unchanged', async () => {
    chatRunner.run({ tabId: 'tab-silent', sessionId: 'sess-1', prompt: '/context', cwd: '/tmp', resume: true, silent: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(captured).toHaveLength(1)
    expect(captured[0].silent).toBe(true)
    expect(captured[0].resume).toBe(true)
  })

  it('leaves silent unset for a normal run() call (regression guard)', async () => {
    chatRunner.run({ tabId: 'tab-normal', sessionId: 'sess-2', prompt: 'hello', cwd: '/tmp', resume: false })
    await new Promise((r) => setTimeout(r, 0))
    expect(captured).toHaveLength(1)
    expect(captured[0].silent).toBeUndefined()
  })

  it('probeContextUsage enqueues a silent, resumed /context run with an onSilentResult hook', async () => {
    chatRunner.probeContextUsage({ tabId: 'tab-probe', sessionId: 'sess-3', cwd: '/repo' })
    await new Promise((r) => setTimeout(r, 0))
    expect(captured).toHaveLength(1)
    const job = captured[0]
    expect(job.prompt).toBe('/context')
    expect(job.resume).toBe(true)
    expect(job.silent).toBe(true)
    expect(typeof job.onSilentResult).toBe('function')
  })

  it('probeContextUsage\'s onSilentResult callback parses + broadcasts chat:context-usage', async () => {
    const sent: Array<[string, unknown]> = []
    chatRunner.attachWindow({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (ch: string, payload: unknown) => sent.push([ch, payload]) },
    })

    chatRunner.probeContextUsage({ tabId: 'tab-probe-2', sessionId: 'sess-4', cwd: '/repo' })
    await new Promise((r) => setTimeout(r, 0))
    const onSilentResult = captured[0].onSilentResult as (text: string) => void
    onSilentResult(CONTEXT_MARKDOWN)

    expect(sent).toHaveLength(1)
    const [channel, payload] = sent[0]
    expect(channel).toBe('chat:context-usage')
    expect(payload).toMatchObject({
      tabId: 'tab-probe-2',
      sessionId: 'sess-4',
      usedTokens: 40000,
      totalTokens: 967000,
      usedPct: 4,
    })
  })

  it('onSilentResult does NOT broadcast when parseContextUsageMarkdown returns null', async () => {
    const sent: Array<[string, unknown]> = []
    chatRunner.attachWindow({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (ch: string, payload: unknown) => sent.push([ch, payload]) },
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    chatRunner.probeContextUsage({ tabId: 'tab-probe-3', sessionId: 'sess-5', cwd: '/repo' })
    await new Promise((r) => setTimeout(r, 0))
    const onSilentResult = captured[0].onSilentResult as (text: string) => void
    onSilentResult('garbage with no sections')

    expect(sent).toHaveLength(0)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe('concurrency (default cap = 2)', () => {
  let captured: Array<Record<string, unknown>>
  let resolvers: Array<() => void>

  beforeEach(() => {
    captured = []
    resolvers = []
    chatRunner.__setExecutor((job) => {
      captured.push(job)
      return new Promise<void>((resolve) => { resolvers.push(resolve) })
    })
  })

  // PRD 493: CONCURRENCY_CAP now governs SILENT (automated probe) runs only —
  // these were written under PRD 486 against plain (manual) run() calls, so
  // they're updated to silent:true to keep testing the FIFO lane they target.
  it('runs 2 different silent probes concurrently under the default cap', async () => {
    chatRunner.run({ tabId: 'tab-conc-a', sessionId: 'sess-conc-a', prompt: 'a', cwd: '/tmp', resume: true, silent: true })
    chatRunner.run({ tabId: 'tab-conc-b', sessionId: 'sess-conc-b', prompt: 'b', cwd: '/tmp', resume: true, silent: true })
    await new Promise((r) => setTimeout(r, 0))

    // Both invoked the executor before either resolved.
    expect(captured).toHaveLength(2)
    expect(captured.map((j) => j.tabId)).toEqual(['tab-conc-a', 'tab-conc-b'])

    resolvers.forEach((resolve) => resolve())
    await new Promise((r) => setTimeout(r, 0))
  })

  it('queues a 3rd concurrent silent probe behind the 2 already running', async () => {
    chatRunner.run({ tabId: 'tab-conc-x', sessionId: 'sess-conc-x', prompt: 'x', cwd: '/tmp', resume: true, silent: true })
    chatRunner.run({ tabId: 'tab-conc-y', sessionId: 'sess-conc-y', prompt: 'y', cwd: '/tmp', resume: true, silent: true })
    chatRunner.run({ tabId: 'tab-conc-z', sessionId: 'sess-conc-z', prompt: 'z', cwd: '/tmp', resume: true, silent: true })
    await new Promise((r) => setTimeout(r, 0))

    // Only the first 2 lanes are filled; the 3rd tab is still waiting.
    expect(captured).toHaveLength(2)
    expect(captured.map((j) => j.tabId)).toEqual(['tab-conc-x', 'tab-conc-y'])

    // Freeing a lane lets the 3rd tab start.
    resolvers[0]()
    await new Promise((r) => setTimeout(r, 0))
    expect(captured).toHaveLength(3)
    expect(captured[2].tabId).toBe('tab-conc-z')

    resolvers.slice(1).forEach((resolve) => resolve())
    await new Promise((r) => setTimeout(r, 0))
  })
})

describe('manual runs are uncapped (PRD 493)', () => {
  let captured: Array<Record<string, unknown>>
  let resolvers: Array<() => void>

  beforeEach(() => {
    captured = []
    resolvers = []
    chatRunner.__setExecutor((job) => {
      captured.push(job)
      return new Promise<void>((resolve) => { resolvers.push(resolve) })
    })
  })

  it('two manual runs for different tabs both invoke the executor immediately, even with cap effectively 1', async () => {
    // Two DIFFERENT tabs, both manual (silent unset). If manual runs shared
    // the silent lane's cap, the 2nd would sit in `waiting` until the 1st
    // resolved. It must not.
    chatRunner.run({ tabId: 'tab-manual-a', sessionId: 'sess-manual-a', prompt: 'a', cwd: '/tmp', resume: false })
    chatRunner.run({ tabId: 'tab-manual-b', sessionId: 'sess-manual-b', prompt: 'b', cwd: '/tmp', resume: false })
    await new Promise((r) => setTimeout(r, 0))

    expect(captured).toHaveLength(2)
    expect(captured.map((j) => j.tabId).sort()).toEqual(['tab-manual-a', 'tab-manual-b'])

    resolvers.forEach((resolve) => resolve())
    await new Promise((r) => setTimeout(r, 0))
  })

  it('a manual run does not inflate activeCount / starve a silent probe on another tab', async () => {
    // Fill both silent lanes first.
    chatRunner.run({ tabId: 'tab-sil-x', sessionId: 'sess-sil-x', prompt: '/context', cwd: '/tmp', resume: true, silent: true })
    chatRunner.run({ tabId: 'tab-sil-y', sessionId: 'sess-sil-y', prompt: '/context', cwd: '/tmp', resume: true, silent: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(captured).toHaveLength(2)

    // A burst of manual runs across other tabs must not block/queue a 3rd
    // silent probe waiting behind the 2 already-active silent lanes, nor
    // themselves queue.
    chatRunner.run({ tabId: 'tab-man-1', sessionId: 'sess-man-1', prompt: '1', cwd: '/tmp', resume: false })
    chatRunner.run({ tabId: 'tab-man-2', sessionId: 'sess-man-2', prompt: '2', cwd: '/tmp', resume: false })
    chatRunner.run({ tabId: 'tab-man-3', sessionId: 'sess-man-3', prompt: '3', cwd: '/tmp', resume: false })
    await new Promise((r) => setTimeout(r, 0))

    // All 3 manual runs started immediately (on top of the 2 active silent lanes).
    expect(captured).toHaveLength(5)
    expect(captured.filter((j) => j.tabId?.toString().startsWith('tab-man-'))).toHaveLength(3)

    resolvers.forEach((resolve) => resolve())
    await new Promise((r) => setTimeout(r, 0))
  })
})

describe('per-tab exclusivity across manual + silent tracks (PRD 493)', () => {
  // Uses the REAL executeRun (via the faked spawn/child from the top of this
  // file), because inFlight bookkeeping — which the per-tab guard reads — is
  // only populated by the real executeRun, not the __setExecutor stub.
  beforeEach(() => {
    chatRunner.__setExecutor(null)
    recordExchangeCalls.length = 0
    nextChild = null
  })

  it('a silent probe for a tab already running a manual run is dropped (per-tab guard holds)', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    chatRunner.attachWindow({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    })

    chatRunner.run({ tabId: 'tab-excl', sessionId: 'sess-excl', prompt: 'hello', cwd: '/tmp', resume: false })
    await flush()
    const manualChild = nextChild
    expect(manualChild).not.toBeNull()

    // While the manual run is still active (child hasn't exited), a silent
    // probe for the SAME tab must be dropped, not queued or executed —
    // no new child is spawned.
    nextChild = null
    chatRunner.run({ tabId: 'tab-excl', sessionId: 'sess-excl', prompt: '/context', cwd: '/tmp', resume: true, silent: true })
    await flush()
    expect(nextChild).toBeNull()

    emitResultLine(manualChild!, 'manual result')
    await flush()
    expect(sent.some((e) => e.channel === 'chat:run:complete')).toBe(true)
  })

  it('a manual run for a tab already running a silent probe is dropped (per-tab guard holds)', async () => {
    chatRunner.run({ tabId: 'tab-excl-2', sessionId: 'sess-excl-2', prompt: '/context', cwd: '/tmp', resume: true, silent: true })
    await flush()
    const silentChild = nextChild
    expect(silentChild).not.toBeNull()

    // While the silent probe is still active, a manual run for the SAME tab
    // must be dropped — no new child is spawned.
    nextChild = null
    chatRunner.run({ tabId: 'tab-excl-2', sessionId: 'sess-excl-2', prompt: 'hello', cwd: '/tmp', resume: false })
    await flush()
    expect(nextChild).toBeNull()

    emitResultLine(silentChild!, 'silent result')
    await flush()
  })
})

describe('recordExchange gating (real executeRun path via a faked child process)', () => {
  beforeEach(() => {
    chatRunner.__setExecutor(null) // restore the real executeRun (earlier tests stub it)
    recordExchangeCalls.length = 0
    nextChild = null
  })

  it('skips recordExchange and turn-affecting broadcasts when silent: true', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    chatRunner.attachWindow({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    })

    chatRunner.run({ tabId: 'tab-silent-exec', sessionId: 'sess-silent-exec', prompt: '/context', cwd: '/tmp', resume: true, silent: true })
    await flush()
    expect(nextChild).not.toBeNull()
    emitResultLine(nextChild!, 'silent probe output')
    await flush()

    expect(recordExchangeCalls).toHaveLength(0)
    expect(sent.some((e) => e.channel === 'chat:run:output')).toBe(false)
    expect(sent.some((e) => e.channel === 'chat:run:complete')).toBe(false)
  })

  it('still calls recordExchange and emits turn broadcasts when silent is unset (regression guard)', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    chatRunner.attachWindow({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    })

    chatRunner.run({ tabId: 'tab-visible-exec', sessionId: 'sess-visible-exec', prompt: 'hello', cwd: '/tmp', resume: false })
    await flush()
    expect(nextChild).not.toBeNull()
    emitResultLine(nextChild!, 'visible turn output')
    await flush()

    expect(recordExchangeCalls).toHaveLength(1)
    expect(sent.some((e) => e.channel === 'chat:run:output')).toBe(true)
    expect(sent.some((e) => e.channel === 'chat:run:complete')).toBe(true)
  })
})
