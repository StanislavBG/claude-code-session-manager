// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleChatLinkClick } from '../handleChatLinkClick'

function mount(html: string): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = html
  document.body.appendChild(container)
  return container
}

function fireClick(container: HTMLElement, target: Element) {
  const preventDefault = vi.fn()
  const event = {
    target,
    preventDefault,
  } as unknown as Parameters<typeof handleChatLinkClick>[0]
  handleChatLinkClick(event)
  return preventDefault
}

describe('handleChatLinkClick', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    ;(globalThis as any).window.api = {
      shell: { open: vi.fn().mockResolvedValue(undefined) },
    }
  })

  it('routes http(s) link clicks through window.api.shell.open and prevents default', () => {
    const container = mount('<div><a href="https://example.com/page">link</a></div>')
    const anchor = container.querySelector('a')!
    const preventDefault = fireClick(container, anchor)

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(window.api.shell.open).toHaveBeenCalledWith({ as: 'external', url: 'https://example.com/page' })
  })

  it('does not navigate or call shell.open for a click on non-link content', () => {
    const container = mount('<div><span>plain text</span></div>')
    const span = container.querySelector('span')!
    const preventDefault = fireClick(container, span)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(window.api.shell.open).not.toHaveBeenCalled()
  })

  it('leaves relative/in-page links unhandled', () => {
    const container = mount('<div><a href="#section">anchor</a></div>')
    const anchor = container.querySelector('a')!
    const preventDefault = fireClick(container, anchor)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(window.api.shell.open).not.toHaveBeenCalled()
  })
})
