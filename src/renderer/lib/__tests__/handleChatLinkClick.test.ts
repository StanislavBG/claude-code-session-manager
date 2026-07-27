// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleChatLinkClick } from '../handleChatLinkClick'
import { FILE_LINK_ATTR } from '../chatFileLinks'
import { useEditor } from '../../state/editor'

function mount(html: string): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = html
  document.body.appendChild(container)
  return container
}

function fireClick(container: HTMLElement, target: Element, cwd?: string) {
  const preventDefault = vi.fn()
  const event = {
    target,
    preventDefault,
  } as unknown as Parameters<typeof handleChatLinkClick>[0]
  return { result: handleChatLinkClick(event, cwd), preventDefault }
}

describe('handleChatLinkClick', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
    ;(globalThis as any).window.api = {
      shell: { open: vi.fn().mockResolvedValue(undefined) },
      files: { read: vi.fn() },
    }
  })

  it('routes http(s) link clicks through window.api.shell.open and prevents default', async () => {
    const container = mount('<div><a href="https://example.com/page">link</a></div>')
    const anchor = container.querySelector('a')!
    const { result, preventDefault } = fireClick(container, anchor)
    await result

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(window.api.shell.open).toHaveBeenCalledWith({ as: 'external', url: 'https://example.com/page' })
  })

  it('does not navigate or call shell.open for a click on non-link content', async () => {
    const container = mount('<div><span>plain text</span></div>')
    const span = container.querySelector('span')!
    const { result, preventDefault } = fireClick(container, span)
    await result

    expect(preventDefault).not.toHaveBeenCalled()
    expect(window.api.shell.open).not.toHaveBeenCalled()
  })

  it('leaves relative/in-page links unhandled', async () => {
    const container = mount('<div><a href="#section">anchor</a></div>')
    const anchor = container.querySelector('a')!
    const { result, preventDefault } = fireClick(container, anchor)
    await result

    expect(preventDefault).not.toHaveBeenCalled()
    expect(window.api.shell.open).not.toHaveBeenCalled()
  })

  it('opens a linkified file-path token via useEditor.openFile + sm:open-editor', async () => {
    ;(window.api.files.read as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: 'hi', error: null, size: 2 })
    const openFileMock = vi.fn()
    useEditor.setState({ openFile: openFileMock })
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    const container = mount(`<div><span ${FILE_LINK_ATTR}="src/foo.ts:42:8">src/foo.ts:42:8</span></div>`)
    const span = container.querySelector('span')!
    const { result } = fireClick(container, span, '/home/user/project')
    await result

    expect(window.api.files.read).toHaveBeenCalledWith('/home/user/project/src/foo.ts')
    expect(openFileMock).toHaveBeenCalledWith('/home/user/project/src/foo.ts', { line: 42, col: 8 })
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'sm:open-editor' }))
  })

  it('does not open a path-traversal file-link token that resolves outside home', async () => {
    ;(window.api.files.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      text: '',
      error: 'path outside home',
      size: 0,
    })
    const openFileMock = vi.fn()
    useEditor.setState({ openFile: openFileMock })

    const container = mount(`<div><span ${FILE_LINK_ATTR}="../../../../etc/passwd">../../../../etc/passwd</span></div>`)
    const span = container.querySelector('span')!
    const { result } = fireClick(container, span, '/home/user/project')
    await result

    expect(openFileMock).not.toHaveBeenCalled()
  })
})
