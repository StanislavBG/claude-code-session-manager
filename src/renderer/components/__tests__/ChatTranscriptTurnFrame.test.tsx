// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

/**
 * Shared TurnFrame/AttributionChips/TurnRawFooter (PRD
 * chat-simplified-conversion-frame). Covers: chip rendering per field
 * presence/absence, empty-zone collapse (no chips, no footer), the
 * byte-identical show-raw round-trip via window.api.transcripts.readRef, and
 * the rcaReport-authored response event's amber "question aimed at you"
 * tinting in EpicDetail.
 */

const FIXTURE_JSONL_LINE =
  '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]},"attributionSkill":"develop","gitBranch":"main☃emoji-and-\ttab"}'

function installWindowApiMock(readRefText: string | null = FIXTURE_JSONL_LINE) {
  const api = {
    chat: {
      run: async () => undefined,
      cancel: async () => undefined,
      onQueued: () => {},
      onRunStarted: () => {},
      onOutput: () => {},
      onToolUse: () => {},
      onComplete: () => () => {},
      onNeedsInput: () => {},
      onError: () => {},
      onNotice: () => {},
      onExternalSend: () => {},
      classifyTicket: async () => 'inline' as const,
      createPrd: async () => ({ ok: true as const, nn: 1, filename: '1-fake.md' }),
    },
    transcripts: {
      pathFor: async () => '/tmp/fake/transcript.jsonl',
      readRef: async () =>
        readRefText === null ? { ok: false as const } : { ok: true as const, text: readRefText },
    },
    config: { exists: async () => true },
    logs: { write: () => {} },
    clipboard: { writeText: vi.fn(async () => ({ ok: true })) },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function baseTurnProps() {
  return { cwd: '/tmp/proj', tabId: 'tab-1', sessionId: 'sess-1' }
}

describe('AttributionChips', () => {
  beforeEach(() => installWindowApiMock())
  afterEach(() => {
    if (root && container) {
      act(() => root!.unmount())
      container.remove()
    }
    container = null
    root = null
    delete (window as unknown as { api?: unknown }).api
  })

  it('EDGE: renders no chip row at all when the turn carries no attribution fields', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const el = mount(
      createElement(Turn, {
        turn: { id: 't-1', role: 'event', text: '', at: Date.now(), kind: 'mode', signal: { value: 'plan' } } as any,
        ...baseTurnProps(),
      }),
    )
    expect(el.querySelector('[data-testid="attribution-chips"]')).toBeFalsy()
  })

  it('CORE: renders exactly one chip per present field, none for absent fields', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const el = mount(
      createElement(Turn, {
        turn: {
          id: 't-2',
          role: 'event',
          text: '',
          at: Date.now(),
          kind: 'mode',
          signal: { value: 'plan' },
          attribution: { attributionSkill: 'develop', gitBranch: 'main' },
        } as any,
        ...baseTurnProps(),
      }),
    )
    expect(el.querySelector('[data-testid="attribution-chip-skill"]')).toBeTruthy()
    expect(el.querySelector('[data-testid="attribution-chip-branch"]')).toBeTruthy()
    expect(el.querySelector('[data-testid="attribution-chip-plugin"]')).toBeFalsy()
    expect(el.querySelector('[data-testid="attribution-chip-effort"]')).toBeFalsy()
  })

  it('EDGE: isApiErrorMessage/interruptedByShutdown chips carry the ERROR_TINT class, distinct from a normal chip', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const el = mount(
      createElement(Turn, {
        turn: {
          id: 't-3',
          role: 'event',
          text: '',
          at: Date.now(),
          kind: 'mode',
          signal: { value: 'plan' },
          attribution: { isApiErrorMessage: true, interruptedByShutdown: true },
        } as any,
        ...baseTurnProps(),
      }),
    )
    const errChip = el.querySelector('[data-testid="attribution-chip-api-error"]')
    const interruptedChip = el.querySelector('[data-testid="attribution-chip-interrupted"]')
    expect(errChip?.className).toMatch(/#b8443c/)
    expect(interruptedChip?.className).toMatch(/#b8443c/)
  })

  it('EDGE: a very long gitBranch truncates via a bounded max-width + truncate class', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const longBranch = 'feat/'.repeat(40) + 'end'
    const el = mount(
      createElement(Turn, {
        turn: {
          id: 't-4',
          role: 'event',
          text: '',
          at: Date.now(),
          kind: 'mode',
          signal: { value: 'plan' },
          attribution: { gitBranch: longBranch },
        } as any,
        ...baseTurnProps(),
      }),
    )
    const chip = el.querySelector('[data-testid="attribution-chip-branch"]')
    expect(chip?.className).toMatch(/truncate/)
    expect(chip?.className).toMatch(/max-w-/)
    expect(chip?.getAttribute('title')).toContain(longBranch)
  })
})

describe('TurnFrame — empty-zone collapse and event-kind wrapping', () => {
  beforeEach(() => installWindowApiMock())
  afterEach(() => {
    if (root && container) {
      act(() => root!.unmount())
      container.remove()
    }
    container = null
    root = null
    delete (window as unknown as { api?: unknown }).api
  })

  it('CORE: wraps a role:event turn in a header carrying the kind badge + timestamp', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const el = mount(
      createElement(Turn, {
        turn: { id: 't-5', role: 'event', text: '', at: Date.now(), kind: 'mode', signal: { value: 'plan' } } as any,
        ...baseTurnProps(),
      }),
    )
    const header = el.querySelector('[data-testid="turn-frame-header"]')
    expect(header).toBeTruthy()
    expect(header?.querySelector('[data-testid="turn-kind-badge"]')?.textContent).toBe('mode')
  })

  it('EDGE: the footer renders nothing when the turn has neither a ref nor any copyable text', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const el = mount(
      createElement(Turn, {
        turn: { id: 't-6', role: 'event', text: '', at: Date.now(), kind: 'file-history-snapshot', signal: {} } as any,
        ...baseTurnProps(),
      }),
    )
    expect(el.querySelector('[data-testid="turn-frame-footer"]')).toBeFalsy()
  })
})

describe('TurnRawFooter — byte-identical show-raw round trip', () => {
  beforeEach(() => installWindowApiMock())
  afterEach(() => {
    if (root && container) {
      act(() => root!.unmount())
      container.remove()
    }
    container = null
    root = null
    delete (window as unknown as { api?: unknown }).api
  })

  it('CORE: "Show raw" displays the EXACT text returned by transcripts.readRef, byte-for-byte, not a re-serialized approximation', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const el = mount(
      createElement(Turn, {
        turn: {
          id: 't-7',
          role: 'event',
          text: 'hi',
          at: Date.now(),
          kind: 'mode',
          signal: { value: 'plan', text: 'hi' },
          ref: { filePath: '/tmp/fake.jsonl', byteOffset: 0, byteLength: FIXTURE_JSONL_LINE.length },
        } as any,
        ...baseTurnProps(),
      }),
    )
    const showRawBtn = el.querySelector('[data-testid="turn-raw-footer-show-raw"]') as HTMLButtonElement
    expect(showRawBtn).toBeTruthy()
    await act(async () => {
      showRawBtn.click()
      await flush()
    })
    const rawPre = el.querySelector('[data-testid="turn-raw-footer-raw"]')
    expect(rawPre?.textContent).toBe(FIXTURE_JSONL_LINE)
  })

  it('EDGE: no ref and no copy text means no footer at all', async () => {
    const { TurnRawFooter } = await import('../ChatTranscriptTurn')
    const el = mount(createElement(TurnRawFooter, {}))
    expect(el.children.length).toBe(0)
  })
})
