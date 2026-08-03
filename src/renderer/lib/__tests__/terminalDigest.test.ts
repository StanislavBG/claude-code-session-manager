import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildTranscriptDigest, fetchTerminalDigest } from '../terminalDigest'

// Matches the shape classifyLine (main-process) actually emits for a text
// content block: kind is the message's own role, data is the block's plain
// text string — see src/main/lib/classifyTranscriptLine.cjs's classifyBlock.
function userEvent(text: string) {
  return { kind: 'user', data: text, raw: '', previewText: '', ref: null }
}
function assistantEvent(text: string) {
  return { kind: 'assistant', data: text, raw: '', previewText: '', ref: null }
}

describe('buildTranscriptDigest', () => {
  it('returns null for an empty event list', () => {
    expect(buildTranscriptDigest([])).toBeNull()
  })

  it('returns null when there are no message-kind events with text', () => {
    const events = [{ kind: 'tool_use', data: { name: 'Bash', input: {}, id: '1' }, raw: '', previewText: '', ref: null }]
    expect(buildTranscriptDigest(events)).toBeNull()
  })

  it('joins user + assistant text turns with dim ANSI styling', () => {
    const events = [userEvent('hello'), assistantEvent('hi there')]
    const digest = buildTranscriptDigest(events)
    expect(digest).toContain('[You] hello')
    expect(digest).toContain('[Claude] hi there')
    expect(digest).toContain('prior conversation')
    expect(digest).toMatch(/^\x1b\[38;5;240m/)
  })

  it('strips embedded ANSI escape sequences from replayed text', () => {
    const malicious = '\x1b]0;pwned\x07hello\x1b[2J\x1b[31mworld'
    const events = [userEvent(malicious)]
    const digest = buildTranscriptDigest(events)
    expect(digest).toContain('helloworld')
    expect(digest).not.toContain('\x1b]0;pwned')
    expect(digest).not.toContain('\x1b[2J')
    expect(digest).not.toContain('\x1b[31m')
  })

  it('skips tool-only turns that have no text blocks', () => {
    const toolOnly = { kind: 'tool_use', data: { name: 'Bash', input: {}, id: '2' }, raw: '', previewText: '', ref: null }
    const events = [userEvent('run ls'), toolOnly]
    const digest = buildTranscriptDigest(events)
    expect(digest).toContain('[You] run ls')
    expect(digest).not.toContain('tool_use')
  })

  it('integrates with the real classifyLine output for a mixed assistant turn', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { classifyLine } = require('../../../main/lib/classifyTranscriptLine.cjs')
    const events = classifyLine({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'running the tests now' },
          { type: 'tool_use', name: 'Bash', id: 'tu-1', input: { command: 'npm test' } },
        ],
      },
    })
    const digest = buildTranscriptDigest(events)
    expect(digest).toContain('[Claude] running the tests now')
  })
})

describe('fetchTerminalDigest', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves null when subscribe fails', async () => {
    vi.stubGlobal('window', {
      api: {
        transcripts: {
          subscribe: vi.fn().mockResolvedValue({ ok: false, path: null, error: 'boom' }),
          buffer: vi.fn(),
        },
      },
    })
    const digest = await fetchTerminalDigest({ tabId: 'tab-1', cwd: '/proj' })
    expect(digest).toBeNull()
  })

  it('resolves null for a brand-new tab with an empty buffer', async () => {
    vi.stubGlobal('window', {
      api: {
        transcripts: {
          subscribe: vi.fn().mockResolvedValue({ ok: true, path: '/tmp/fake.jsonl' }),
          buffer: vi.fn().mockResolvedValue([]),
        },
      },
    })
    const digest = await fetchTerminalDigest({ tabId: 'tab-2', cwd: '/proj' })
    expect(digest).toBeNull()
  })

  it('resolves null when subscribe rejects, without throwing', async () => {
    vi.stubGlobal('window', {
      api: {
        transcripts: {
          subscribe: vi.fn().mockRejectedValue(new Error('ipc down')),
          buffer: vi.fn(),
        },
      },
    })
    await expect(fetchTerminalDigest({ tabId: 'tab-3', cwd: '/proj' })).resolves.toBeNull()
  })

  it('builds a digest from a populated buffer', async () => {
    vi.stubGlobal('window', {
      api: {
        transcripts: {
          subscribe: vi.fn().mockResolvedValue({ ok: true, path: '/tmp/fake.jsonl' }),
          buffer: vi.fn().mockResolvedValue([userEvent('hello'), assistantEvent('hi there')]),
        },
      },
    })
    const digest = await fetchTerminalDigest({ tabId: 'tab-4', cwd: '/proj' })
    expect(digest).toContain('[You] hello')
    expect(digest).toContain('[Claude] hi there')
  })
})
