// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { SettingsTelemetry } from '../SettingsTelemetry'

/**
 * PRD 1142 — Product telemetry consent UX + inspector added to the
 * existing Settings > Telemetry sub-view alongside the unrelated OTEL
 * exporter section.
 */

function otelConfig() {
  return {
    enabled: false,
    endpoint: '',
    headers: '',
    serviceName: '',
    includeContent: false,
    schemaVersion: 1 as const,
  }
}

function telemetryConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    installId: 'install-uuid-1234',
    endpoint: 'https://bilko.run',
    noticeAckedAt: '2026-01-01T00:00:00.000Z',
    lastMachineReportAt: null,
    lastMachineReportVersion: '',
    lastDailyFlushAt: null,
    schemaVersion: 1 as const,
    ...overrides,
  }
}

function telemetryStatus(overrides: Record<string, unknown> = {}) {
  return {
    pendingCount: 2,
    sentCount: 10,
    dedupedAppends: 1,
    evictedCount: 0,
    disabledForProcess: false,
    consecutiveFailures: 0,
    backoffUntil: 0,
    profileBuildCount: 1,
    lastError: null,
    lastFlushAt: Date.now(),
    lastFlushReason: 'boot',
    backlog: {
      projectsScanned: 1,
      filesScanned: 1,
      linesEnqueued: 3,
      linesConfirmed: 3,
      linesSkipped: 0,
      filesCompleted: 1,
      watermarksRewound: 0,
      reason: 'boot',
      ranAt: new Date().toISOString(),
    },
    ...overrides,
  }
}

function installWindowApiMock(opts: { telemetryCfg?: Record<string, unknown>; telemetryStatusOverrides?: Record<string, unknown> } = {}) {
  const getConfig = vi.fn().mockResolvedValue(telemetryConfig(opts.telemetryCfg))
  const setConfig = vi.fn(async (cfg: Record<string, unknown>) => ({
    ok: true,
    config: cfg,
    status: telemetryStatus(opts.telemetryStatusOverrides),
  }))
  const status = vi.fn().mockResolvedValue(telemetryStatus(opts.telemetryStatusOverrides))
  const configPath = vi.fn().mockResolvedValue('/home/x/.config/session-manager/telemetry.json')
  const recentRecords = vi.fn().mockResolvedValue([{ recordId: 'r1', channel: 'error', wire: { name: 'X' } }])
  const flushNow = vi.fn().mockResolvedValue({ sent: ['r1'], failed: [], reason: 'manual' })

  ;(window as unknown as { api: unknown }).api = {
    otel: {
      getConfig: vi.fn().mockResolvedValue(otelConfig()),
      status: vi.fn().mockResolvedValue({ enabled: false, initialized: false, error: null, includeContent: false }),
      configPath: vi.fn().mockResolvedValue('/home/x/.config/session-manager/otel.json'),
      setConfig: vi.fn(),
    },
    telemetry: { getConfig, setConfig, status, configPath, recentRecords, flushNow },
  }
  return { getConfig, setConfig, status, configPath, recentRecords, flushNow }
}

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
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

describe('SettingsTelemetry — product telemetry section (PRD 1142)', () => {
  beforeEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
  })

  it('renders both sections retitled, with no email/name/user/account input anywhere in the product telemetry section', async () => {
    installWindowApiMock()
    const el = mount(createElement(SettingsTelemetry))
    await act(async () => { await flushAsync() })

    expect(el.textContent).toContain('OpenTelemetry export')
    expect(el.textContent).toContain('Product telemetry (bilko.run)')

    const section = el.querySelector('[data-testid="product-telemetry-section"]') as HTMLElement
    expect(section).toBeTruthy()
    const inputs = Array.from(section.querySelectorAll('input, textarea'))
    for (const input of inputs) {
      const name = input.getAttribute('name') || ''
      const label = input.getAttribute('aria-label') || input.getAttribute('placeholder') || ''
      expect(`${name} ${label}`).not.toMatch(/email|name|user|account/i)
    }
  })

  it('shows the anonymous install id, endpoint, and cadence in plain words', async () => {
    installWindowApiMock({ telemetryCfg: { installId: 'abc-123', endpoint: 'https://bilko.run' } })
    const el = mount(createElement(SettingsTelemetry))
    await act(async () => { await flushAsync() })

    const installIdInput = el.querySelector('[aria-label="Anonymous install identifier"]') as HTMLInputElement
    expect(installIdInput.value).toBe('abc-123')
    expect(el.textContent).toContain('https://bilko.run')
    expect(el.textContent).toContain('on start-up, after an update, and once a day')
  })

  it('shows queue/dedup/eviction counts and the backlog drain summary including watermarksRewound', async () => {
    installWindowApiMock({
      telemetryStatusOverrides: {
        pendingCount: 7,
        dedupedAppends: 4,
        evictedCount: 2,
        backlog: {
          projectsScanned: 2,
          filesScanned: 3,
          linesEnqueued: 9,
          linesConfirmed: 8,
          linesSkipped: 0,
          filesCompleted: 2,
          watermarksRewound: 5,
          reason: 'version-change',
          ranAt: new Date().toISOString(),
        },
      },
    })
    const el = mount(createElement(SettingsTelemetry))
    await act(async () => { await flushAsync() })

    expect(el.textContent).toContain('7')
    expect(el.textContent).toContain('4')
    expect(el.textContent).toContain('2')
    expect(el.textContent).toMatch(/5 watermarks rewound/)
  })

  it('shows the last error from status when present', async () => {
    installWindowApiMock({
      telemetryStatusOverrides: { lastError: { status: 500, message: 'HTTP 500', at: Date.now() } },
    })
    const el = mount(createElement(SettingsTelemetry))
    await act(async () => { await flushAsync() })
    expect(el.textContent).toContain('HTTP 500')
  })

  it('does not show the first-run notice once noticeAckedAt is set', async () => {
    installWindowApiMock({ telemetryCfg: { noticeAckedAt: '2026-01-01T00:00:00.000Z' } })
    const el = mount(createElement(SettingsTelemetry))
    await act(async () => { await flushAsync() })
    expect(el.querySelector('[data-testid="telemetry-first-run-notice"]')).toBeNull()
  })

  it('shows the first-run notice with OK and Turn off while noticeAckedAt is null, and OK persists ack without disabling', async () => {
    const { setConfig } = installWindowApiMock({ telemetryCfg: { noticeAckedAt: null, enabled: true } })
    const el = mount(createElement(SettingsTelemetry))
    await act(async () => { await flushAsync() })

    const notice = el.querySelector('[data-testid="telemetry-first-run-notice"]') as HTMLElement
    expect(notice).toBeTruthy()
    const okBtn = Array.from(notice.querySelectorAll('button')).find((b) => b.textContent === 'OK') as HTMLButtonElement
    await act(async () => {
      okBtn.click()
      await flushAsync()
    })
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, noticeAckedAt: expect.any(String) }))
  })

  it('"Turn off" in the first-run notice persists ack and disables', async () => {
    const { setConfig } = installWindowApiMock({ telemetryCfg: { noticeAckedAt: null, enabled: true } })
    const el = mount(createElement(SettingsTelemetry))
    await act(async () => { await flushAsync() })

    const notice = el.querySelector('[data-testid="telemetry-first-run-notice"]') as HTMLElement
    const offBtn = Array.from(notice.querySelectorAll('button')).find((b) => b.textContent === 'Turn off') as HTMLButtonElement
    await act(async () => {
      offBtn.click()
      await flushAsync()
    })
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, noticeAckedAt: expect.any(String) }))
  })

  it('the on/off toggle persists via setConfig', async () => {
    const { setConfig } = installWindowApiMock({ telemetryCfg: { enabled: true } })
    const el = mount(createElement(SettingsTelemetry))
    await act(async () => { await flushAsync() })

    const section = el.querySelector('[data-testid="product-telemetry-section"]') as HTMLElement
    const toggle = section.querySelector('button[role="switch"]') as HTMLButtonElement
    await act(async () => {
      toggle.click()
      await flushAsync()
    })
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
  })

  it('"Send now" calls flushNow and reflects the result', async () => {
    const { flushNow } = installWindowApiMock()
    const el = mount(createElement(SettingsTelemetry))
    await act(async () => { await flushAsync() })

    const sendBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Send now') as HTMLButtonElement
    await act(async () => {
      sendBtn.click()
      await flushAsync()
    })
    expect(flushNow).toHaveBeenCalled()
    expect(el.textContent).toMatch(/sent 1, failed 0/)
  })

  it('the inspector renders the last records as formatted JSON via recentRecords()', async () => {
    const { recentRecords } = installWindowApiMock()
    const el = mount(createElement(SettingsTelemetry))
    await act(async () => { await flushAsync() })

    const inspectBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Inspect last records')) as HTMLButtonElement
    await act(async () => {
      inspectBtn.click()
      await flushAsync()
    })
    expect(recentRecords).toHaveBeenCalled()
    const pre = el.querySelector('[data-testid="telemetry-inspector-json"]') as HTMLElement
    expect(pre.textContent).toContain('"recordId": "r1"')
  })
})
