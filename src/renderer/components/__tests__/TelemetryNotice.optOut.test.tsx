// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { TelemetryNotice } from '../TelemetryNotice'

const base = {
  installId: 'x', endpoint: 'http://e', noticeAckedAt: null, lastDailyFlushAt: null,
}

describe('TelemetryNotice ack re-reads config', () => {
  it('keeps a Settings opt-out when OK is clicked on a stale banner', async () => {
    const fresh = { ...base, enabled: false, lastDailyFlushAt: '2026-01-01T00:00:00Z' }
    const getConfig = vi.fn().mockResolvedValue(fresh)
    const setConfig = vi.fn().mockResolvedValue({ config: fresh, status: {} })
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    ;(window as any).api = { telemetry: { getConfig, setConfig } }

    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = createRoot(el)
    await act(async () => {
      root.render(createElement(TelemetryNotice, { cfg: { ...base, enabled: true } as any }))
    })
    const ok = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'OK')!
    await act(async () => { ok.click() })

    expect(getConfig).toHaveBeenCalled()
    expect(setConfig).toHaveBeenCalledTimes(1)
    const sent = setConfig.mock.calls[0][0]
    expect(sent.enabled).toBe(false)
    expect(sent.lastDailyFlushAt).toBe('2026-01-01T00:00:00Z')
    expect(sent.noticeAckedAt).toBeTruthy()
    await act(async () => { root.unmount() })
  })
})
