// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SourceChip } from '../SourceChip'
import { useEditor } from '../../../state/editor'
import { flushAsync } from '../../../testUtils/domFlush'

let container: HTMLDivElement | null = null
let root: Root | null = null
const readText = vi.fn()
let changeHandler: ((e: { path: string; mtimeMs: number; kind: string }) => void) | null = null
const HOME = '/home/u'
const P = HOME + '/.claude/settings.json'

beforeEach(() => {
  readText.mockReset()
  changeHandler = null
  ;(window as unknown as { api: unknown }).api = {
    app: { homeDir: () => Promise.resolve(HOME) },
    config: {
      readText,
      onChanged: (h: typeof changeHandler) => { changeHandler = h; return () => { changeHandler = null } },
    },
  }
})
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

async function mount(keyPath?: string[]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(<SourceChip path={P} keyPath={keyPath} />); await flushAsync() })
  await act(async () => { await flushAsync() })
}

describe('SourceChip', () => {
  it('renders home-shortened path and key path', async () => {
    readText.mockResolvedValue({ exists: true, text: '', mtimeMs: Date.now() - 3_600_000, error: null, truncated: true })
    await mount(['permissions'])
    expect(container!.textContent).toContain('~/.claude/settings.json › permissions')
  })

  it('shows age from mtime and refreshes on config:changed for that path', async () => {
    readText.mockResolvedValue({ exists: true, text: '', mtimeMs: Date.now() - 3_600_000, error: null, truncated: true })
    await mount()
    expect(container!.textContent).toContain('1h ago')
    readText.mockResolvedValue({ exists: true, text: '', mtimeMs: Date.now(), error: null, truncated: true })
    await act(async () => { changeHandler!({ path: '/other', mtimeMs: 1, kind: 'change' }); await flushAsync() })
    expect(container!.textContent).toContain('1h ago')
    await act(async () => { changeHandler!({ path: P, mtimeMs: 1, kind: 'change' }); await flushAsync() })
    expect(container!.textContent).toContain('just now')
  })

  it('shows "created on first save" when the file is missing', async () => {
    readText.mockResolvedValue({ exists: false, text: '', mtimeMs: 0, error: null, truncated: false })
    await mount()
    expect(container!.textContent).toContain('created on first save')
  })

  it('click opens the file in the editor', async () => {
    readText.mockResolvedValue({ exists: true, text: '', mtimeMs: Date.now(), error: null, truncated: false })
    const openFile = vi.fn()
    const orig = useEditor.getState().openFile
    useEditor.setState({ openFile })
    const evt = vi.fn()
    window.addEventListener('sm:open-editor', evt)
    await mount()
    await act(async () => { (container!.querySelector('button') as HTMLButtonElement).click() })
    expect(openFile).toHaveBeenCalledWith(P)
    expect(evt).toHaveBeenCalled()
    window.removeEventListener('sm:open-editor', evt)
    useEditor.setState({ openFile: orig })
  })
})
