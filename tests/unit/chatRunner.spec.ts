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

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))

const require = createRequire(import.meta.url)
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

// NOTE: this repo has no existing convention for mocking `node:child_process` spawn
// inside a `.cjs` module (no spec in tests/unit/ uses vi.mock against a scheduler-
// or chatRunner-style spawn call — they all test pure/exported helpers or use the
// __setExecutor-style seam). chatRunner.cjs's real `executeRun` (the default
// executor, only bypassed above via __setExecutor) is not exported, so this spec
// cannot drive its real stream-parsing/broadcast/recordExchange logic without a
// live child process. The `if (!silent)` guards on chat:run:started/output/tool-use
// and the `emitTerminal`-based skip of chat:run:complete/needs-input/error plus the
// recordExchange skip (chatRunner.cjs's executeRun, silent branch) are exercised by
// code inspection + the tests above (which cover the full silent flag path through
// run/waiting/executor and the onSilentResult parse+broadcast wiring) rather than by
// a full spawn-driven integration test.
