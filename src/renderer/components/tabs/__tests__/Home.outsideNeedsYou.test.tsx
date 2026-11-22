// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { NeedsYouSection } from '../Home'
import { useOutsideNeedsYou } from '../../../lib/useOutsideNeedsYou'
import { buildNeedsYouRows, type OutsideItemLite } from '../../../lib/homeNeedsYou'
import { toast } from '../../../state/toast'

let container: HTMLDivElement | null = null
let root: Root | null = null
let answerMock: ReturnType<typeof vi.fn>
let openMock: ReturnType<typeof vi.fn>

const item = (over: Partial<OutsideItemLite> = {}): OutsideItemLite => ({
  app: 'Portfolio',
  id: 'deploy-1',
  title: 'Ship the <b>release</b>?',
  why: 'Tests are green on main.',
  link: 'https://example.com/deploy/1',
  options: ['Ship', 'Hold'],
  status: 'open',
  createdAt: '2026-11-20T10:00:00.000Z',
  ...over,
})

// Mounts NeedsYouSection the way Home does: the hook's answer is the row's answer path.
function Harness({ items }: { items: OutsideItemLite[] }) {
  const { answer } = useOutsideNeedsYou()
  const rows = buildNeedsYouRows({}, {}, [], 0, items)
  return createElement(NeedsYouSection, { rows, onAnswer: answer })
}

async function mount(items: OutsideItemLite[]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(Harness, { items }))
    await Promise.resolve()
  })
  return container
}

const buttons = (el: HTMLElement) => Array.from(el.querySelectorAll('button'))
const button = (el: HTMLElement, text: string) => buttons(el).find((b) => b.textContent === text)
const click = async (b: Element) => {
  await act(async () => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}
const expand = async (el: HTMLElement, title: string) =>
  click(buttons(el).find((b) => b.textContent?.includes(title))!)

beforeEach(() => {
  answerMock = vi.fn().mockResolvedValue({ ok: true, item: {} })
  openMock = vi.fn().mockResolvedValue(undefined)
  ;(window as unknown as { api: unknown }).api = {
    needsYou: {
      list: vi.fn().mockResolvedValue({ ok: true, items: [] }),
      answer: answerMock,
      onChanged: vi.fn(() => () => {}),
    },
    shell: { open: openMock },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.restoreAllMocks()
  delete (window as unknown as { api?: unknown }).api
})

describe('NeedsYouSection outside-item rows', () => {
  it('renders title, why and app as plain text', async () => {
    const el = await mount([item()])
    expect(el.textContent).toContain('Ship the <b>release</b>?')
    expect(el.querySelector('b')).toBeNull()
    expect(el.textContent).toContain('Tests are green on main.')
    await expand(el, 'Ship the')
    expect(el.textContent).toContain('Portfolio')
  })

  it('shows one button per option and sends the pressed one through the hook', async () => {
    const el = await mount([item()])
    await expand(el, 'Ship the')
    expect(button(el, 'Ship')).toBeTruthy()
    expect(button(el, 'Hold')).toBeTruthy()
    await click(button(el, 'Hold')!)
    expect(answerMock).toHaveBeenCalledTimes(1)
    expect(answerMock).toHaveBeenCalledWith({ app: 'Portfolio', id: 'deploy-1', answer: 'Hold' })
  })

  it('shows an error toast with the reason when the answer fails', async () => {
    const err = vi.spyOn(toast, 'error')
    answerMock.mockResolvedValue({ ok: false, error: 'No such open item.' })
    const el = await mount([item()])
    await expand(el, 'Ship the')
    await click(button(el, 'Ship')!)
    expect(err).toHaveBeenCalledWith('No such open item.')
  })

  it('Open calls shell.open as external with the link', async () => {
    const el = await mount([item()])
    await expand(el, 'Ship the')
    await click(button(el, 'Open')!)
    expect(openMock).toHaveBeenCalledWith({ as: 'external', url: 'https://example.com/deploy/1' })
  })

  it('a row without options or link shows no answer or Open button', async () => {
    const el = await mount([item({ options: null, link: null })])
    await expand(el, 'Ship the')
    expect(button(el, 'Ship')).toBeUndefined()
    expect(button(el, 'Hold')).toBeUndefined()
    expect(button(el, 'Open')).toBeUndefined()
    // Only the row's own expand toggle remains.
    expect(buttons(el).filter((b) => !b.closest('[data-testid^="home-needs-pager"]')).length).toBe(1)
  })
})
