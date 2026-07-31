// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, vi } from 'vitest'

/**
 * PromptSessionConversation (PRD 804) — the goal-scoped Agent conversation
 * view opened from a PromptSession row (PRD 802/803). Verifies the three
 * hard constraints from the PRD: no SessionTab/TabBar entry gets created, no
 * ChatSessionRail/right-nav renders, and sending a message runs through
 * chatRunner scoped to the PromptSession's own claudeSessionId and appends a
 * correctly-chained 'response' PromptSessionEvent.
 *
 * window.api is stubbed via vi.stubGlobal + vi.resetModules/dynamic import,
 * mirroring state/__tests__/chat.test.ts's pattern — chat.ts's module-load
 * IPC subscription block only wires up if window.api.chat exists at import
 * time, so the mock must be installed before chat.ts (transitively imported
 * by the component under test) is first imported.
 */

function installWindowApiMock() {
  const run = vi.fn().mockResolvedValue(undefined)
  let completeHandler: ((e: { tabId: string; sessionId: string; finalMessage: string }) => void) | null = null
  const shellOpen = vi.fn().mockResolvedValue(undefined)
  const filesRead = vi.fn().mockResolvedValue({ ok: true, text: '# Doc\n\nbody', error: null, size: 20 })
  const browserCreate = vi.fn().mockResolvedValue(undefined)
  const api = {
    chat: {
      run,
      cancel: vi.fn(),
      onQueued: vi.fn(),
      onRunStarted: vi.fn(),
      onOutput: vi.fn(),
      onToolUse: vi.fn(),
      onComplete: vi.fn((handler) => {
        completeHandler = handler
        return () => { completeHandler = null }
      }),
      onNeedsInput: vi.fn(),
      onError: vi.fn(),
      onNotice: vi.fn(),
      onExternalSend: vi.fn(),
      classifyTicket: vi.fn(async () => 'inline' as const),
      createPrd: vi.fn(async () => ({ ok: true as const, nn: 1, filename: '1-fake.md' })),
    },
    transcripts: {
      pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl'),
    },
    config: {
      exists: vi.fn().mockResolvedValue(true),
    },
    clipboard: {
      writeText: vi.fn().mockResolvedValue({ ok: true }),
    },
    logs: { write: vi.fn() },
    shell: { open: shellOpen },
    files: { read: filesRead },
    browser: {
      create: browserCreate,
      navigate: vi.fn().mockResolvedValue(undefined),
      onNavState: vi.fn(() => () => {}),
    },
  }
  // Assign directly onto the real jsdom `window` (rather than vi.stubGlobal
  // replacing the whole object) — replacing `window` wholesale drops
  // prototype-chain DOM APIs (MessageChannel, queueMicrotask, etc.) that
  // React's test renderer needs, which manifests as an opaque "Should not
  // already be working" act() error.
  ;(window as unknown as { api: typeof api }).api = api
  return { api, run, getCompleteHandler: () => completeHandler, shellOpen, filesRead, browserCreate }
}

describe('PromptSessionConversation (PRD 804)', () => {
  beforeEach(() => {
    vi.resetModules()
    delete (window as unknown as { api?: unknown }).api
  })

  it('renders composer + transcript with no SessionTab created and no ChatSessionRail/right-nav markup', async () => {
    installWindowApiMock()
    const { useSessions } = await import('../../state/sessions')
    const { usePromptSessions } = await import('../../state/promptSessions')
    const { PromptSessionConversation } = await import('../PromptSessionConversation')

    useSessions.setState({ tabs: [], activeTabId: null })
    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship the thing')

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      act(() => {
        root.render(createElement(PromptSessionConversation, { promptSession: session }))
      })

      expect(container.querySelector('[data-testid="prompt-session-conversation"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="prompt-session-transcript"]')).not.toBeNull()
      expect(container.querySelector('textarea')).not.toBeNull()

      // No SessionTab/TabBar entry was created for this PromptSession.
      expect(useSessions.getState().tabs).toHaveLength(0)

      // No ChatSessionRail equivalent: no cwd/idle card, no "This turn" tool-activity card.
      expect(container.textContent).not.toContain('This turn')
      expect(container.textContent).not.toContain('No tool activity yet.')
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('sending a message runs it through chatRunner scoped to the PromptSession\'s claudeSessionId and appends a correctly-chained response event', async () => {
    const { run, getCompleteHandler } = installWindowApiMock()
    const { useSessions } = await import('../../state/sessions')
    const { usePromptSessions } = await import('../../state/promptSessions')
    const { PromptSessionConversation } = await import('../PromptSessionConversation')

    useSessions.setState({ tabs: [], activeTabId: null })
    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship the thing')
    const initialEvent = usePromptSessions.getState().events[session.id][0]

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      act(() => {
        root.render(createElement(PromptSessionConversation, { promptSession: session }))
      })

      const textarea = container.querySelector('textarea') as HTMLTextAreaElement
      const sendButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Send') as HTMLButtonElement
      const discussionButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Discussion') as HTMLButtonElement

      // Discussion tag: stays interactive / runs through chatRunner, never
      // dispatched to a PRD (Feature/Bug tags dispatch instead — covered by
      // chat.test.ts's dispatchPromptSessionToPrd coverage).
      act(() => {
        discussionButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      // React tracks a controlled element's last-known value via a patched
      // value setter; a plain `el.value = x` updates that tracker too, so a
      // follow-up dispatchEvent sees "no change" and never fires onChange.
      // Go through the native prototype setter to bypass it (mirrors
      // ProjectsLanding.test.tsx's setNativeValue).
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      act(() => {
        setter.call(textarea, 'do the first step')
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      })
      act(() => {
        sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      await vi.waitFor(() => expect(run).toHaveBeenCalled())
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          tabId: session.id,
          sessionId: session.claudeSessionId,
          cwd: session.cwd,
          prompt: 'do the first step',
        }),
      )

      act(() => {
        getCompleteHandler()!({ tabId: session.id, sessionId: session.claudeSessionId, finalMessage: 'done with step one' })
      })

      const events = usePromptSessions.getState().events[session.id]
      const response = events[events.length - 1]
      expect(response.kind).toBe('response')
      expect(response.text).toBe('done with step one')
      expect(response.causedByEventId).toBe(initialEvent.id)

      // Still no SessionTab, even after a full send/response round trip.
      expect(useSessions.getState().tabs).toHaveLength(0)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('does not double-append a response event when the view unmounts and remounts for the same completed turn', async () => {
    const { run, getCompleteHandler } = installWindowApiMock()
    const { usePromptSessions } = await import('../../state/promptSessions')
    const { PromptSessionConversation } = await import('../PromptSessionConversation')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship the thing')

    const container = document.createElement('div')
    document.body.appendChild(container)
    let root = createRoot(container)
    act(() => {
      root.render(createElement(PromptSessionConversation, { promptSession: session }))
    })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    const sendButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Send') as HTMLButtonElement
    const discussionButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Discussion') as HTMLButtonElement
    act(() => {
      discussionButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(textarea, 'first message')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await vi.waitFor(() => expect(run).toHaveBeenCalled())
    act(() => {
      getCompleteHandler()!({ tabId: session.id, sessionId: session.claudeSessionId, finalMessage: 'the reply' })
    })

    const afterFirstMount = usePromptSessions.getState().events[session.id]
    expect(afterFirstMount.filter((e) => e.kind === 'response')).toHaveLength(1)

    // Simulate "Back to Projects" then reopening the same row: the component
    // fully unmounts and remounts, but chat.ts's turn (and its store entry)
    // persists since it's keyed by session.id, not by the component instance.
    act(() => { root.unmount() })
    root = createRoot(container)
    act(() => {
      root.render(createElement(PromptSessionConversation, { promptSession: session }))
    })

    const afterRemount = usePromptSessions.getState().events[session.id]
    expect(afterRemount.filter((e) => e.kind === 'response')).toHaveLength(1)

    act(() => { root.unmount() })
    container.remove()
  })

  it('sending a Feature-tagged prompt dispatches a PRD and renders it as a clickable chip, chained off the tail event', async () => {
    const { api } = installWindowApiMock()
    const { usePromptSessions } = await import('../../state/promptSessions')
    const { PromptSessionConversation } = await import('../PromptSessionConversation')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship the thing')
    const initialEvent = usePromptSessions.getState().events[session.id][0]

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      act(() => {
        root.render(createElement(PromptSessionConversation, { promptSession: session }))
      })

      const textarea = container.querySelector('textarea') as HTMLTextAreaElement
      const sendButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Send') as HTMLButtonElement
      // Feature is the composer's default tag — no extra click needed.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      act(() => {
        setter.call(textarea, 'build the widget')
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })

      await vi.waitFor(() => expect(api.chat.createPrd).toHaveBeenCalled())
      expect(api.chat.createPrd).toHaveBeenCalledWith(
        expect.objectContaining({ goal: 'build the widget', cwd: session.cwd, sourcePromptId: session.id, tag: 'feature' }),
      )

      const events = usePromptSessions.getState().events[session.id]
      const created = events[events.length - 1]
      expect(created.kind).toBe('prd_created')
      expect(created.prdSlug).toBe('1-fake')
      expect(created.causedByEventId).toBe(initialEvent.id)

      await vi.waitFor(() =>
        expect(container.querySelector('[data-testid="prompt-session-prd-event"]')).not.toBeNull(),
      )
      expect(container.querySelector('[data-testid="prompt-session-prd-event"]')!.textContent).toContain('1-fake')
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('clicking an http(s) link in the conversation view opens it via the embedded Browser, not shell.openExternal', async () => {
    const { shellOpen, browserCreate } = installWindowApiMock()
    const { usePromptSessions } = await import('../../state/promptSessions')
    const { PromptSessionConversation } = await import('../PromptSessionConversation')
    const { useChat } = await import('../../state/chat')
    const { useBrowserState } = await import('../../state/browser')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship the thing')
    useChat.setState({
      chats: {
        [session.id]: {
          turns: [
            { id: 't1', role: 'assistant', text: 'See https://example.com/page for the docs.', at: Date.now() },
          ],
          running: false,
          stream: '',
          queuedPosition: 0,
        } as any,
      },
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      act(() => {
        root.render(createElement(PromptSessionConversation, { promptSession: session }))
      })

      const link = container.querySelector('a[href="https://example.com/page"]') as HTMLAnchorElement
      expect(link).not.toBeNull()

      act(() => {
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })

      await vi.waitFor(() => expect(browserCreate).toHaveBeenCalled())
      expect(shellOpen).not.toHaveBeenCalled()
      expect(useBrowserState.getState().tabs.some((t) => t.url === 'https://example.com/page')).toBe(true)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  // PRD 814: a dispatched-to-prd ticket now opens its own PromptSession's
  // conversation (chat.ts:promptSessionId, set at dispatch by PRD 813) via
  // the same chatKey-scoping this component already relies on — a second,
  // unrelated ticket's session must never leak turns into it.
  it('scopes its transcript to its own PromptSession id — a second unrelated session\'s turns never appear', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../state/promptSessions')
    const { PromptSessionConversation } = await import('../PromptSessionConversation')
    const { useChat } = await import('../../state/chat')

    const sessionA = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ticket A goal')
    const sessionB = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ticket B goal')
    useChat.setState({
      chats: {
        [sessionA.id]: {
          turns: [{ id: 'a1', role: 'assistant', text: 'Reply for A only', at: Date.now() }],
          running: false,
          stream: '',
          queuedPosition: 0,
        } as any,
        [sessionB.id]: {
          turns: [{ id: 'b1', role: 'assistant', text: 'Reply for B only', at: Date.now() }],
          running: false,
          stream: '',
          queuedPosition: 0,
        } as any,
      },
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      act(() => {
        root.render(createElement(PromptSessionConversation, { promptSession: sessionA }))
      })
      expect(container.textContent).toContain('Reply for A only')
      expect(container.textContent).not.toContain('Reply for B only')

      act(() => { root.unmount() })
      const root2 = createRoot(container)
      act(() => {
        root2.render(createElement(PromptSessionConversation, { promptSession: sessionB }))
      })
      expect(container.textContent).toContain('Reply for B only')
      expect(container.textContent).not.toContain('Reply for A only')
      act(() => { root2.unmount() })
    } finally {
      container.remove()
    }
  })

  it('renders a .md file reference via the shared MarkdownPreview component, not renderChatMarkdown', async () => {
    const { filesRead } = installWindowApiMock()
    const { usePromptSessions } = await import('../../state/promptSessions')
    const { PromptSessionConversation } = await import('../PromptSessionConversation')
    const { useChat } = await import('../../state/chat')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship the thing')
    useChat.setState({
      chats: {
        [session.id]: {
          turns: [
            { id: 't1', role: 'assistant', text: 'See PLAN.md for the write-up.', at: Date.now() },
          ],
          running: false,
          stream: '',
          queuedPosition: 0,
        } as any,
      },
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      act(() => {
        root.render(createElement(PromptSessionConversation, { promptSession: session }))
      })

      const previewButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Preview') as HTMLButtonElement
      expect(previewButton).not.toBeUndefined()

      await act(async () => {
        previewButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })

      await vi.waitFor(() => expect(filesRead).toHaveBeenCalled())
      await vi.waitFor(() => {
        expect(container.querySelector('[data-testid="file-inline-preview"] .markdown-body')).not.toBeNull()
      })
      expect(container.querySelector('[data-testid="file-inline-preview"] h1')?.textContent).toBe('Doc')
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})
