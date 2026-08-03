import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * live.ts's subscribe/unsubscribe is ref-counted so two mounted consumers
 * (e.g. two visible workbench panels reading the same tab's live state,
 * possible since link 3 lets dockview keep multiple panels mounted at
 * once) can share one underlying transcripts subscription without either
 * one's unmount tearing it down under the other. window.api is mocked
 * here since vitest runs this suite in a node environment.
 */

function installWindowApiMock() {
  const onEvent = vi.fn().mockReturnValue(vi.fn())
  const subscribe = vi.fn().mockResolvedValue({ ok: true, path: '/tmp/fake/transcript.jsonl' })
  const buffer = vi.fn().mockResolvedValue([])
  const unsubscribe = vi.fn()
  const api = {
    transcripts: { onEvent, subscribe, buffer, unsubscribe },
  }
  vi.stubGlobal('window', { api })
  return { api, onEvent, subscribe, buffer, unsubscribe }
}

describe('live.ts subscribe/unsubscribe refcounting', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('keeps the tab subscribed while a second consumer is still attached', async () => {
    const { subscribe: apiSubscribe, unsubscribe: apiUnsubscribe } = installWindowApiMock()
    const { useLive } = await import('../live')

    useLive.getState().subscribe('tab-1', '/proj', 'sess-1')
    useLive.getState().subscribe('tab-1', '/proj', 'sess-1')

    expect(useLive.getState().refs['tab-1']).toBe(2)
    expect(useLive.getState().tabs['tab-1']).toBeDefined()
    // Only the first subscribe wires up the underlying IPC subscription.
    expect(apiSubscribe).toHaveBeenCalledTimes(1)

    useLive.getState().unsubscribe('tab-1')

    expect(useLive.getState().refs['tab-1']).toBe(1)
    expect(useLive.getState().tabs['tab-1']).toBeDefined()
    expect(apiUnsubscribe).not.toHaveBeenCalled()

    useLive.getState().unsubscribe('tab-1')

    expect(useLive.getState().refs['tab-1']).toBeUndefined()
    expect(useLive.getState().tabs['tab-1']).toBeUndefined()
    expect(apiUnsubscribe).toHaveBeenCalledWith('tab-1')
  })

  it('unsubscribe on an untracked tabId is a no-op', async () => {
    installWindowApiMock()
    const { useLive } = await import('../live')

    expect(() => useLive.getState().unsubscribe('never-subscribed')).not.toThrow()
    expect(useLive.getState().refs['never-subscribed']).toBeUndefined()
  })
})

/**
 * classifyLine now returns an ARRAY of events per JSONL line (main-process
 * fix), and doFlush/onEvent call ingest() once per emitted event instead of
 * once per line. These tests feed ingest() the exact per-event sequence a
 * multi-block line now produces, proving no field gets double-counted
 * (usage, agents, tool uses) relative to what a single such line represents.
 */
describe('live.ts ingest — multi-event lines from classifyLine do not double-count', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('an assistant line with [text, tool_use, tool_use] records exactly 2 tool uses, not 1 or 3', async () => {
    installWindowApiMock()
    const { useLive } = await import('../live')
    const { classifyLine } = require('../../../main/lib/classifyTranscriptLine.cjs')

    useLive.getState().subscribe('tab-1', '/proj', 'sess-1')

    const line = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'doing two things' },
          { type: 'tool_use', name: 'Bash', id: 'tu-1', input: { command: 'ls' } },
          { type: 'tool_use', name: 'Bash', id: 'tu-2', input: { command: 'pwd' } },
        ],
      },
    }
    const events = classifyLine(line)
    expect(events).toHaveLength(3)
    for (const ev of events) useLive.getState().ingest('tab-1', ev)

    const tab = useLive.getState().tabs['tab-1']
    expect(tab.lastToolUses).toHaveLength(2)
    expect(tab.lastToolUses.map((t: { id?: string }) => t.id).sort()).toEqual(['tu-1', 'tu-2'])
  })

  it('a line carrying both usage and content adds usage tokens exactly once', async () => {
    installWindowApiMock()
    const { useLive } = await import('../live')
    const { classifyLine } = require('../../../main/lib/classifyTranscriptLine.cjs')

    useLive.getState().subscribe('tab-1', '/proj', 'sess-1')

    const line = {
      type: 'assistant',
      usage: { input_tokens: 100, output_tokens: 40 },
      message: {
        content: [{ type: 'text', text: 'hello' }],
      },
    }
    const events = classifyLine(line)
    // usage event + text event — both must survive, and usage must be added once.
    expect(events.filter((e: { kind: string }) => e.kind === 'usage')).toHaveLength(1)
    for (const ev of events) useLive.getState().ingest('tab-1', ev)

    const tab = useLive.getState().tabs['tab-1']
    expect(tab.usage).toEqual({ inputTokens: 100, outputTokens: 40, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 })
  })

  it('two distinct agent_spawn + tool_result blocks in one line settle each agent independently, not double-counted', async () => {
    installWindowApiMock()
    const { useLive } = await import('../live')
    const { classifyLine } = require('../../../main/lib/classifyTranscriptLine.cjs')

    useLive.getState().subscribe('tab-1', '/proj', 'sess-1')

    const spawnLine = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Task', id: 'agent-1', input: { description: 'first' } },
          { type: 'tool_use', name: 'Task', id: 'agent-2', input: { description: 'second' } },
        ],
      },
    }
    for (const ev of classifyLine(spawnLine)) useLive.getState().ingest('tab-1', ev)
    expect(useLive.getState().tabs['tab-1'].agents).toHaveLength(2)

    const resultLine = {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'agent-1' },
          { type: 'tool_result', tool_use_id: 'agent-2' },
        ],
      },
    }
    const before = useLive.getState().tabs['tab-1'].agents.map((a: { id?: string; lastActivityAt: number }) => a.lastActivityAt)
    for (const ev of classifyLine(resultLine)) useLive.getState().ingest('tab-1', ev)
    const after = useLive.getState().tabs['tab-1'].agents
    expect(after).toHaveLength(2)
    // Both agents settled (activity touched), each exactly once.
    expect(after.every((a: { lastActivityAt: number }, i: number) => a.lastActivityAt >= before[i])).toBe(true)
  })
})
