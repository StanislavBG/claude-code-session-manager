// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

const toastError = vi.fn()
vi.mock('../../state/toast', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), show: vi.fn(), success: vi.fn() },
}))

import { UrlCallout } from '../ChatTranscriptTurn'

let container: HTMLDivElement | null = null
let root: Root | null = null
let open: ReturnType<typeof vi.fn>
let writeText: ReturnType<typeof vi.fn>

function mount(url: string) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(createElement(UrlCallout, { url })))
  return container
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  toastError.mockClear()
  open = vi.fn().mockResolvedValue({ ok: true })
  writeText = vi.fn().mockResolvedValue({ ok: true })
  ;(window as unknown as { api: unknown }).api = { shell: { open }, clipboard: { writeText } }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('UrlCallout', () => {
  it('opens the https URL externally on label click', async () => {
    const c = mount('https://example.com/a')
    const btn = c.querySelector('[data-testid="chat-url-callout-open"]')!
    expect(btn.getAttribute('title')).toBe('Open in browser')
    await click(btn)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith({ as: 'external', url: 'https://example.com/a' })
  })

  it('Copy does not call shell.open', async () => {
    const c = mount('https://example.com/a')
    const copy = Array.from(c.querySelectorAll('button')).find((b) => b.textContent === 'Copy')!
    await click(copy)
    expect(writeText).toHaveBeenCalledWith('https://example.com/a')
    expect(open).not.toHaveBeenCalled()
  })

  it('never passes a javascript: URL to shell.open', async () => {
    const c = mount('javascript:alert(1)')
    await click(c.querySelector('[data-testid="chat-url-callout-open"]')!)
    expect(open).not.toHaveBeenCalled()
  })

  it('toasts an error when shell.open rejects', async () => {
    open.mockRejectedValue(new Error('boom'))
    const c = mount('https://example.com')
    await click(c.querySelector('[data-testid="chat-url-callout-open"]')!)
    expect(toastError).toHaveBeenCalledWith('Could not open link: boom')
  })

  it('toasts an error when shell.open resolves ok:false', async () => {
    open.mockResolvedValue({ ok: false, error: 'nope' })
    const c = mount('https://example.com')
    await click(c.querySelector('[data-testid="chat-url-callout-open"]')!)
    expect(toastError).toHaveBeenCalledWith('Could not open link: nope')
  })
})
