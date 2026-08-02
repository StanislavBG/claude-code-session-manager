// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

/**
 * EpicDetail's Chat <-> Terminal mode toggle (PRD 831). EpicTerminalPane
 * itself owns the real xterm + pty wiring (@xterm/xterm doesn't run under
 * plain jsdom — no matchMedia/canvas — so it's stubbed here); this file
 * covers the toggle's disabled/hidden states and the marker-event handoff
 * back to Chat, which live entirely in EpicDetail + the epicTerminal store.
 */

vi.mock('../EpicTerminalPane', () => ({
  EpicTerminalPane: ({ onReturnToChat }: { onReturnToChat: () => void }) =>
    createElement(
      'div',
      { 'data-testid': 'fake-epic-terminal-pane' },
      createElement('button', { 'data-testid': 'fake-return-to-chat', onClick: onReturnToChat }, 'return'),
    ),
}))

function installWindowApiMock() {
  const api = {
    chat: {
      run: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
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
    pty: { kill: vi.fn() },
    transcripts: { pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl') },
    config: {
      exists: vi.fn().mockResolvedValue(true),
      readText: vi.fn().mockResolvedValue({ exists: false, text: '' }),
      writeJson: vi.fn().mockResolvedValue({ ok: true }),
    },
    clipboard: { writeText: vi.fn().mockResolvedValue({ ok: true }) },
    logs: { write: vi.fn() },
    schedule: { listPrds: vi.fn().mockResolvedValue([]) },
    promptSessionTranscript: {
      append: vi.fn().mockResolvedValue({ ok: true }),
      read: vi.fn().mockResolvedValue({ turns: [] }),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { api }
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

describe('EpicDetail Chat <-> Terminal mode toggle (PRD 831)', () => {
  beforeEach(() => {
    vi.resetModules()
    delete (window as unknown as { api?: unknown }).api
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
  })

  it('hides the mode toggle entirely for a completed Epic', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    usePromptSessions.setState({
      sessions: {
        ...usePromptSessions.getState().sessions,
        [session.id]: { ...session, status: 'completed', completedAt: new Date().toISOString() },
      },
    })
    const completed = usePromptSessions.getState().sessions[session.id]

    const el = mount(createElement(EpicDetail, { promptSession: completed }))

    expect(el.querySelector('[data-testid="epic-mode-toggle"]')).toBeNull()
  })

  it('shows the toggle for an active Epic with Terminal enabled when chat is idle', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const terminalBtn = el.querySelector('[data-testid="epic-mode-terminal"]') as HTMLButtonElement
    expect(terminalBtn).not.toBeNull()
    expect(terminalBtn.disabled).toBe(false)
  })

  it('disables the Terminal toggle with a tooltip while a chat run is active', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useChat } = await import('../../../state/chat')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    useChat.setState({
      chats: {
        [session.id]: { turns: [], running: true, stream: '', queuedPosition: 0 } as any,
      },
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const terminalBtn = el.querySelector('[data-testid="epic-mode-terminal"]') as HTMLButtonElement
    expect(terminalBtn.disabled).toBe(true)
    expect(terminalBtn.title).toContain('running or queued')

    act(() => {
      terminalBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Still on Chat — click on a disabled control must not switch mode.
    expect(el.querySelector('[data-testid="fake-epic-terminal-pane"]')).toBeNull()
  })

  it('disables the Terminal toggle while a follow-up prompt is queued behind a running turn', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useChat } = await import('../../../state/chat')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    useChat.setState({
      chats: {
        [session.id]: { turns: [], running: false, stream: '', queuedPosition: 1 } as any,
      },
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    const terminalBtn = el.querySelector('[data-testid="epic-mode-terminal"]') as HTMLButtonElement
    expect(terminalBtn.disabled).toBe(true)
  })

  it('switches to Terminal mode and mounts the terminal pane, hiding the view tabs', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    const terminalBtn = el.querySelector('[data-testid="epic-mode-terminal"]') as HTMLButtonElement
    act(() => {
      terminalBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(el.querySelector('[data-testid="fake-epic-terminal-pane"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="epic-detail-body"]')).toBeNull()
  })

  it('disables "Mark completed" while Terminal mode is active, so it cannot kill the live PTY out from under the user', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    expect((el.querySelector('[data-testid="epic-mark-completed"]') as HTMLButtonElement).disabled).toBe(false)

    const terminalBtn = el.querySelector('[data-testid="epic-mode-terminal"]') as HTMLButtonElement
    act(() => { terminalBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect((el.querySelector('[data-testid="epic-mark-completed"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('appends a response-kind marker event with correct causedByEventId chaining when returning to Chat', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const firstEvent = usePromptSessions.getState().events[session.id][0]

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    const terminalBtn = el.querySelector('[data-testid="epic-mode-terminal"]') as HTMLButtonElement
    act(() => {
      terminalBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const returnBtn = el.querySelector('[data-testid="fake-return-to-chat"]') as HTMLButtonElement
    act(() => {
      returnBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // The marker append now follows an async handoff-transcript capture
    // attempt (PRD 863) — readText's mocked `exists: false` means nothing is
    // parseable, so it resolves to the same 0-captured-turns placeholder the
    // old synchronous append used, just one microtask queue later.
    await vi.waitFor(() => expect(usePromptSessions.getState().events[session.id]).toHaveLength(2))
    const events = usePromptSessions.getState().events[session.id]
    const marker = events[1]
    expect(marker.kind).toBe('response')
    expect(marker.causedByEventId).toBe(firstEvent.id)
    expect(marker.text).toBe('Iterated in Terminal view')

    // Back on Chat: the pane is gone and the marker renders in the timeline.
    expect(el.querySelector('[data-testid="fake-epic-terminal-pane"]')).toBeNull()
    await vi.waitFor(() =>
      expect(el.querySelector('[data-testid="epic-response-event"]')?.textContent).toContain(
        'Iterated in Terminal view',
      ),
    )
  })

  it('renders a response event\'s markdown as formatted output, not literal asterisks/backticks', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const firstEvent = usePromptSessions.getState().events[session.id][0]
    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: firstEvent.id,
      text: 'PRD 999-fake finished: **completed** with `npm test` green.',
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const textEl = el.querySelector('[data-testid="epic-response-event-text"]') as HTMLElement
    expect(textEl).not.toBeNull()
    expect(textEl.innerHTML).toContain('<strong>completed</strong>')
    expect(textEl.innerHTML).toContain('<code>npm test</code>')
    expect(textEl.textContent).not.toContain('**')
    expect(textEl.textContent).not.toContain('`npm test`')
  })
})
