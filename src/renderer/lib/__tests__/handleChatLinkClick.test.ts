// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleChatLinkClick } from '../handleChatLinkClick'
import { FILE_LINK_ATTR } from '../chatFileLinks'
import { useEditor } from '../../state/editor'
import { useSessions } from '../../state/sessions'

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

  it('falls back to another open tab whose cwd actually contains the file', async () => {
    const activeCwd = '/home/user/session-manager'
    const otherCwd = '/home/user/Bilko'
    useSessions.setState({
      tabs: [
        { id: 'a', cwd: activeCwd } as any,
        { id: 'b', cwd: otherCwd } as any,
      ],
    } as any)
    ;(window.api.files.read as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (path === `${otherCwd}/src/data/projectsRegistry.ts`) {
        return { ok: true, text: 'hi', error: null, size: 2 }
      }
      return { ok: false, text: '', error: 'ENOENT: no such file or directory', size: 0 }
    })
    const openFileMock = vi.fn()
    useEditor.setState({ openFile: openFileMock })

    const container = mount(`<div><span ${FILE_LINK_ATTR}="src/data/projectsRegistry.ts">src/data/projectsRegistry.ts</span></div>`)
    const span = container.querySelector('span')!
    const { result } = fireClick(container, span, activeCwd)
    await result

    expect(openFileMock).toHaveBeenCalledWith(`${otherCwd}/src/data/projectsRegistry.ts`, { line: undefined, col: undefined })
  })

  it('reports which cwds were tried when the file exists nowhere', async () => {
    const activeCwd = '/home/user/session-manager'
    const otherCwd = '/home/user/Bilko'
    useSessions.setState({
      tabs: [
        { id: 'a', cwd: activeCwd } as any,
        { id: 'b', cwd: otherCwd } as any,
      ],
    } as any)
    ;(window.api.files.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      text: '',
      error: 'ENOENT: no such file or directory',
      size: 0,
    })
    const openFileMock = vi.fn()
    useEditor.setState({ openFile: openFileMock })
    const { toast } = await import('../../state/toast')
    const errorSpy = vi.spyOn(toast, 'error')

    const container = mount(`<div><span ${FILE_LINK_ATTR}="totally/fake/path.ts">totally/fake/path.ts</span></div>`)
    const span = container.querySelector('span')!
    const { result } = fireClick(container, span, activeCwd)
    await result

    expect(openFileMock).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`ENOENT: no such file or directory under ${activeCwd} (tried 1 other open tab)`),
    )
  })

  it('pluralizes "tabs" correctly when more than one other tab was tried', async () => {
    const activeCwd = '/home/user/session-manager'
    useSessions.setState({
      tabs: [
        { id: 'a', cwd: activeCwd } as any,
        { id: 'b', cwd: '/home/user/Bilko' } as any,
        { id: 'c', cwd: '/home/user/other-repo' } as any,
      ],
    } as any)
    ;(window.api.files.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      text: '',
      error: 'ENOENT: no such file or directory',
      size: 0,
    })
    const openFileMock = vi.fn()
    useEditor.setState({ openFile: openFileMock })
    const { toast } = await import('../../state/toast')
    const errorSpy = vi.spyOn(toast, 'error')

    const container = mount(`<div><span ${FILE_LINK_ATTR}="totally/fake/path.ts">totally/fake/path.ts</span></div>`)
    const span = container.querySelector('span')!
    const { result } = fireClick(container, span, activeCwd)
    await result

    expect(openFileMock).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('(tried 2 other open tabs)'))
  })
})
