// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { UsageCapControl } from '../UsageCapControl'
import { useScheduleState } from '../../../../state/scheduleState'
import { toast } from '../../../../state/toast'
import type { ScheduleStateSnapshot } from '../../../../../preload/api'

const api = { schedule: { setConfig: vi.fn() } }
let container: HTMLDivElement
let root: Root

function setSnapshot(over: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  useScheduleState.setState({
    snapshot: {
      config: { enabled: true, offsetMinutes: 0, defaultCwd: '/p', firePolicy: 'when-available', utilizationThreshold: 80, schemaVersion: 1, ...config },
      jobs: [], lastRunAt: null, nextReset: null, paused: null, utilization: 50, pollHealth: undefined,
      effectiveUtilizationThreshold: null,
      utilizationHold: null,
      ...over,
    } as unknown as ScheduleStateSnapshot,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  api.schedule.setConfig.mockResolvedValue({ ok: true, config: {} })
  ;(window as unknown as { api: unknown }).api = api
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useScheduleState.setState({ snapshot: null })
  delete (window as unknown as { api?: unknown }).api
})

async function render() {
  await act(async () => {
    root.render(createElement(UsageCapControl))
    await Promise.resolve(); await Promise.resolve()
  })
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`)

describe('UsageCapControl', () => {
  it('shows the saved pause-above value', async () => {
    setSnapshot()
    await render()
    expect(q('home-usage-cap')?.textContent).toContain('Automatic work pauses above 80%')
    expect(q('home-usage-cap-effective')).toBeNull()
    expect(q('home-usage-cap-held')).toBeNull()
  })

  it('defaults to 90 when no value is saved', async () => {
    setSnapshot({}, { utilizationThreshold: undefined })
    await render()
    expect(q('home-usage-cap-value-text')?.textContent).toBe('90%')
  })

  it('commits an edit through schedule.setConfig', async () => {
    setSnapshot()
    await render()
    await act(async () => { (q('home-usage-cap-value-text') as HTMLButtonElement).click() })
    const input = q('home-usage-cap-value') as HTMLInputElement
    expect(input).toBeTruthy()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '85')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve(); await Promise.resolve()
    })
    expect(api.schedule.setConfig).toHaveBeenCalledWith({ utilizationThreshold: 85 })
  })

  it('shows a toast error when saving fails', async () => {
    const spy = vi.spyOn(toast, 'error').mockImplementation(() => undefined as never)
    api.schedule.setConfig.mockRejectedValue(new Error('boom'))
    setSnapshot()
    await render()
    await act(async () => { (q('home-usage-cap-value-text') as HTMLButtonElement).click() })
    const input = q('home-usage-cap-value') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '70')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('boom'))
    spy.mockRestore()
  })

  it('shows the cap in force when it differs from the saved value', async () => {
    setSnapshot({ effectiveUtilizationThreshold: 94.2857 })
    await render()
    expect(q('home-usage-cap-effective')?.textContent).toBe(' · now 94.3%')
  })

  it('hides the effective hint when it equals the saved value', async () => {
    setSnapshot({ effectiveUtilizationThreshold: 80.02 })
    await render()
    expect(q('home-usage-cap-effective')).toBeNull()
  })

  it('shows Held now with the hold detail while usage holds automatic work', async () => {
    setSnapshot({
      utilization: 93,
      utilizationHold: { window: 'five_hour', percent: 93, threshold: 80, resetsAt: new Date(Date.now() + 60 * 60_000).toISOString() },
    })
    await render()
    const held = q('home-usage-cap-held')?.textContent ?? ''
    expect(held).toContain('Held now')
    expect(held).toContain('Session · 5h')
    expect(held).toContain('93% ≥ 80%')
    expect(held).toContain('resets in')
  })

  it('renders nothing when the snapshot is null', async () => {
    useScheduleState.setState({ snapshot: null })
    await render()
    expect(q('home-usage-cap')).toBeNull()
  })

  it('renders nothing when the fire policy is not when-available', async () => {
    setSnapshot({}, { firePolicy: 'manual' })
    await render()
    expect(q('home-usage-cap')).toBeNull()
  })
})
