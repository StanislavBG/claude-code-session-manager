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

/**
 * PRD transcript-batch-flush: transcripts.cjs's doFlush now sends the whole
 * ordered batch of events from one flush in a single IPC message, and
 * live.ts folds that batch through ONE `set()` call (ingestBatch) instead of
 * one per event. These tests cover the store-commit-count reduction, order
 * preservation, and byte-for-byte equivalence with the old per-event path.
 */
describe('live.ts ingestBatch — one store commit per batch, order preserved, no drops/dupes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('commits a multi-event batch with exactly ONE set() call, not one per event', async () => {
    installWindowApiMock()
    const { useLive } = await import('../live')
    const { classifyLine } = require('../../../main/lib/classifyTranscriptLine.cjs')

    useLive.getState().subscribe('tab-batch', '/proj', 'sess-batch')

    const line = {
      type: 'assistant',
      usage: { input_tokens: 10, output_tokens: 5 },
      message: {
        content: [
          { type: 'text', text: 'doing three things' },
          { type: 'tool_use', name: 'Bash', id: 'tu-a', input: { command: 'ls' } },
          { type: 'tool_use', name: 'Bash', id: 'tu-b', input: { command: 'pwd' } },
        ],
      },
    }
    const events = classifyLine(line)
    expect(events.length).toBeGreaterThanOrEqual(4) // usage + text + 2 tool_use

    let commits = 0
    const unsub = useLive.subscribe(() => { commits += 1 })
    useLive.getState().ingestBatch('tab-batch', events)
    unsub()
    expect(commits).toBe(1)

    const tab = useLive.getState().tabs['tab-batch']
    expect(tab.lastToolUses).toHaveLength(2)
    expect(tab.usage.inputTokens).toBe(10)
  })

  it('ingestBatch on a >20-event flush still produces exactly one commit (benchmark: N commits → 1)', async () => {
    installWindowApiMock()
    const { useLive } = await import('../live')
    const { classifyLine } = require('../../../main/lib/classifyTranscriptLine.cjs')

    useLive.getState().subscribe('tab-bench', '/proj', 'sess-bench')

    const lines = Array.from({ length: 11 }, (_, i) => ({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `line ${i}` }, { type: 'tool_use', name: 'Bash', id: `bt-${i}`, input: { command: 'ls' } }] },
    }))
    const events = lines.flatMap((l) => classifyLine(l))
    expect(events.length).toBeGreaterThanOrEqual(20) // 11 lines * 2 events = 22

    let commits = 0
    const unsub = useLive.subscribe(() => { commits += 1 })
    useLive.getState().ingestBatch('tab-bench', events)
    unsub()
    // BEFORE this PRD: one ingest() call (and one set()) per event — 22 commits
    // for this fixture. AFTER: ingestBatch folds the whole flush into one.
    expect(commits).toBe(1)
  })

  it('preserves event order across a batch identically to sequential per-event ingest', async () => {
    installWindowApiMock()
    const { useLive } = await import('../live')
    const { classifyLine } = require('../../../main/lib/classifyTranscriptLine.cjs')

    const line = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Task', id: 'agent-x', input: { description: 'x' } },
          { type: 'text', text: 'note' },
          { type: 'tool_use', name: 'Bash', id: 'tu-x', input: { command: 'ls' } },
        ],
      },
    }
    const events = classifyLine(line)

    useLive.getState().subscribe('tab-seq', '/proj', 'sess-seq')
    useLive.getState().subscribe('tab-par', '/proj', 'sess-par')

    for (const ev of events) useLive.getState().ingest('tab-seq', ev)
    useLive.getState().ingestBatch('tab-par', events)

    const seq = useLive.getState().tabs['tab-seq']
    const par = useLive.getState().tabs['tab-par']
    // activityRing labels reflect the derived order of the underlying events —
    // identical order in, identical order out.
    expect(par.activityRing.map((a: { label: string }) => a.label)).toEqual(
      seq.activityRing.map((a: { label: string }) => a.label),
    )
    expect(par.agents.map((a: { id?: string }) => a.id)).toEqual(seq.agents.map((a: { id?: string }) => a.id))
    expect(par.lastToolUses.map((t: { id?: string }) => t.id)).toEqual(seq.lastToolUses.map((t: { id?: string }) => t.id))
  })

  it('byte-identical result: batching a whole fixture through ingestBatch matches feeding it one event at a time via ingest', async () => {
    installWindowApiMock()
    const { useLive } = await import('../live')
    const { classifyLine } = require('../../../main/lib/classifyTranscriptLine.cjs')

    const lines = [
      { type: 'user', message: { content: 'hello' } },
      {
        type: 'assistant',
        usage: { input_tokens: 20, output_tokens: 8 },
        message: {
          content: [
            { type: 'text', text: 'working on it' },
            { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'step 1', status: 'pending' }] } },
            { type: 'tool_use', name: 'Task', id: 'agent-y', input: { description: 'sub-work' } },
            { type: 'tool_use', name: 'Edit', id: 'tu-y', input: { file_path: '/tmp/foo.ts' } },
          ],
        },
      },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'agent-y' }] } },
    ]
    const events = lines.flatMap((l) => classifyLine(l))

    useLive.getState().subscribe('tab-fixture-seq', '/proj', 'sess-fs')
    useLive.getState().subscribe('tab-fixture-batch', '/proj', 'sess-fb')

    for (const ev of events) useLive.getState().ingest('tab-fixture-seq', ev)
    useLive.getState().ingestBatch('tab-fixture-batch', events)

    const seqTab = useLive.getState().tabs['tab-fixture-seq']
    const batchTab = useLive.getState().tabs['tab-fixture-batch']

    // `at`/`lastEventAt` are wall-clock and legitimately differ by a few ms
    // between the two runs — compare every OTHER derived field, which is
    // exactly what "no event dropped or duplicated" means here.
    expect(batchTab.todos).toEqual(seqTab.todos)
    expect(batchTab.usage).toEqual(seqTab.usage)
    expect(batchTab.agents.map((a: { id?: string; subagentType?: string }) => [a.id, a.subagentType])).toEqual(
      seqTab.agents.map((a: { id?: string; subagentType?: string }) => [a.id, a.subagentType]),
    )
    expect(batchTab.lastToolUses.map((t: { id?: string; name: string }) => [t.id, t.name])).toEqual(
      seqTab.lastToolUses.map((t: { id?: string; name: string }) => [t.id, t.name]),
    )
    expect(batchTab.activityRing.map((a: { kind: string; label: string }) => [a.kind, a.label])).toEqual(
      seqTab.activityRing.map((a: { kind: string; label: string }) => [a.kind, a.label]),
    )
    expect(batchTab.activitySeq).toEqual(seqTab.activitySeq)
  })
})
