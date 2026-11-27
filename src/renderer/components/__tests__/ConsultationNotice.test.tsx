// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const read = vi.fn()
const write = vi.fn()
const openFreeHour = vi.fn()
const toastError = vi.fn()

vi.mock('../../lib/uiSettingsPrefs', () => ({
  readUiSettingsPrefs: () => read(),
  writeUiSettingsPrefs: (p: unknown) => write(p),
}))
vi.mock('../../lib/freeHour', () => ({ openFreeHour: () => openFreeHour() }))
vi.mock('../../state/toast', () => ({ toast: { error: (m: string) => toastError(m) } }))

import { ConsultationNotice } from '../ConsultationNotice'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function mount() {
  await act(async () => {
    root.render(<ConsultationNotice />)
  })
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

beforeEach(() => {
  ;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '1.2.3'
  read.mockReset()
  write.mockReset().mockResolvedValue(undefined)
  openFreeHour.mockReset()
  toastError.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ConsultationNotice', () => {
  it('shows when never dismissed', async () => {
    read.mockResolvedValue({})
    await mount()
    expect(q('consultation-notice')?.textContent).toBe('Want to chat? Book a free consultation.')
  })

  it('shows when dismissed for an older version', async () => {
    read.mockResolvedValue({ consultationNoticeDismissedVersion: '1.0.0' })
    await mount()
    expect(q('consultation-notice')).not.toBeNull()
  })

  it('is hidden when dismissed for the current version', async () => {
    read.mockResolvedValue({ consultationNoticeDismissedVersion: '1.2.3' })
    await mount()
    expect(q('consultation-notice')).toBeNull()
  })

  it('dismiss writes the current version and hides', async () => {
    read.mockResolvedValue({})
    await mount()
    await act(async () => {
      q('consultation-notice-dismiss')!.click()
    })
    expect(write).toHaveBeenCalledWith({ consultationNoticeDismissedVersion: '1.2.3' })
    expect(q('consultation-notice')).toBeNull()
  })

  it('link click opens the booking page and writes', async () => {
    read.mockResolvedValue({})
    await mount()
    await act(async () => {
      q('consultation-notice-link')!.click()
    })
    expect(openFreeHour).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith({ consultationNoticeDismissedVersion: '1.2.3' })
    expect(q('consultation-notice')).toBeNull()
  })

  it('shows when the read fails', async () => {
    read.mockRejectedValue(new Error('boom'))
    await mount()
    expect(q('consultation-notice')).not.toBeNull()
  })

  it('toasts when the write fails and stays hidden', async () => {
    read.mockResolvedValue({})
    write.mockRejectedValue(new Error('disk full'))
    await mount()
    await act(async () => {
      q('consultation-notice-dismiss')!.click()
    })
    expect(toastError).toHaveBeenCalledWith('disk full')
    expect(q('consultation-notice')).toBeNull()
  })
})
