// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ProjectFeedbackInbox } from '../ProjectFeedbackInbox'
import { useSiteFeedback } from '../../../../state/siteFeedback'
import { usePromptSessions } from '../../../../state/promptSessions'
import { useToast } from '../../../../state/toast'

vi.mock('../../../../lib/launchSession', () => ({ resolvePersonaBody: vi.fn(async () => null) }))
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
  const linkedEpic: Record<string, string> = {}
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
      meta: meta(hostId, { status, epicId: linkedEpic[hostId] ?? null }),
    })),
    inboxRemove: vi.fn(async ({ hostId }: { hostId: string }) => ({ ok: true, hostId })),
    inboxLinkEpic: vi.fn(async ({ hostId, epicId }: { hostId: string; epicId: string }) => {
      linkedEpic[hostId] = epicId
      return { ok: true, meta: meta(hostId, { epicId }) }
    }),
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
    expect(q(first, 'site-feedback-row-reporter')?.textContent).toBe('u42 · claimed by site · Ada (name as given by the site)')
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

describe('ProjectFeedbackInbox reporter badge', () => {
  const rows = (verified: Array<boolean | null | undefined>) =>
    sf.inboxList.mockResolvedValueOnce({
      ok: true,
      items: verified.map((v, i) =>
        item(`FB-V000${i}`, {
          receivedAt: `2026-11-2${i}T00:00:00Z`,
          reporter: { id: `u${i}`, name: `R${i}`, email: null },
          reporterVerified: v,
        }),
      ),
    })

  it('shows Verified for true, claimed by site for null/absent and signature did not match for false', async () => {
    rows([true, null, false, undefined])
    const el = await mount()
    const byHost = (h: string) => el.querySelector(`[data-testid="site-feedback-row"][data-host-id="${h}"]`) as HTMLElement
    const badge = (h: string) => q(byHost(h), 'site-feedback-reporter-badge')!
    expect(badge('FB-V0000').textContent).toBe('Verified')
    expect(badge('FB-V0000').getAttribute('data-verified')).toBe('verified')
    expect(badge('FB-V0001').textContent).toBe('claimed by site')
    expect(badge('FB-V0001').getAttribute('data-verified')).toBe('claimed')
    expect(badge('FB-V0002').textContent).toBe('signature did not match')
    expect(badge('FB-V0002').getAttribute('data-verified')).toBe('mismatch')
    expect(badge('FB-V0003').textContent).toBe('claimed by site')
    expect(q(byHost('FB-V0000'), 'site-feedback-row-reporter')?.textContent).toBe('u0 · Verified · R0 (name as given by the site)')
  })

  it('puts Verified next to the signed id and email only, never next to the name', async () => {
    sf.inboxList.mockResolvedValueOnce({
      ok: true,
      items: [
        item('FB-S0001', { reporter: { id: 'u7', name: 'Maya Chen', email: 'maya@lumenstays.com' }, reporterVerified: true }),
        item('FB-S0002', { reporter: { id: 'u8', name: null, email: null }, reporterVerified: true }),
      ],
    })
    const el = await mount()
    const row = (h: string) => el.querySelector(`[data-testid="site-feedback-row"][data-host-id="${h}"]`) as HTMLElement
    const signed = q(row('FB-S0001'), 'site-feedback-reporter-signed')!
    expect(signed.textContent).toBe('u7 · maya@lumenstays.com')
    expect(signed.nextSibling?.textContent).toBe(' · ')
    expect(q(row('FB-S0001'), 'site-feedback-reporter-badge')?.previousSibling?.previousSibling).toBe(signed)
    const name = q(row('FB-S0001'), 'site-feedback-reporter-name')!
    expect(name.textContent).toBe('Maya Chen (name as given by the site)')
    expect(name.contains(q(row('FB-S0001'), 'site-feedback-reporter-badge'))).toBe(false)
    expect(q(row('FB-S0001'), 'site-feedback-row-reporter')?.textContent).toBe(
      'u7 · maya@lumenstays.com · Verified · Maya Chen (name as given by the site)',
    )
    expect(q(row('FB-S0002'), 'site-feedback-reporter-name')).toBeNull()
    expect(q(row('FB-S0002'), 'site-feedback-row-reporter')?.textContent).toBe('u8 · Verified')
  })

  it('an anonymous report shows no badge', async () => {
    const el = await mount()
    const anon = el.querySelector('[data-testid="site-feedback-row"][data-host-id="FB-OLD01"]') as HTMLElement
    expect(q(anon, 'site-feedback-reporter-badge')).toBeNull()
  })

  it('the detail shows the badge from meta.reporterVerified', async () => {
    sf.inboxGet.mockResolvedValueOnce({ ok: true, item: { ...detail('FB-NEW01'), meta: meta('FB-NEW01', { reporterVerified: true }) } })
    const el = await mount()
    await openRow(el, 'FB-NEW01')
    const d = q(el, 'site-feedback-detail')!
    expect(q(d, 'site-feedback-reporter-badge')?.textContent).toBe('Verified')
    expect(d.textContent).toContain('u42 · Verified · Ada (name as given by the site)')
  })

  it('the detail shows signature did not match for false', async () => {
    sf.inboxGet.mockResolvedValueOnce({ ok: true, item: { ...detail('FB-NEW01'), meta: meta('FB-NEW01', { reporterVerified: false }) } })
    const el = await mount()
    await openRow(el, 'FB-NEW01')
    expect(q(q(el, 'site-feedback-detail')!, 'site-feedback-reporter-badge')?.textContent).toBe('signature did not match')
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

describe('ProjectFeedbackInbox Open as Epic', () => {
  let createPromptSession: ReturnType<typeof vi.fn>
  let show: ReturnType<typeof vi.fn>
  const realCreate = usePromptSessions.getState().createPromptSession
  const realShow = useToast.getState().show

  beforeEach(() => {
    let n = 0
    createPromptSession = vi.fn(async () => ({ id: `epic-${++n}` }))
    usePromptSessions.setState({ createPromptSession } as never)
    show = vi.fn()
    useToast.setState({ show } as never)
  })
  afterEach(() => {
    usePromptSessions.setState({ createPromptSession: realCreate } as never)
    useToast.setState({ show: realShow } as never)
  })

  const openBtn = (el: HTMLElement) => q(el, 'site-feedback-open-epic') as HTMLButtonElement

  it('creates a proposed Epic, links it, sets in_progress, then disables the button', async () => {
    const el = await mount()
    await openRow(el, 'FB-NEW01')
    expect(openBtn(el).disabled).toBe(false)
    act(() => openBtn(el).click())
    await flush()
    expect(createPromptSession).toHaveBeenCalledTimes(1)
    const [cwd, goalText, tag, , agent] = createPromptSession.mock.calls[0]
    expect(cwd).toBe(CWD)
    expect(String(goalText).startsWith('[Site bug] “Checkout button broken”')).toBe(true)
    expect(tag).toBe('bug')
    expect(agent).toBe('architect')
    expect(sf.inboxLinkEpic).toHaveBeenCalledWith({ cwd: CWD, hostId: 'FB-NEW01', epicId: 'epic-1' })
    expect(sf.inboxSetStatus).toHaveBeenLastCalledWith({ cwd: CWD, hostId: 'FB-NEW01', status: 'in_progress' })
    expect(sf.inboxLinkEpic.mock.invocationCallOrder[0]).toBeLessThan(sf.inboxSetStatus.mock.invocationCallOrder[0])
    expect(openBtn(el).disabled).toBe(true)
    expect(q(el, 'site-feedback-retry-link')).toBeNull()
    act(() => openBtn(el).click())
    await flush()
    expect(createPromptSession).toHaveBeenCalledTimes(1)
  })

  it('is disabled when the report already has a linked Epic', async () => {
    sf.inboxGet.mockResolvedValueOnce({ ok: true, item: { ...detail('FB-NEW01'), meta: meta('FB-NEW01', { epicId: 'old' }) } })
    const el = await mount()
    await openRow(el, 'FB-NEW01')
    expect(openBtn(el).disabled).toBe(true)
    act(() => openBtn(el).click())
    await flush()
    expect(createPromptSession).not.toHaveBeenCalled()
  })

  it('is disabled while a press is in flight and a double press mints once', async () => {
    let release!: (v: { id: string }) => void
    createPromptSession.mockImplementationOnce(() => new Promise((r) => (release = r)))
    const el = await mount()
    await openRow(el, 'FB-NEW01')
    act(() => {
      openBtn(el).click()
      openBtn(el).click()
    })
    await flush()
    expect(openBtn(el).disabled).toBe(true)
    await act(async () => release({ id: 'epic-x' }))
    await flush()
    expect(createPromptSession).toHaveBeenCalledTimes(1)
    expect(sf.inboxLinkEpic).toHaveBeenCalledTimes(1)
  })

  it('a failed link toasts an error and Retry link re-links the same Epic, minting exactly one', async () => {
    sf.inboxLinkEpic.mockResolvedValueOnce({ ok: false, error: 'io', message: 'disk full' })
    const el = await mount()
    await openRow(el, 'FB-NEW01')
    act(() => openBtn(el).click())
    await flush()
    expect(createPromptSession).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledWith('error', expect.stringContaining('disk full'))
    expect(sf.inboxSetStatus).not.toHaveBeenCalled()
    expect(openBtn(el).disabled).toBe(true)
    act(() => openBtn(el).click())
    await flush()
    expect(createPromptSession).toHaveBeenCalledTimes(1)

    const retry = q(el, 'site-feedback-retry-link') as HTMLButtonElement
    expect(retry.textContent).toBe('Retry link')
    act(() => retry.click())
    await flush()
    expect(createPromptSession).toHaveBeenCalledTimes(1)
    expect(sf.inboxLinkEpic).toHaveBeenCalledTimes(2)
    expect(sf.inboxLinkEpic).toHaveBeenLastCalledWith({ cwd: CWD, hostId: 'FB-NEW01', epicId: 'epic-1' })
    expect(sf.inboxSetStatus).toHaveBeenLastCalledWith({ cwd: CWD, hostId: 'FB-NEW01', status: 'in_progress' })
    expect(q(el, 'site-feedback-retry-link')).toBeNull()
    expect(openBtn(el).disabled).toBe(true)
  })

  it('fail-link, close, reopen, retry: the minted Epic survives the close and is linked, minting exactly one', async () => {
    sf.inboxLinkEpic.mockResolvedValueOnce({ ok: false, error: 'io', message: 'disk full' })
    const el = await mount()
    await openRow(el, 'FB-NEW01')
    act(() => openBtn(el).click())
    await flush()
    expect(createPromptSession).toHaveBeenCalledTimes(1)
    expect(q(el, 'site-feedback-retry-link')).not.toBeNull()

    act(() => q(el, 'site-feedback-detail-close')!.click())
    await flush()
    expect(q(el, 'site-feedback-detail')).toBeNull()
    await openRow(el, 'FB-NEW01')

    expect(openBtn(el).disabled).toBe(true)
    act(() => openBtn(el).click())
    await flush()
    expect(createPromptSession).toHaveBeenCalledTimes(1)
    const retry = q(el, 'site-feedback-retry-link') as HTMLButtonElement
    expect(retry.textContent).toBe('Retry link')
    act(() => retry.click())
    await flush()
    expect(createPromptSession).toHaveBeenCalledTimes(1)
    expect(sf.inboxLinkEpic).toHaveBeenCalledTimes(2)
    expect(sf.inboxLinkEpic).toHaveBeenLastCalledWith({ cwd: CWD, hostId: 'FB-NEW01', epicId: 'epic-1' })
    expect(q(el, 'site-feedback-retry-link')).toBeNull()
  })
})
