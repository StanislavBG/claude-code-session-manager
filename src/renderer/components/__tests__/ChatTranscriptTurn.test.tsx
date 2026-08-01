// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

/**
 * ChatTranscriptTurn's consent-notice 'Retry' button (PRD
 * 901-inline-consent-retry-wiring) — once InlineConsentTerminal's onGranted
 * fires, the collapsed notice card should offer to resend the exact prompt
 * that triggered the MCP consent denial, using the same turns-array data the
 * caller already has (passed in as `precedingUserPrompt`), never a guess.
 *
 * InlineConsentTerminal itself needs a real PTY/xterm mount (see
 * InlineConsentTerminal.test.tsx) — irrelevant here, so it's stubbed with a
 * button that fires onGranted synchronously, mirroring the real widget
 * detecting the CLI's success phrasing.
 */

vi.mock('../InlineConsentTerminal', () => ({
  InlineConsentTerminal: ({ onGranted }: { onGranted: () => void }) =>
    createElement('button', { 'data-testid': 'fake-consent-granted', onClick: onGranted }, 'simulate granted'),
}))

function installWindowApiMock() {
  const run = vi.fn().mockResolvedValue(undefined)
  const cancel = vi.fn().mockResolvedValue(undefined)
  const api = {
    chat: {
      run,
      cancel,
      onQueued: vi.fn(),
      onRunStarted: vi.fn(),
      onOutput: vi.fn(),
      onToolUse: vi.fn(),
      onComplete: vi.fn(() => () => {}),
      onNeedsInput: vi.fn(),
      onError: vi.fn(),
      onNotice: vi.fn(),
      onExternalSend: vi.fn(),
      classifyTicket: vi.fn(async () => 'inline' as const),
      createPrd: vi.fn(async () => ({ ok: true as const, nn: 1, filename: '1-fake.md' })),
    },
    transcripts: { pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl') },
    config: { exists: vi.fn().mockResolvedValue(true) },
    logs: { write: vi.fn() },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { api, run, cancel }
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

const CONSENT_NOTICE_TEXT = 'This session needs interactive consent for an MCP server before it can continue.'

describe('Turn — consent-notice Retry button', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    if (root && container) {
      act(() => root!.unmount())
      container.remove()
    }
    container = null
    root = null
    delete (window as unknown as { api?: unknown }).api
  })

  it('resends the preceding user prompt when Retry is clicked after consent is granted', async () => {
    const { api } = installWindowApiMock()
    const { Turn } = await import('../ChatTranscriptTurn')

    const el = mount(
      createElement(Turn, {
        turn: {
          id: 't-notice',
          role: 'notice',
          text: CONSENT_NOTICE_TEXT,
          at: Date.now(),
        } as any,
        cwd: '/tmp/proj',
        tabId: 'tab-1',
        sessionId: 'sess-1',
        precedingUserPrompt: 'please deploy the widget',
      }),
    )

    // Expand the widget and simulate InlineConsentTerminal detecting the
    // CLI's success phrasing.
    const grantButton = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Grant consent →')!
    await act(async () => {
      grantButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => { await Promise.resolve() })

    const fakeGranted = el.querySelector('[data-testid="fake-consent-granted"]')!
    await act(async () => {
      fakeGranted.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const retryButton = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Retry →')
    expect(retryButton).not.toBeUndefined()
    // The old "Grant consent →" affordance is gone once granted.
    expect(Array.from(el.querySelectorAll('button')).some((b) => b.textContent === 'Grant consent →')).toBe(false)

    await act(async () => {
      retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(api.chat.run).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'tab-1', sessionId: 'sess-1', prompt: 'please deploy the widget' }),
    )
  })

  it('omits the Retry button when no preceding user prompt was identified', async () => {
    installWindowApiMock()
    const { Turn } = await import('../ChatTranscriptTurn')

    const el = mount(
      createElement(Turn, {
        turn: {
          id: 't-notice',
          role: 'notice',
          text: CONSENT_NOTICE_TEXT,
          at: Date.now(),
        } as any,
        cwd: '/tmp/proj',
        tabId: 'tab-1',
        sessionId: 'sess-1',
        // precedingUserPrompt intentionally omitted — e.g. notice is the
        // first turn, or the prior turn wasn't a plain user prompt.
      }),
    )

    const grantButton = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Grant consent →')!
    await act(async () => {
      grantButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => { await Promise.resolve() })

    const fakeGranted = el.querySelector('[data-testid="fake-consent-granted"]')!
    await act(async () => {
      fakeGranted.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const buttons = Array.from(el.querySelectorAll('button')).map((b) => b.textContent)
    expect(buttons).not.toContain('Retry →')
    expect(buttons).not.toContain('Grant consent →')
    expect(el.textContent).toContain(CONSENT_NOTICE_TEXT)
  })
})

describe('Turn — assistant diff card (PRD chat-turn-diff-rendering)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    if (root && container) {
      act(() => root!.unmount())
      container.remove()
    }
    container = null
    root = null
    delete (window as unknown as { api?: unknown }).api
  })

  it('renders a diff card for a toolUse carrying a diff payload, with added/removed content', async () => {
    installWindowApiMock()
    const { Turn } = await import('../ChatTranscriptTurn')

    const el = mount(
      createElement(Turn, {
        turn: {
          id: 't-assistant-diff',
          role: 'assistant',
          text: 'Updated the config.',
          at: Date.now(),
          toolUses: [
            {
              id: 'tu-1',
              kind: 'tool',
              label: 'Edit',
              diff: { filePath: 'src/foo.ts', oldText: 'const a = 1', newText: 'const a = 2' },
            },
          ],
        } as any,
        cwd: '/tmp/proj',
        tabId: 'tab-1',
        sessionId: 'sess-1',
      }),
    )

    const card = el.querySelector('[data-testid="diff-card"]')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('src/foo.ts')
    expect(card!.textContent).toContain('+1')
    expect(card!.textContent).toContain('-1')

    // Collapsed by default — line content not yet in the DOM.
    expect(el.querySelector('[data-testid="diff-card-lines"]')).toBeNull()

    const toggle = el.querySelector('[data-testid="diff-card-toggle"]')!
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const lines = el.querySelector('[data-testid="diff-card-lines"]')
    expect(lines).not.toBeNull()
    expect(lines!.textContent).toContain('const a = 1')
    expect(lines!.textContent).toContain('const a = 2')
  })

  it('renders one diff card per Edit/Write toolUse, and no card for a plain-text turn', async () => {
    installWindowApiMock()
    const { Turn } = await import('../ChatTranscriptTurn')

    const el = mount(
      createElement(Turn, {
        turn: {
          id: 't-assistant-multi-diff',
          role: 'assistant',
          text: 'Updated two files.',
          at: Date.now(),
          toolUses: [
            { id: 'tu-1', kind: 'tool', label: 'Edit', diff: { filePath: 'src/a.ts', oldText: 'x', newText: 'y' } },
            { id: 'tu-2', kind: 'tool', label: 'Write', diff: { filePath: 'src/b.ts', newText: 'brand new file' } },
            { id: 'tu-3', kind: 'tool', label: 'Bash' },
          ],
        } as any,
        cwd: '/tmp/proj',
        tabId: 'tab-1',
        sessionId: 'sess-1',
      }),
    )

    const cards = el.querySelectorAll('[data-testid="diff-card"]')
    expect(cards.length).toBe(2)
  })

  it('renders no diff card at all for a turn with no diff-carrying toolUses', async () => {
    installWindowApiMock()
    const { Turn } = await import('../ChatTranscriptTurn')

    const el = mount(
      createElement(Turn, {
        turn: {
          id: 't-assistant-plain',
          role: 'assistant',
          text: 'Just some prose, no edits.',
          at: Date.now(),
          toolUses: [{ id: 'tu-1', kind: 'tool', label: 'Bash' }],
        } as any,
        cwd: '/tmp/proj',
        tabId: 'tab-1',
        sessionId: 'sess-1',
      }),
    )

    expect(el.querySelector('[data-testid="diff-card"]')).toBeNull()
    expect(el.textContent).toContain('Just some prose, no edits.')
  })
})
