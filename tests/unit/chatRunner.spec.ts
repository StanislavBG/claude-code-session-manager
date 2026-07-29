/**
 * Unit tests for chatRunner.cjs (PRD 470): the silent `/context` probe.
 *
 * `vi.mock('electron', ...)` is set up per the PRD spec even though chatRunner.cjs's
 * top-level `require('electron')` is harmless outside a real Electron process (the
 * `electron` npm package resolves to a path string, so destructuring `ipcMain` off it
 * is simply `undefined` unless `registerChatHandlers()` is actually invoked) — this
 * spec never calls `registerChatHandlers()`, so the mock is defensive, not load-bearing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))

// chatRunner.cjs reads SM_CHAT_CONCURRENCY lazily (per pump() call), not at
// module-load time, so deleting it here — before every test, restoring after
// — is enough to make the "default cap = 2" assertions deterministic on any
// machine whose shell exports SM_CHAT_CONCURRENCY (e.g. the dev's ~/.bashrc
// sets 3). No vi.resetModules() / dynamic import needed.
const ORIGINAL_SM_CHAT_CONCURRENCY = process.env.SM_CHAT_CONCURRENCY
beforeEach(() => {
  delete process.env.SM_CHAT_CONCURRENCY
})
afterEach(() => {
  if (ORIGINAL_SM_CHAT_CONCURRENCY === undefined) delete process.env.SM_CHAT_CONCURRENCY
  else process.env.SM_CHAT_CONCURRENCY = ORIGINAL_SM_CHAT_CONCURRENCY
})

const require = createRequire(import.meta.url)

// This repo's .cjs main-process specs load their target module via createRequire,
// which bypasses vitest's vi.mock transform pipeline. Patching the shared
// node:child_process / exchanges.cjs exports in place (before chatRunner.cjs's own
// require() destructures them) is the pattern that actually reaches chatRunner.cjs.
const cp = require('node:child_process') as { spawn: (...args: unknown[]) => unknown }
type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number; kill: (sig?: string) => void }
let nextChild: FakeChild | null = null
let lastSpawnArgs: string[] | null = null
cp.spawn = (...spawnCallArgs: unknown[]) => {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 12345
  child.kill = () => {}
  nextChild = child
  lastSpawnArgs = spawnCallArgs[1] as string[]
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
  parseStopSignal: (text: string) => { questions: string[] } | null
  splitStopSignal: (text: string) => { answerBody: string; questions: string[] } | null
  STOP_SENTINEL: string
  CHAT_MODE_TRUTH_INSTRUCTION: string
  enqueueExternalPrompt: (tabId: string, prompt: string) => void
  registerAdminRoute: (adminHttp: { registerRoute: (method: string, url: string, handler: (req: unknown, res: unknown) => Promise<void>) => void }) => void
}

function emitResultLine(child: FakeChild, resultText: string) {
  const assistantLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: resultText }] } })
  const resultLine = JSON.stringify({ type: 'result', subtype: 'success', result: resultText })
  child.stdout.emit('data', Buffer.from(`${assistantLine}\n${resultLine}\n`))
  // executeRun's settle() runs off 'close' (not 'exit') — see the comment at
  // its listener in chatRunner.cjs. Emitting 'exit' here left activeCount
  // never decremented once manual runs started sharing the FIFO lane's
  // activeCount bookkeeping, silently starving every later real-executeRun
  // test in this file.
  child.emit('close', 0, null)
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

  it('SM_CHAT_CONCURRENCY=1 clamps the silent lane to 1 (override still works)', async () => {
    process.env.SM_CHAT_CONCURRENCY = '1'

    chatRunner.run({ tabId: 'tab-conc-cap1-a', sessionId: 'sess-conc-cap1-a', prompt: 'a', cwd: '/tmp', resume: true, silent: true })
    chatRunner.run({ tabId: 'tab-conc-cap1-b', sessionId: 'sess-conc-cap1-b', prompt: 'b', cwd: '/tmp', resume: true, silent: true })
    await new Promise((r) => setTimeout(r, 0))

    // Only the 1st lane is filled; the 2nd silent probe queues behind it.
    expect(captured).toHaveLength(1)
    expect(captured[0].tabId).toBe('tab-conc-cap1-a')

    resolvers[0]()
    await new Promise((r) => setTimeout(r, 0))
    expect(captured).toHaveLength(2)
    expect(captured[1].tabId).toBe('tab-conc-cap1-b')

    resolvers.slice(1).forEach((resolve) => resolve())
    await new Promise((r) => setTimeout(r, 0))
  })
})

describe('manual runs share the FIFO lane with silent runs', () => {
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

  it('two manual runs for different tabs both invoke the executor immediately under the default cap of 2', async () => {
    chatRunner.run({ tabId: 'tab-manual-a', sessionId: 'sess-manual-a', prompt: 'a', cwd: '/tmp', resume: false })
    chatRunner.run({ tabId: 'tab-manual-b', sessionId: 'sess-manual-b', prompt: 'b', cwd: '/tmp', resume: false })
    await new Promise((r) => setTimeout(r, 0))

    expect(captured).toHaveLength(2)
    expect(captured.map((j) => j.tabId).sort()).toEqual(['tab-manual-a', 'tab-manual-b'])

    resolvers.forEach((resolve) => resolve())
    await new Promise((r) => setTimeout(r, 0))
  })

  it('a manual run queues behind an already-full lane shared with silent probes', async () => {
    // Fill both lanes with silent probes first.
    chatRunner.run({ tabId: 'tab-sil-x', sessionId: 'sess-sil-x', prompt: '/context', cwd: '/tmp', resume: true, silent: true })
    chatRunner.run({ tabId: 'tab-sil-y', sessionId: 'sess-sil-y', prompt: '/context', cwd: '/tmp', resume: true, silent: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(captured).toHaveLength(2)

    // A manual run on a 3rd tab must queue behind the 2 already-active lanes
    // (shared cap), not execute immediately.
    chatRunner.run({ tabId: 'tab-man-1', sessionId: 'sess-man-1', prompt: '1', cwd: '/tmp', resume: false })
    await new Promise((r) => setTimeout(r, 0))
    expect(captured).toHaveLength(2)

    // Freeing a lane lets the queued manual run start.
    resolvers[0]()
    await new Promise((r) => setTimeout(r, 0))
    expect(captured).toHaveLength(3)
    expect(captured[2].tabId).toBe('tab-man-1')

    resolvers.slice(1).forEach((resolve) => resolve())
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

describe('prompt-prepended instructions (real executeRun path via a faked child process)', () => {
  beforeEach(() => {
    chatRunner.__setExecutor(null) // restore the real executeRun (earlier tests stub it)
    nextChild = null
    lastSpawnArgs = null
  })

  it('prepends both STOP_SIGNAL_INSTRUCTION and CHAT_MODE_TRUTH_INSTRUCTION to the -p argv value', async () => {
    chatRunner.run({ tabId: 'tab-truth', sessionId: 'sess-truth', prompt: 'hello', cwd: '/tmp', resume: false })
    await flush()
    expect(nextChild).not.toBeNull()
    expect(lastSpawnArgs).not.toBeNull()

    const pIndex = lastSpawnArgs!.indexOf('-p')
    expect(pIndex).toBeGreaterThanOrEqual(0)
    const fullPrompt = lastSpawnArgs![pIndex + 1]

    expect(fullPrompt).toContain(chatRunner.STOP_SENTINEL)
    expect(fullPrompt).toContain(chatRunner.CHAT_MODE_TRUTH_INSTRUCTION)
    expect(fullPrompt.indexOf(chatRunner.CHAT_MODE_TRUTH_INSTRUCTION)).toBeLessThan(fullPrompt.indexOf('hello'))
    expect(fullPrompt).toMatch(/one-shot|no process (survives|resumes)/i)
    expect(fullPrompt.endsWith('hello')).toBe(true)
  })
})

describe('splitStopSignal', () => {
  const SENTINEL = chatRunner.STOP_SENTINEL

  it('splits body and questions when the sentinel is present', () => {
    const text = `Here are the five steps:\n1. one\n2. two\n\n${SENTINEL}\n{"questions":["Which env?"]}`
    const result = chatRunner.splitStopSignal(text)
    expect(result).toEqual({ answerBody: 'Here are the five steps:\n1. one\n2. two', questions: ['Which env?'] })
  })

  it('returns an empty answerBody when the sentinel is the entire reply', () => {
    const text = `${SENTINEL}\n{"questions":["What next?"]}`
    const result = chatRunner.splitStopSignal(text)
    expect(result).toEqual({ answerBody: '', questions: ['What next?'] })
  })

  it('uses the LAST sentinel occurrence when an earlier literal sentinel string appears in the body', () => {
    const text = `The sentinel is literally ${SENTINEL} in my explanation.\n\n${SENTINEL}\n{"questions":["Continue?"]}`
    const result = chatRunner.splitStopSignal(text)
    expect(result?.answerBody).toBe(`The sentinel is literally ${SENTINEL} in my explanation.`)
    expect(result?.questions).toEqual(['Continue?'])
  })

  it('supports multiple questions', () => {
    const text = `Findings here.\n\n${SENTINEL}\n{"questions":["Q1?","Q2?","Q3?"]}`
    const result = chatRunner.splitStopSignal(text)
    expect(result?.questions).toEqual(['Q1?', 'Q2?', 'Q3?'])
  })

  it('returns null (treated as complete) when the JSON after the sentinel is malformed', () => {
    const text = `Some output.\n\n${SENTINEL}\nnot json at all`
    expect(chatRunner.splitStopSignal(text)).toBeNull()
  })

  it('returns null when the sentinel is absent', () => {
    expect(chatRunner.splitStopSignal('just a normal completed reply')).toBeNull()
  })

  it('parseStopSignal stays a thin wrapper returning only questions', () => {
    const text = `Body text.\n\n${SENTINEL}\n{"questions":["Q?"]}`
    expect(chatRunner.parseStopSignal(text)).toEqual({ questions: ['Q?'] })
  })
})

describe('needs-input payload (real executeRun path via a faked child process)', () => {
  beforeEach(() => {
    chatRunner.__setExecutor(null)
    recordExchangeCalls.length = 0
    nextChild = null
  })

  it('emits answerBody on chat:run:needs-input and records it durably', async () => {
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
    chatRunner.attachWindow({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (channel: string, payload: Record<string, unknown>) => sent.push({ channel, payload }) },
    })

    chatRunner.run({ tabId: 'tab-needs-input', sessionId: 'sess-needs-input', prompt: 'describe the five steps', cwd: '/tmp', resume: false })
    await flush()
    expect(nextChild).not.toBeNull()

    const finalText = `1. one\n2. two\n3. three\n4. four\n5. five\n\n${chatRunner.STOP_SENTINEL}\n{"questions":["Proceed with step 6?"]}`
    emitResultLine(nextChild!, finalText)
    await flush()

    const needsInput = sent.find((e) => e.channel === 'chat:run:needs-input')
    expect(needsInput).toBeTruthy()
    expect(needsInput?.payload.answerBody).toBe('1. one\n2. two\n3. three\n4. four\n5. five')
    expect(needsInput?.payload.questions).toEqual(['Proceed with step 6?'])
    expect(needsInput?.payload.raw).toBe(finalText)

    expect(recordExchangeCalls).toHaveLength(1)
    const [call] = recordExchangeCalls
    const opts = call[0] as { result: string }
    expect(opts.result).toContain('1. one\n2. two\n3. three\n4. four\n5. five')
    expect(opts.result).toContain('[asked: Proceed with step 6?]')
  })
})

describe('enqueueExternalPrompt (PRD 753)', () => {
  it('broadcasts chat:external-send with the given tabId + prompt to the attached window', () => {
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
    chatRunner.attachWindow({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (channel: string, payload: Record<string, unknown>) => sent.push({ channel, payload }) },
    })

    chatRunner.enqueueExternalPrompt('tab-external', 'hello from outside')

    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({
      channel: 'chat:external-send',
      payload: { tabId: 'tab-external', prompt: 'hello from outside' },
    })
  })

  it('is a no-op when no window is attached', () => {
    chatRunner.attachWindow(null)
    expect(() => chatRunner.enqueueExternalPrompt('tab-x', 'hi')).not.toThrow()
  })
})

describe('registerAdminRoute (PRD 753)', () => {
  function fakeReqRes(body: string) {
    const { EventEmitter: EE } = require('node:events')
    const req = new EE()
    setTimeout(() => {
      req.emit('data', Buffer.from(body))
      req.emit('end')
    }, 0)
    const res: { statusCode: number | null; body: string | null; writeHead: (s: number) => void; end: (b?: string) => void } = {
      statusCode: null,
      body: null,
      writeHead(status: number) { res.statusCode = status },
      end(b?: string) { res.body = b ?? null },
    }
    return { req, res }
  }

  it('registers POST /admin/chat/send-prompt and calls enqueueExternalPrompt on a valid body', async () => {
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
    chatRunner.attachWindow({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (channel: string, payload: Record<string, unknown>) => sent.push({ channel, payload }) },
    })

    const routes = new Map<string, (req: unknown, res: unknown) => Promise<void>>()
    chatRunner.registerAdminRoute({
      registerRoute: (method, url, handler) => routes.set(`${method} ${url}`, handler),
    })

    const handler = routes.get('POST /admin/chat/send-prompt')
    expect(handler).toBeTruthy()

    const { req, res } = fakeReqRes(JSON.stringify({ tabId: 'tab-admin', prompt: 'hi from admin route' }))
    await handler!(req, res)

    expect(sent).toEqual([
      { channel: 'chat:external-send', payload: { tabId: 'tab-admin', prompt: 'hi from admin route' } },
    ])
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body!)).toEqual({ ok: true })
  })

  it('responds 400 on an invalid body and does not enqueue anything', async () => {
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
    chatRunner.attachWindow({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (channel: string, payload: Record<string, unknown>) => sent.push({ channel, payload }) },
    })

    const routes = new Map<string, (req: unknown, res: unknown) => Promise<void>>()
    chatRunner.registerAdminRoute({
      registerRoute: (method, url, handler) => routes.set(`${method} ${url}`, handler),
    })
    const handler = routes.get('POST /admin/chat/send-prompt')!

    const { req, res } = fakeReqRes(JSON.stringify({ tabId: '' }))
    await handler(req, res)

    expect(sent).toHaveLength(0)
    expect(res.statusCode).toBe(400)
  })
})
