// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { flushAsync } from '../../../testUtils/domFlush'
import { fakePromptSessionsCreate } from '../../../testUtils/fakePromptSessionsCreate'

/**
 * EpicDetail Changes tab (PRD epic-detail-changes-tab) — the fourth tab after
 * Discussion/PRDs/Runs mounts EpicChangesView inside epic-detail-body, its
 * onSent returns to Discussion, and the stream auto-scroll stays Discussion-only.
 */

function installWindowApiMock(prds: unknown[] = []) {
  const listPrds = vi.fn().mockResolvedValue(prds)
  const readLog = vi.fn().mockResolvedValue({ ok: true, text: 'log line 1\nlog line 2' })
  const epicChangesGet = vi.fn().mockResolvedValue({ ok: true, epicId: 'x', status: 'active', sections: [], truncated: false })
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue('/home/bilko') },
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
    transcripts: { pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl'), exists: vi.fn().mockResolvedValue(true) },
    epicDelegationStats: { get: vi.fn().mockResolvedValue({ prdsQueued: 0, inlineEdits: 0 }) },
    config: {
      exists: vi.fn().mockResolvedValue(true),
      readText: vi.fn().mockResolvedValue({ exists: false, text: '' }),
      readJson: vi.fn().mockResolvedValue({ exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true }),
      watch: vi.fn(),
      unwatch: vi.fn(),
    },
    clipboard: { writeText: vi.fn().mockResolvedValue({ ok: true }) },
    logs: { write: vi.fn() },
    schedule: { listPrds, readLog },
    promptSessions: { create: fakePromptSessionsCreate(), onEventAppended: vi.fn() },
    epicChanges: { get: epicChangesGet },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { api, listPrds, readLog, epicChangesGet }
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

const flush = () => flushAsync(2)

function clickTab(el: HTMLElement, label: string) {
  const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.startsWith(label)) as HTMLButtonElement
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}


const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

/** jsdom has no layout: give the body a fake scrollHeight and a recording scrollTop. */
function fakeScroll(el: HTMLElement) {
  let top = 0
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 500 })
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v } })
}

async function setup() {
  const mocks = installWindowApiMock([])
  const { usePromptSessions } = await import('../../../state/promptSessions')
  const { useChat } = await import('../../../state/chat')
  const { useEpicReview } = await import('../../../state/epicReview')
  const { EpicDetail } = await import('../EpicDetail')
  const created = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
  const session = { ...created, status: 'active' as const }
  const el = mount(createElement(EpicDetail, { promptSession: session }))
  await flush()
  const streamDelta = (text: string) => {
    act(() => {
      const chats = useChat.getState().chats
      const cur = chats[session.id] ?? {
        turns: [], running: false, queuedPosition: 0, started: false, stream: '',
        liveToolUses: [], queue: [], activeTicket: null, ticketHistory: [],
      }
      useChat.setState({ chats: { ...chats, [session.id]: { ...cur, running: true, stream: cur.stream + text } } } as any)
    })
  }
  return { ...mocks, el, session, useChat, useEpicReview, streamDelta }
}

describe('EpicDetail Changes tab', () => {
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

  it('lists Changes after Runs and renders EpicChangesView inside epic-detail-body', async () => {
    const { el, session, epicChangesGet } = await setup()
    const labels = Array.from(el.querySelectorAll('[role="tab"]')).map((b) => b.textContent ?? '')
    expect(labels.findIndex((l) => l.startsWith('Changes'))).toBe(labels.findIndex((l) => l.startsWith('Runs')) + 1)
    expect(q(el, 'epic-changes')).toBeNull()

    clickTab(el, 'Changes')
    await flush()

    const changes = q(el, 'epic-changes')
    expect(changes).not.toBeNull()
    expect(q(el, 'epic-detail-body')!.contains(changes)).toBe(true)
    expect(epicChangesGet).toHaveBeenCalledWith({ cwd: '/tmp/proj', epicId: session.id })
    expect(q(el, 'epic-changes-empty')).not.toBeNull()
  })

  it('onSent returns to Discussion', async () => {
    const { el, session, useChat, useEpicReview } = await setup()
    clickTab(el, 'Changes')
    await flush()
    const send = vi.fn().mockReturnValue({ disposition: 'sent' })
    act(() => {
      useChat.setState({ send } as any)
      useEpicReview.getState().setNote(session.id, 'Please tidy this up')
    })
    act(() => q(el, 'epic-changes-send')!.click())

    expect(send).toHaveBeenCalledTimes(1)
    expect(q(el, 'epic-changes')).toBeNull()
    const selected = el.querySelector('[role="tab"][aria-selected="true"]')
    expect(selected?.textContent).toBe('Discussion')
  })

  it('a stream delta while on Changes leaves the body scrollTop alone (Discussion still auto-scrolls)', async () => {
    const { el, streamDelta } = await setup()
    const body = q(el, 'epic-detail-body')!
    fakeScroll(body)

    // Control: on Discussion a delta pins the body to the bottom.
    streamDelta('a')
    expect(body.scrollTop).toBe(500)

    clickTab(el, 'Changes')
    await flush()
    body.scrollTop = 42
    streamDelta('b')
    streamDelta('c')
    expect(body.scrollTop).toBe(42)
  })
})
