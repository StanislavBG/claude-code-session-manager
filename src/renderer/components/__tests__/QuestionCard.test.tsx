// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { QuestionCard } from '../QuestionCard'
import { useChat, type ChatSendResult, type ChatTurn } from '../../state/chat'
import { useQuestionDrafts } from '../../state/questionDrafts'
import { composeQuestionReply } from '../../lib/questionReply'
import type { QuestionCardState } from '../../lib/questionCardState'

/**
 * QuestionCard — per-question answers + "You decide", one combined reply
 * through useChat.send once every question is resolved.
 */

let container: HTMLDivElement | null = null
let root: Root | null = null
const originalSend = useChat.getState().send
let send: ReturnType<typeof vi.fn>

function mockSend(result: ChatSendResult) {
  send = vi.fn(() => result)
  useChat.setState({ send } as never)
}

const QUESTIONS = ['Cap at archive depth?', 'Which branch?', 'Ship tonight?']
const turn = (questions: string[] = QUESTIONS): ChatTurn => ({
  id: 'q-1',
  role: 'question',
  text: questions.join('\n'),
  questions,
  at: Date.now(),
})

function render(cardState: QuestionCardState = 'open', t: ChatTurn = turn()) {
  const el = createElement(QuestionCard, {
    turn: t,
    tabId: 'tab-1',
    sessionId: 'sess-1',
    cwd: '/tmp/proj',
    cardState,
    tintClass: 'tint',
    textClass: 'txt',
  })
  if (!container) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  act(() => root!.render(el))
  return container
}

function unmount() {
  if (root && container) {
    act(() => root!.unmount())
    container.remove()
  }
  root = null
  container = null
}

const all = (sel: string) => Array.from(container!.querySelectorAll<HTMLElement>(sel))

function type(input: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(input: HTMLElement, key: string, shiftKey = false) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }))
  })
}

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** The input/buttons of the row at `index` (rows stay in question order). */
function row(index: number) {
  const r = all('[data-testid="question-row"]')[index]
  return {
    el: r,
    input: r.querySelector<HTMLTextAreaElement>('[data-testid="question-answer-input"]'),
    submit: r.querySelector<HTMLButtonElement>('[data-testid="question-answer-submit"]'),
    delegate: r.querySelector<HTMLButtonElement>('[data-testid="question-delegate"]'),
    edit: r.querySelector<HTMLButtonElement>('[data-testid="question-edit"]'),
  }
}

/** Resolve all three: Enter answer, You decide, Answer button. */
function answerAll(first = 'Cap it') {
  type(row(0).input!, first)
  press(row(0).input!, 'Enter')
  click(row(1).delegate!)
  type(row(2).input!, 'Yes')
  click(row(2).submit!)
}

describe('QuestionCard', () => {
  beforeEach(() => {
    useQuestionDrafts.setState({ drafts: {} })
    mockSend({ disposition: 'sent' })
  })
  afterEach(() => {
    unmount()
    useChat.setState({ send: originalSend })
  })

  it('CORE: 3-question flow sends one composed reply exactly once', () => {
    render()
    expect(all('[data-testid="question-row"]')).toHaveLength(3)
    expect(row(0).input!.getAttribute('aria-label')).toBe('Answer to question 1')
    expect(row(0).submit!.disabled).toBe(true)
    expect(container!.textContent).toContain('0 of 3 answered')

    type(row(0).input!, 'Cap it')
    expect(row(0).submit!.disabled).toBe(false)
    // Shift+Enter does not commit.
    press(row(0).input!, 'Enter', true)
    expect(row(0).edit).toBeNull()
    press(row(0).input!, 'Enter')
    expect(row(0).edit).not.toBeNull()
    expect(row(0).el.textContent).toContain('Cap it')
    expect(container!.textContent).toContain('1 of 3 answered')

    click(row(1).delegate!)
    expect(row(1).el.textContent).toContain('You decide')
    expect(send).not.toHaveBeenCalled()

    type(row(2).input!, 'Yes')
    click(row(2).submit!)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      tabId: 'tab-1',
      sessionId: 'sess-1',
      cwd: '/tmp/proj',
      prompt: composeQuestionReply(QUESTIONS, [
        { kind: 'answer', text: 'Cap it' },
        { kind: 'delegate' },
        { kind: 'answer', text: 'Yes' },
      ]),
    })
    // Submitted 'sent' renders read-only.
    expect(all('[data-testid="question-answer-input"]')).toHaveLength(0)
    expect(all('[data-testid="question-edit"]')).toHaveLength(0)
  })

  it('CORE: nothing is disabled while a run is in flight', () => {
    useChat.setState({ chats: { 'tab-1': { running: true } } } as never)
    render()
    expect(row(0).delegate!.disabled).toBe(false)
    type(row(0).input!, 'x')
    expect(row(0).submit!.disabled).toBe(false)
    useChat.setState({ chats: {} } as never)
  })

  it('CORE: Edit then re-answer changes the composed text', () => {
    render()
    type(row(0).input!, 'Cap it')
    press(row(0).input!, 'Enter')
    click(row(0).edit!)
    expect(row(0).input!.value).toBe('Cap it')
    type(row(0).input!, 'Extrapolate')
    press(row(0).input!, 'Enter')
    click(row(1).delegate!)
    type(row(2).input!, 'Yes')
    click(row(2).submit!)
    expect(send).toHaveBeenCalledTimes(1)
    const prompt = send.mock.calls[0][0].prompt as string
    expect(prompt).toContain('Answer: Extrapolate')
    expect(prompt).not.toContain('Cap it')
  })

  it('CORE: a queued reply shows the queued line and no inputs', () => {
    mockSend({ disposition: 'queued' })
    render()
    answerAll()
    expect(send).toHaveBeenCalledTimes(1)
    expect(container!.textContent).toContain('Reply queued — it sends when the current run finishes.')
    expect(all('textarea')).toHaveLength(0)
    expect(all('[data-testid="question-answer-submit"]')).toHaveLength(0)
  })

  it('EDGE: refused keeps every resolution and Send answers retries the same send', () => {
    mockSend({ disposition: 'refused', reason: 'terminal-attached' })
    render()
    answerAll()
    expect(send).toHaveBeenCalledTimes(1)
    expect(all('[data-testid="question-edit"]')).toHaveLength(3)
    const retry = container!.querySelector<HTMLButtonElement>('[data-testid="question-send"]')!
    expect(retry).not.toBeNull()

    send.mockImplementation(() => ({ disposition: 'sent' }))
    click(retry)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0])
    expect(container!.querySelector('[data-testid="question-send"]')).toBeNull()
  })

  it.each([
    ['answered', 'question-card-answered', 'Answered'],
    ['superseded', 'question-card-superseded', 'Superseded by a newer question'],
  ] as const)('CORE: %s renders read-only', (state, testid, label) => {
    render(state, turn(['Use **bold**?', 'Second?']))
    expect(container!.querySelector(`[data-testid="${testid}"]`)!.textContent).toBe(label)
    expect(all('textarea')).toHaveLength(0)
    expect(all('button')).toHaveLength(0)
    expect(container!.textContent).toContain('Use **bold**?')
    expect(container!.querySelector('strong')).toBeNull()
  })

  it('EDGE: typed text is restored after unmount and remount', () => {
    render()
    type(row(1).input!, 'half-typed')
    unmount()
    render()
    expect(row(1).input!.value).toBe('half-typed')
  })

  it('EDGE: no questions renders one free-form "Your reply" row', () => {
    render('open', { id: 'q-2', role: 'question', text: '', at: Date.now() })
    expect(all('[data-testid="question-row"]')).toHaveLength(1)
    expect(container!.textContent).toContain('Your reply')
    type(row(0).input!, 'Go ahead')
    press(row(0).input!, 'Enter')
    expect(send).toHaveBeenCalledTimes(1)
  })
})
