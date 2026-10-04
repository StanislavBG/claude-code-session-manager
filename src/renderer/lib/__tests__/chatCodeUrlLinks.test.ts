// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { linkifyCodeUrls } from '../chatCodeUrlLinks'
import { handleChatLinkClick } from '../handleChatLinkClick'

function mount(html: string): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = html
  document.body.appendChild(container)
  return container
}

describe('linkifyCodeUrls', () => {
  it('wraps an inline-code URL in an anchor', () => {
    const c = mount('<p>see <code>https://bilko.run/projects/git-viewer/</code> now</p>')
    linkifyCodeUrls(c)
    const a = c.querySelector('a[data-chat-code-url]')
    expect(a?.getAttribute('href')).toBe('https://bilko.run/projects/git-viewer/')
    expect(a?.querySelector('code')?.textContent).toBe('https://bilko.run/projects/git-viewer/')
  })

  it('leaves pre/code blocks untouched', () => {
    const c = mount('<pre><code>https://x.io</code></pre>')
    linkifyCodeUrls(c)
    expect(c.querySelector('a')).toBeNull()
  })

  it('leaves code with mixed text untouched', () => {
    const c = mount('<p><code>curl https://x.io</code></p>')
    linkifyCodeUrls(c)
    expect(c.querySelector('a')).toBeNull()
  })

  it('leaves non-http schemes untouched', () => {
    const c = mount('<p><code>javascript:alert(1)</code> <code>file:///etc/passwd</code> <code>mailto:a@b.co</code></p>')
    linkifyCodeUrls(c)
    expect(c.querySelector('a')).toBeNull()
  })

  it('does not double-wrap on a second run', () => {
    const c = mount('<p><code>https://x.io</code></p>')
    linkifyCodeUrls(c)
    linkifyCodeUrls(c)
    expect(c.querySelectorAll('a').length).toBe(1)
  })

  it('click on wrapped code opens the URL externally', async () => {
    const open = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { api: unknown }).api = { shell: { open } }
    const c = mount('<p><code>https://x.io/a</code></p>')
    linkifyCodeUrls(c)
    const code = c.querySelector('code') as HTMLElement
    const preventDefault = vi.fn()
    await handleChatLinkClick({ target: code, preventDefault } as unknown as Parameters<typeof handleChatLinkClick>[0])
    expect(open).toHaveBeenCalledWith({ as: 'external', url: 'https://x.io/a' })
  })
})
