// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ProjectFeedbackInbox } from '../ProjectFeedbackInbox'
import { useSiteFeedback } from '../../../../state/siteFeedback'
import type {
  SiteFeedbackInboxItem,
  SiteFeedbackItemDetail,
  SiteFeedbackItemMeta,
  SiteFeedbackReport,
} from '../../../../../preload/api'

const CWD = '/proj'
let container: HTMLDivElement | null = null
let root: Root | null = null

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<ProjectFeedbackInbox cwd={CWD} />))
  await act(async () => {
    await useSiteFeedback.getState().loadItems(CWD)
  })
  await flush()
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  useSiteFeedback.setState({ byCwd: {} })
})

const meta = (hostId: string, over: Partial<SiteFeedbackItemMeta> = {}): SiteFeedbackItemMeta => ({
  hostId,
  boxId: 'b1',
  receivedAt: '2026-11-23T00:00:00Z',
  origin: 'https://shop.example.com',
  status: 'open',
  statusNote: null,
  epicId: null,
  statusChangedAt: '2026-11-23T00:00:00Z',
  ...over,
})

const item = (hostId: string, over: Partial<SiteFeedbackInboxItem> = {}): SiteFeedbackInboxItem => ({
  ...meta(hostId),
  title: `Item ${hostId}`,
  type: 'bug',
  reporter: null,
  ...over,
})

const report = (over: Partial<SiteFeedbackReport> = {}): SiteFeedbackReport => ({
  schemaVersion: 1,
  clientReportId: 'c1',
  project: 'p',
  type: 'bug',
  title: 'Checkout button broken',
  details: 'Clicking <b>Pay</b> does nothing\nsecond line',
  createdAt: '2026-11-23T00:00:00Z',
  page: {
    url: 'https://shop.example.com/checkout?step=2',
    title: 'Checkout',
    viewport: { width: 1280, height: 720, devicePixelRatio: 2, scrollX: 0, scrollY: 340 },
  },
  screenshot: { part: 'screenshot', annotatedPart: 'annotated', width: 1280, height: 720, scale: 1 },
  marks: [
    { kind: 'pin', n: 1, x: 10, y: 20, color: '#a83818', note: 'Here' },
    {
      kind: 'element', n: 2, x: 0, y: 0, w: 10, h: 10, color: '#f4b942', note: 'This button',
      element: { selector: 'button#pay.primary', tag: 'button' },
    },
    { kind: 'arrow', x1: 0, y1: 0, x2: 5, y2: 5, color: '#1a1612' },
  ],
  console: [{ level: 'error', message: 'TypeError: x is undefined', timestamp: '2026-11-23T00:00:00Z', count: 3 }],
  network: [{ method: 'POST', url: 'https://api.example.com/pay', status: 500, durationMs: 120, timestamp: '2026-11-23T00:00:00Z' }],
  user: { id: 'u42', name: 'Ada' },
  client: { widgetVersion: '1.0.0' },
  ...over,
})

const detail = (hostId: string, r: SiteFeedbackReport | null = report()): SiteFeedbackItemDetail => ({
  meta: meta(hostId),
  report: r,
  imagePaths: { screenshot: '/x/screenshot.png', annotated: '/x/annotated.png' },
})

let sf: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  sf = {
    inboxList: vi.fn(async () => ({
      ok: true,
      items: [
        item('FB-OLD01', { receivedAt: '2026-11-20T00:00:00Z', title: 'Old one', type: 'feature' }),
        item('FB-NEW01', {
          receivedAt: '2026-11-23T00:00:00Z',
          title: 'New one',
          reporter: { id: 'u42', name: 'Ada', email: null },
          status: 'in_progress',
        }),
      ],
    })),
    inboxGet: vi.fn(async ({ hostId }: { hostId: string }) => ({ ok: true, item: detail(hostId) })),
    inboxImage: vi.fn(async ({ hostId, which }: { hostId: string; which: string }) => ({
      ok: true,
      hostId,
      which,
      dataUrl: `data:image/png;base64,${which}`,
    })),
    inboxSetStatus: vi.fn(async ({ hostId, status }: { hostId: string; status: SiteFeedbackItemMeta['status'] }) => ({
      ok: true,
      meta: meta(hostId, { status }),
    })),
    inboxRemove: vi.fn(async ({ hostId }: { hostId: string }) => ({ ok: true, hostId })),
  }
  ;(window as unknown as { api: unknown }).api = { siteFeedback: sf }
})

const q = (el: ParentNode, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const qa = (el: ParentNode, id: string) => Array.from(el.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[]

function changeSelect(sel: HTMLSelectElement, value: string) {
  act(() => {
    sel.value = value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function openRow(el: HTMLElement, hostId: string) {
  const row = el.querySelector(`[data-testid="site-feedback-row"][data-host-id="${hostId}"]`) as HTMLButtonElement
  act(() => row.click())
  await flush()
}

describe('ProjectFeedbackInbox list', () => {
  it('shows type dot, title, reporter, host, age and status, newest first', async () => {
    const el = await mount()
    const rows = qa(el, 'site-feedback-row')
    expect(rows.map((r) => r.getAttribute('data-host-id'))).toEqual(['FB-NEW01', 'FB-OLD01'])
    const [first, second] = rows
    expect(q(first, 'site-feedback-type-dot')?.getAttribute('data-type')).toBe('bug')
    expect(q(second, 'site-feedback-type-dot')?.getAttribute('data-type')).toBe('feature')
    expect(q(first, 'site-feedback-row-title')?.textContent).toBe('New one')
    expect(q(first, 'site-feedback-row-reporter')?.textContent).toBe('Ada · claimed by site')
    expect(q(second, 'site-feedback-row-reporter')?.textContent).toBe('Anonymous')
    expect(q(first, 'site-feedback-row-host')?.textContent).toBe('shop.example.com')
    expect(q(first, 'site-feedback-row-age')?.textContent).toMatch(/ago|just now/)
    expect(q(first, 'site-feedback-row-status')?.textContent).toBe('In progress')
    expect(q(second, 'site-feedback-row-status')?.textContent).toBe('Open')
  })

  it('the status filter reloads the list for that status, and All clears it', async () => {
    const el = await mount()
    const sel = q(el, 'site-feedback-filter') as HTMLSelectElement
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(['', 'open', 'in_progress', 'resolved', 'wontfix'])
    sf.inboxList.mockResolvedValueOnce({ ok: true, items: [item('FB-RES01', { status: 'resolved', title: 'Done one' })] })
    changeSelect(sel, 'resolved')
    await flush()
    expect(sf.inboxList).toHaveBeenLastCalledWith({ cwd: CWD, status: 'resolved' })
    expect(qa(el, 'site-feedback-row').map((r) => r.getAttribute('data-host-id'))).toEqual(['FB-RES01'])
    expect((q(el, 'site-feedback-filter') as HTMLSelectElement).value).toBe('resolved')
    changeSelect(q(el, 'site-feedback-filter') as HTMLSelectElement, '')
    await flush()
    expect(sf.inboxList).toHaveBeenLastCalledWith({ cwd: CWD })
    expect(qa(el, 'site-feedback-row')).toHaveLength(2)
  })
})

describe('ProjectFeedbackInbox detail', () => {
  it('shows the annotated screenshot (toggle to raw), marks, details, page, viewport, console and network', async () => {
    const el = await mount()
    await openRow(el, 'FB-NEW01')
    expect(sf.inboxGet).toHaveBeenCalledWith({ cwd: CWD, hostId: 'FB-NEW01' })
    const d = q(el, 'site-feedback-detail')!
    expect(q(d, 'site-feedback-detail-title')?.textContent).toBe('Checkout button broken')

    const img = q(d, 'site-feedback-screenshot-img') as HTMLImageElement
    expect(img.getAttribute('data-which')).toBe('annotated')
    expect(img.getAttribute('src')).toBe('data:image/png;base64,annotated')
    expect(sf.inboxImage).toHaveBeenCalledWith({ cwd: CWD, hostId: 'FB-NEW01', which: 'annotated' })
    act(() => (q(d, 'site-feedback-shot-screenshot') as HTMLButtonElement).click())
    await flush()
    expect(sf.inboxImage).toHaveBeenLastCalledWith({ cwd: CWD, hostId: 'FB-NEW01', which: 'screenshot' })
    expect(q(d, 'site-feedback-screenshot-img')?.getAttribute('src')).toBe('data:image/png;base64,screenshot')

    const marks = qa(d, 'site-feedback-mark').map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent))
    expect(marks).toEqual([
      ['1', 'pin', '—', 'Here'],
      ['2', 'element', 'button#pay.primary', 'This button'],
      ['—', 'arrow', '—', ''],
    ])
    expect(q(d, 'site-feedback-details')?.textContent).toBe('Clicking <b>Pay</b> does nothing\nsecond line')
    expect(q(d, 'site-feedback-details')?.querySelector('b')).toBeNull()
    const url = q(d, 'site-feedback-page-url')!
    expect(url.textContent).toBe('https://shop.example.com/checkout?step=2')
    expect(d.querySelector('a')).toBeNull()
    expect(q(d, 'site-feedback-viewport')?.textContent).toContain('1280 × 720 @ 2x')

    const con = q(d, 'site-feedback-console') as HTMLDetailsElement
    expect(con.tagName).toBe('DETAILS')
    expect(con.open).toBe(false)
    expect(con.querySelector('summary')?.textContent).toBe('Console errors (1)')
    expect(q(con, 'site-feedback-console-entry')?.textContent).toContain('TypeError: x is undefined ×3')
    const net = q(d, 'site-feedback-network') as HTMLDetailsElement
    expect(net.tagName).toBe('DETAILS')
    expect(net.querySelector('summary')?.textContent).toBe('Failed requests (1)')
    expect(q(net, 'site-feedback-network-entry')?.textContent).toBe('POST https://api.example.com/pay → 500 · 120 ms')
  })

  it('says when console and network were not captured', async () => {
    sf.inboxGet.mockResolvedValueOnce({ ok: true, item: detail('FB-NEW01', report({ console: null, network: null })) })
    const el = await mount()
    await openRow(el, 'FB-NEW01')
    expect(q(el, 'site-feedback-console')?.textContent).toContain('Console was not captured')
    expect(q(el, 'site-feedback-network')?.textContent).toContain('Network was not captured')
  })

  it('sets status to each of open, in_progress, resolved and wontfix', async () => {
    const el = await mount()
    await openRow(el, 'FB-NEW01')
    const sel = () => q(el, 'site-feedback-detail-status') as HTMLSelectElement
    expect(Array.from(sel().options).map((o) => o.value)).toEqual(['open', 'in_progress', 'resolved', 'wontfix'])
    for (const status of ['resolved', 'wontfix', 'in_progress', 'open'] as const) {
      changeSelect(sel(), status)
      await flush()
      expect(sf.inboxSetStatus).toHaveBeenLastCalledWith({ cwd: CWD, hostId: 'FB-NEW01', status })
      expect(sel().value).toBe(status)
    }
    changeSelect(sel(), 'resolved')
    await flush()
    const row = el.querySelector('[data-testid="site-feedback-row"][data-host-id="FB-NEW01"]')!
    expect(q(row, 'site-feedback-row-status')?.textContent).toBe('Resolved')
  })

  it('removes a report only after the confirm, and cancel keeps it', async () => {
    const el = await mount()
    await openRow(el, 'FB-NEW01')
    act(() => (q(el, 'site-feedback-remove') as HTMLButtonElement).click())
    expect(sf.inboxRemove).not.toHaveBeenCalled()
    act(() => (q(el, 'site-feedback-remove-cancel') as HTMLButtonElement).click())
    expect(q(el, 'site-feedback-remove-confirm')).toBeNull()
    expect(sf.inboxRemove).not.toHaveBeenCalled()

    act(() => (q(el, 'site-feedback-remove') as HTMLButtonElement).click())
    act(() => (q(el, 'site-feedback-remove-confirm') as HTMLButtonElement).click())
    await flush()
    expect(sf.inboxRemove).toHaveBeenCalledWith({ cwd: CWD, hostId: 'FB-NEW01' })
    expect(q(el, 'site-feedback-detail')).toBeNull()
    expect(qa(el, 'site-feedback-row').map((r) => r.getAttribute('data-host-id'))).toEqual(['FB-OLD01'])
  })
})

describe('ProjectFeedbackInbox plain text', () => {
  const evil = '<script>window.__pwned = 1</script><img src=x onerror="window.__pwned=2">'

  it('renders a script tag in a title as text in the list and the detail', async () => {
    sf.inboxList.mockResolvedValueOnce({ ok: true, items: [item('FB-EVIL1', { title: evil })] })
    sf.inboxGet.mockResolvedValueOnce({ ok: true, item: detail('FB-EVIL1', report({ title: evil, details: evil })) })
    const el = await mount()
    expect(q(el, 'site-feedback-row-title')?.textContent).toBe(evil)
    await openRow(el, 'FB-EVIL1')
    expect(q(el, 'site-feedback-detail-title')?.textContent).toBe(evil)
    expect(el.querySelector('script')).toBeNull()
    expect(el.querySelector('img[src="x"]')).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })
})
