// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ProjectFeedbackWidgetCard, validateWidgetForm } from '../ProjectFeedbackWidgetCard'
import { EMPTY_SITE_FEEDBACK, useSiteFeedback } from '../../../../state/siteFeedback'
import { useToast } from '../../../../state/toast'
import { useLayout } from '../../../../state/layout'
import type { SiteFeedbackWidget } from '../../../../../preload/api'

const CWD = '/home/me/Projects/three-winds'

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const qa = (el: HTMLElement, id: string) => Array.from(el.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[]

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const widget = (over: Partial<SiteFeedbackWidget> = {}): SiteFeedbackWidget => ({
  boxId: 'box1',
  projectCwd: CWD,
  fingerprint: 'fp1',
  createdAt: '2026-11-23T00:00:00Z',
  snippet: '<script src="https://bilko.run/w.js" data-box="box1"></script>',
  label: 'three-winds',
  allowedOrigins: ['https://threewinds.example'],
  state: 'open',
  pending: 2,
  hint: null,
  ...over,
})

function seed(over: Partial<typeof EMPTY_SITE_FEEDBACK> = {}) {
  useSiteFeedback.setState({ byCwd: { [CWD]: { ...EMPTY_SITE_FEEDBACK, ...over } } })
}

const errorToasts = () => useToast.getState().toasts.filter((t) => t.kind === 'error').map((t) => t.message)

let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  api = {
    widgetList: vi.fn(async () => ({ ok: true, widgets: [] })),
    widgetCreate: vi.fn(async () => ({ ok: true, boxId: 'box9', fingerprint: 'fp9', snippet: '<script data-box="box9"></script>' })),
    widgetUpdate: vi.fn(async () => ({ ok: true, widget: { boxId: 'box1', state: 'paused' } })),
    widgetDelete: vi.fn(async () => ({ ok: true, boxId: 'box1' })),
    writeText: vi.fn(async () => ({ ok: true })),
  }
  ;(window as unknown as { api: unknown }).api = {
    siteFeedback: { widgetList: api.widgetList, widgetCreate: api.widgetCreate, widgetUpdate: api.widgetUpdate, widgetDelete: api.widgetDelete },
    clipboard: { writeText: api.writeText },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  useSiteFeedback.setState({ byCwd: {} })
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
  vi.restoreAllMocks()
})

describe('ProjectFeedbackWidgetCard', () => {
  it('not linked: shows the link prompt and opens App Settings at Phone remote', () => {
    seed({ relayError: { ok: false, error: 'not_linked', message: 'not paired' } })
    const openPanel = vi.spyOn(useLayout.getState(), 'openPanel').mockImplementation(() => {})
    const el = mount(<ProjectFeedbackWidgetCard cwd={CWD} />)
    expect(q(el, 'feedback-widget-not-linked')?.textContent).toBe('Link this desktop to your bilko.run account first')
    expect(q(el, 'feedback-widget-create')).toBeNull()
    act(() => q(el, 'feedback-widget-open-pairing')!.click())
    expect(openPanel).toHaveBeenCalledWith('app-settings', 'remote')
  })

  it('create: label defaults to the folder name; success shows the snippet in a monospace box', async () => {
    seed()
    const el = mount(<ProjectFeedbackWidgetCard cwd={CWD} />)
    const labelInput = q(el, 'feedback-widget-label-input') as HTMLInputElement
    expect(labelInput.value).toBe('three-winds')
    setValue(q(el, 'feedback-widget-sites-input') as HTMLTextAreaElement, 'https://threewinds.example\n\nhttp://localhost:5173\n')
    act(() => q(el, 'feedback-widget-create-submit')!.click())
    await flush()
    expect(api.widgetCreate).toHaveBeenCalledWith({
      cwd: CWD,
      label: 'three-winds',
      allowedOrigins: ['https://threewinds.example', 'http://localhost:5173'],
    })
    const snip = q(el, 'feedback-widget-snippet')!
    expect(snip.textContent).toBe('<script data-box="box9"></script>')
    expect(snip.className).toContain('font-mono')
    expect(api.widgetList).toHaveBeenCalledWith({ cwd: CWD })
  })

  it('validation: rejects empty label, no sites, non-https sites and more than 10, inline, without calling the host', () => {
    seed()
    const el = mount(<ProjectFeedbackWidgetCard cwd={CWD} />)
    setValue(q(el, 'feedback-widget-label-input') as HTMLInputElement, '  ')
    act(() => q(el, 'feedback-widget-create-submit')!.click())
    expect(q(el, 'feedback-widget-label-error')).not.toBeNull()
    expect(q(el, 'feedback-widget-sites-error')?.textContent).toMatch(/at least one/i)
    setValue(q(el, 'feedback-widget-label-input') as HTMLInputElement, 'ok')
    setValue(q(el, 'feedback-widget-sites-input') as HTMLTextAreaElement, 'http://example.com')
    act(() => q(el, 'feedback-widget-create-submit')!.click())
    expect(q(el, 'feedback-widget-label-error')).toBeNull()
    expect(q(el, 'feedback-widget-sites-error')?.textContent).toContain('http://example.com')
    expect(api.widgetCreate).not.toHaveBeenCalled()

    expect(validateWidgetForm('x', 'http://127.0.0.1:8080').errors).toEqual({})
    expect(validateWidgetForm('x', 'ftp://a.com').errors.sites).toBeDefined()
    const eleven = Array.from({ length: 11 }, (_, i) => `https://s${i}.example`).join('\n')
    expect(validateWidgetForm('x', eleven).errors.sites).toMatch(/10/)
    expect(validateWidgetForm('x'.repeat(81), 'https://a.com').errors.label).toBeDefined()
  })

  it('rows show label, sites, state and pending; Copy snippet uses copyText', async () => {
    seed({ widgets: [widget(), widget({ boxId: 'box2', label: 'old', state: 'gone', pending: 0, allowedOrigins: [] })] })
    const el = mount(<ProjectFeedbackWidgetCard cwd={CWD} />)
    const rows = qa(el, 'feedback-widget-row')
    expect(rows).toHaveLength(2)
    expect(q(rows[0], 'feedback-widget-label')?.textContent).toBe('three-winds')
    expect(q(rows[0], 'feedback-widget-sites')?.textContent).toBe('https://threewinds.example')
    expect(q(rows[0], 'feedback-widget-state')?.textContent).toBe('open')
    expect(q(rows[0], 'feedback-widget-pending')?.textContent).toBe('2 pending')
    expect(q(rows[1], 'feedback-widget-state')?.textContent).toBe('gone')
    expect(q(rows[1], 'feedback-widget-toggle')).toBeNull()
    act(() => q(rows[0], 'feedback-widget-copy')!.click())
    await flush()
    expect(api.writeText).toHaveBeenCalledWith(widget().snippet)
  })

  it('pause then resume calls widgetUpdate with the next state', async () => {
    seed({ widgets: [widget()] })
    const el = mount(<ProjectFeedbackWidgetCard cwd={CWD} />)
    const toggle = () => q(el, 'feedback-widget-toggle')!
    expect(toggle().textContent).toBe('Pause')
    act(() => toggle().click())
    await flush()
    expect(api.widgetUpdate).toHaveBeenCalledWith({ boxId: 'box1', state: 'paused' })
    expect(q(el, 'feedback-widget-state')?.textContent).toBe('paused')
    expect(toggle().textContent).toBe('Resume')
    api.widgetUpdate.mockResolvedValueOnce({ ok: true, widget: { boxId: 'box1', state: 'open' } })
    act(() => toggle().click())
    await flush()
    expect(api.widgetUpdate).toHaveBeenLastCalledWith({ boxId: 'box1', state: 'open' })
  })

  it('delete asks for a confirm first; cancel keeps it, confirm removes it', async () => {
    seed({ widgets: [widget()] })
    const el = mount(<ProjectFeedbackWidgetCard cwd={CWD} />)
    act(() => q(el, 'feedback-widget-delete')!.click())
    expect(api.widgetDelete).not.toHaveBeenCalled()
    act(() => q(el, 'feedback-widget-delete-cancel')!.click())
    expect(q(el, 'feedback-widget-delete-confirm')).toBeNull()
    act(() => q(el, 'feedback-widget-delete')!.click())
    act(() => q(el, 'feedback-widget-delete-confirm')!.click())
    await flush()
    expect(api.widgetDelete).toHaveBeenCalledWith({ boxId: 'box1' })
    expect(qa(el, 'feedback-widget-row')).toHaveLength(0)
  })

  it.each([
    ['not_enabled', 'Website feedback is not enabled for this bilko.run account yet'],
    ['box_limit_reached', 'This bilko.run account already has the most feedback widgets it may have - delete one first'],
    ['rate_limited', 'bilko.run is rate limiting these requests - wait a minute and try again'],
  ])('host error %s shows as an error toast with the service explanation', async (code, message) => {
    seed()
    api.widgetCreate.mockResolvedValueOnce({ ok: false, error: code, message })
    const el = mount(<ProjectFeedbackWidgetCard cwd={CWD} />)
    setValue(q(el, 'feedback-widget-sites-input') as HTMLTextAreaElement, 'https://a.example')
    act(() => q(el, 'feedback-widget-create-submit')!.click())
    await flush()
    expect(errorToasts()).toEqual([message])
    expect(q(el, 'feedback-widget-snippet')).toBeNull()
  })

  it('a not_linked create failure swaps in the link prompt', async () => {
    seed()
    api.widgetCreate.mockResolvedValueOnce({ ok: false, error: 'not_linked', message: 'not paired' })
    const el = mount(<ProjectFeedbackWidgetCard cwd={CWD} />)
    setValue(q(el, 'feedback-widget-sites-input') as HTMLTextAreaElement, 'https://a.example')
    act(() => q(el, 'feedback-widget-create-submit')!.click())
    await flush()
    expect(q(el, 'feedback-widget-not-linked')).not.toBeNull()
  })
})
