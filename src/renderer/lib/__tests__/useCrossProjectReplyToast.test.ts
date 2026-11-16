// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useCrossProjectReplyToast, _resetCrossProjectReplyToastForTests } from '../useCrossProjectReplyToast'
import { useToast } from '../../state/toast'
import { usePromptSessions } from '../../state/promptSessions'
import type { PromptSession } from '../../state/promptSessions'

type Handler = (p: { cwd: string; promptSessionId: string; event: Record<string, unknown> }) => void

function Host() {
  useCrossProjectReplyToast()
  return null
}

let handlers: Handler[] = []
let unsubscribed = 0
let container: HTMLDivElement | null = null
let root: Root | null = null

function installApi() {
  handlers = []
  unsubscribed = 0
  ;(window as unknown as { api: unknown }).api = {
    promptSessions: {
      onEventAppended: (h: Handler) => {
        handlers.push(h)
        return () => {
          unsubscribed++
          handlers = handlers.filter((x) => x !== h)
        }
      },
    },
  }
}

function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(createElement(Host)))
}

function emit(event: Record<string, unknown>, promptSessionId = 'epic-1') {
  for (const h of handlers) h({ cwd: '/home/u/asker', promptSessionId, event })
}

function replyEvent(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    promptSessionId: 'epic-1',
    kind: 'response',
    causedByEventId: null,
    at: '2026-11-16T00:00:00.000Z',
    text: 'reply',
    notice: 'cross-project-reply',
    reply: { fromCwd: '/home/u/Projects/other-repo', fromEpicId: 'e9', outcome: 'done', referencePaths: [] },
    ...extra,
  }
}

const messages = () => useToast.getState().toasts.map((t) => `${t.kind}:${t.message}`)

beforeEach(() => {
  _resetCrossProjectReplyToastForTests()
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
  usePromptSessions.setState({
    sessions: { 'epic-1': { id: 'epic-1', goalText: 'Fix the relay' } as unknown as PromptSession },
  })
  installApi()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  delete (window as unknown as { api?: unknown }).api
})

describe('useCrossProjectReplyToast', () => {
  it('toasts once for a cross-project-reply event, naming the project and Epic', () => {
    mount()
    expect(handlers).toHaveLength(1)
    emit(replyEvent('ev-1'))
    expect(messages()).toEqual(['info:Reply from other-repo landed in Fix the relay'])
  })

  it('falls back to the epic id when the Epic is not hydrated', () => {
    mount()
    emit({ ...replyEvent('ev-2'), promptSessionId: 'epic-x' }, 'epic-x')
    expect(messages()).toEqual(['info:Reply from other-repo landed in epic-x'])
  })

  it('ignores every other notice and plain events', () => {
    mount()
    emit(replyEvent('a', { notice: 'cross-project-reply-sent' }))
    emit(replyEvent('b', { notice: 'build-done' }))
    emit(replyEvent('c', { notice: undefined }))
    expect(messages()).toEqual([])
  })

  it('does not toast twice for the same event id', () => {
    mount()
    emit(replyEvent('dup'))
    emit(replyEvent('dup'))
    expect(messages()).toHaveLength(1)
  })

  it('unsubscribes on unmount', () => {
    mount()
    act(() => root!.unmount())
    root = null
    expect(unsubscribed).toBe(1)
    expect(handlers).toHaveLength(0)
  })

  it('does not throw when the API is missing', () => {
    delete (window as unknown as { api?: unknown }).api
    expect(() => mount()).not.toThrow()
    ;(window as unknown as { api: unknown }).api = { promptSessions: {} }
    act(() => root!.unmount())
    expect(() => mount()).not.toThrow()
  })
})
