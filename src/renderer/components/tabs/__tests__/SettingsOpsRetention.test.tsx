// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { SettingsOpsRetention } from '../SettingsOpsRetention'
import { useToast } from '../../../state/toast'

const SETTINGS = {
  runLogs: { maxAgeDays: 14, keepPerSlug: 3 },
  runsArchiveDays: 30,
  auditLogMonths: 6,
  reservedMarkersKeep: 100,
  archivedTranscripts: { mode: 'forever' },
}
const PREVIEW = {
  runLogs: { files: 4000, bytes: 2.5 * 1024 ** 3 },
  runsArchive: { entries: 100, bytes: 0.4 * 1024 ** 3 },
  tmp: { files: 0, bytes: 0 },
}

let host: HTMLDivElement
let root: Root
let ops: Record<string, ReturnType<typeof vi.fn>>

async function mount(over: Record<string, unknown> = {}) {
  ops = {
    get: vi.fn().mockResolvedValue(SETTINGS),
    set: vi.fn().mockResolvedValue({ ...SETTINGS, runsArchiveDays: 3650 }),
    preview: vi.fn().mockResolvedValue(PREVIEW),
    ...over,
  }
  ;(window as unknown as { api: unknown }).api = { opsRetention: ops }
  await act(async () => {
    root.render(createElement(SettingsOpsRetention))
  })
  await act(async () => {})
}

async function edit(testid: string, value: string) {
  const input = host.querySelector(`[data-testid="${testid}"]`) as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
  await act(async () => {})
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useToast.setState({ toasts: [] } as never)
})

describe('SettingsOpsRetention', () => {
  it('renders defaults from the api', async () => {
    await mount()
    expect((host.querySelector('[data-testid="ops-retention-maxAgeDays"]') as HTMLInputElement).value).toBe('14')
    expect((host.querySelector('[data-testid="ops-retention-auditLogMonths"]') as HTMLInputElement).value).toBe('6')
    expect(host.textContent).toContain('Archived transcripts: kept forever')
  })

  it('shows human-readable preview and the daily-sweep notice', async () => {
    await mount()
    const text = host.querySelector('[data-testid="ops-retention-preview"]')!.textContent!
    expect(text).toContain('2.5 GB in 4,000 files')
    expect(text).toContain('Nothing is deleted until the daily sweep runs')
  })

  it('saves the clamped number and re-runs preview', async () => {
    await mount()
    await edit('ops-retention-runsArchiveDays', '99999')
    expect(ops.set).toHaveBeenCalledWith({ runsArchiveDays: 3650 })
    expect(ops.preview).toHaveBeenCalledTimes(2)
  })

  it('shows an error toast when set rejects', async () => {
    const show = vi.fn()
    useToast.setState({ show } as never)
    await mount({ set: vi.fn().mockRejectedValue(new Error('boom')) })
    await edit('ops-retention-auditLogMonths', '12')
    expect(show).toHaveBeenCalledWith('error', 'boom')
  })
})
