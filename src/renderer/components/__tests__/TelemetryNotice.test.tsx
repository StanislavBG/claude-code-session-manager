// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TelemetryNotice } from '../TelemetryNotice'
import type { TelemetryConfig } from '../../../preload/api'

const base = { enabled: true, installId: 'x', noticeAckedAt: null } as unknown as TelemetryConfig
const setConfig = vi.fn()
let host: HTMLDivElement
let root: Root

function mount(cfg: TelemetryConfig) {
  act(() => { root.render(createElement(TelemetryNotice, { cfg })) })
}

async function click(label: string) {
  const btn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label)!
  await act(async () => { btn.click() })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  setConfig.mockReset()
  setConfig.mockImplementation(async (c: TelemetryConfig) => ({ config: c, status: {} }))
  ;(window as unknown as { api: unknown }).api = { telemetry: { setConfig } }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('TelemetryNotice', () => {
  it('renders when noticeAckedAt is null', () => {
    mount(base)
    expect(host.querySelector('[data-testid="telemetry-first-run-notice"]')).not.toBeNull()
  })

  it('is hidden when noticeAckedAt is set', () => {
    mount({ ...base, noticeAckedAt: '2026-01-01T00:00:00.000Z' })
    expect(host.querySelector('[data-testid="telemetry-first-run-notice"]')).toBeNull()
  })

  it('OK saves noticeAckedAt and keeps enabled', async () => {
    mount(base)
    await click('OK')
    expect(setConfig).toHaveBeenCalledTimes(1)
    const saved = setConfig.mock.calls[0][0]
    expect(typeof saved.noticeAckedAt).toBe('string')
    expect(saved.enabled).toBe(true)
  })

  it('Turn off saves enabled false', async () => {
    mount(base)
    await click('Turn off')
    expect(setConfig).toHaveBeenCalledTimes(1)
    const saved = setConfig.mock.calls[0][0]
    expect(saved.enabled).toBe(false)
    expect(typeof saved.noticeAckedAt).toBe('string')
  })
})
