// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MdDocPreview, MAX_PREVIEW_CHARS, resolveRelative, type MdDocPreviewProps } from '../MdDocPreview'
import { useToast } from '../../../../../state/toast'
import { useEditor } from '../../../../../state/editor'
import type { FilesReadResult, MdDoc, MdNetwork } from '../../../../../../preload/api'

const CWD = '/p/alpha'
const NOW = Date.UTC(2026, 10, 13)
const DAY = 86_400_000

function mdDoc(path: string, over: Partial<MdDoc> = {}): MdDoc {
  return {
    path, role: 'doc', depth: 1, lines: 40, bytes: 2048, lastCommitMs: NOW - 3 * DAY, commits: 5,
    linkedFrom: 1, codeRefs: 0, codeRefFiles: [], deadRefs: [], changedSince: [], collection: null, ...over,
  }
}

const DOCS: MdDoc[] = [
  mdDoc('CLAUDE.md', { role: 'map', depth: 0 }),
  mdDoc('docs/guide.md', {
    codeRefs: 2, codeRefFiles: ['src/a.ts', 'src/b.ts'],
    deadRefs: ['src/gone.ts'],
    changedSince: [{ path: 'src/a.ts', ms: NOW - 1 * DAY }],
  }),
  mdDoc('docs/other.md'),
  mdDoc('README.md'),
]

function network(withCensus = true): MdNetwork {
  return {
    ok: true, root: 'CLAUDE.md', nodes: [], findings: [], docs: DOCS.length, links: 4, scopes: [],
    edges: [
      { from: 'CLAUDE.md', to: 'docs/guide.md' },
      { from: 'README.md', to: 'docs/guide.md' },
      { from: 'docs/guide.md', to: 'docs/other.md' },
      { from: 'docs/guide.md', to: 'docs/missing.md', broken: true },
    ],
    census: withCensus
      ? { docs: DOCS, collections: [], counts: { tracked: 4, network: 4, records: 0, unlinked: 0, byRole: { map: 1, scoped: 0, agent: 0, record: 0, doc: 3 } }, gitWindow: { commits: 10, oldestMs: null }, warnings: [] }
      : (undefined as unknown as MdNetwork['census']),
  }
}

let host: HTMLDivElement
let root: Root
let read: ReturnType<typeof vi.fn>
let shellOpen: ReturnType<typeof vi.fn>
let openFile: ReturnType<typeof vi.fn>

function ok(text: string): FilesReadResult {
  return { ok: true, text, error: null, size: text.length }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  read = vi.fn(async () => ok('# Guide\n\n[other](other.md) [up](../README.md) [web](https://example.com) [code](../src/a.ts) [anchor](#guide)'))
  shellOpen = vi.fn(async () => ({ ok: true }))
  ;(window as unknown as { api: unknown }).api = { files: { read }, shell: { open: shellOpen } }
  openFile = vi.fn()
  useEditor.setState({ openFile } as never)
  useToast.setState({ toasts: [] } as never)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

async function render(over: Partial<MdDocPreviewProps> = {}) {
  const props: MdDocPreviewProps = { cwd: CWD, path: 'docs/guide.md', network: network(), nowMs: NOW, onNavigate: vi.fn(), ...over }
  await act(async () => { root.render(<MdDocPreview {...props} />) })
  await flush()
  return props
}

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const toasts = () => (useToast.getState() as unknown as { toasts: { kind: string; message: string }[] }).toasts

describe('MdDocPreview', () => {
  it('reads the doc and renders it through MarkdownPreview', async () => {
    await render()
    expect(read).toHaveBeenCalledWith('/p/alpha/docs/guide.md')
    expect(q('md-doc-preview-body')!.querySelector('.markdown-body h1')!.textContent).toBe('Guide')
    expect(q('md-doc-preview-truncated')).toBeNull()
  })

  it('truncates past 200,000 characters with a note', async () => {
    read.mockResolvedValueOnce(ok('a'.repeat(MAX_PREVIEW_CHARS + 50)))
    await render()
    expect(q('md-doc-preview-truncated')).not.toBeNull()
    expect(q('md-doc-preview-body')!.querySelector('.markdown-body')!.textContent!.trim().length).toBe(MAX_PREVIEW_CHARS)
  })

  it('shows an inline error and toasts when the read fails', async () => {
    read.mockResolvedValueOnce({ ok: false, text: '', error: 'ENOENT', size: 0 })
    await render()
    expect(q('md-doc-preview-error')!.textContent).toContain('ENOENT')
    expect(toasts().some((t) => t.kind === 'error' && t.message.includes('ENOENT'))).toBe(true)
  })

  it('shows an inline error when the read rejects', async () => {
    read.mockRejectedValueOnce(new Error('boom'))
    await render()
    expect(q('md-doc-preview-error')!.textContent).toContain('boom')
  })

  it('drops a stale read when the path changes', async () => {
    let resolveFirst: (r: FilesReadResult) => void = () => {}
    read.mockImplementationOnce(() => new Promise<FilesReadResult>((r) => { resolveFirst = r }))
    read.mockResolvedValueOnce(ok('# Other'))
    const props = await render()
    await act(async () => { root.render(<MdDocPreview {...props} path="docs/other.md" />) })
    await flush()
    expect(read).toHaveBeenLastCalledWith('/p/alpha/docs/other.md')
    await act(async () => { resolveFirst(ok('# Stale')) })
    await flush()
    const h1 = q('md-doc-preview-body')!.querySelector('h1')!
    expect(h1.textContent).toBe('Other')
  })

  it('renders the header from mdCurate', async () => {
    await render()
    expect(q('md-doc-preview-path')!.textContent).toBe('docs/guide.md')
    expect(q('md-doc-preview-role')!.textContent).toBe('doc')
    expect(q('md-doc-preview-usage')!.textContent).toBe('Reachable from CLAUDE.md in 1 link(s) · named by 2 code files')
    const stats = q('md-doc-preview-stats')!.textContent!
    expect(stats).toContain('3d ago')
    expect(stats).toContain('5 commits')
    expect(stats).toContain('40 lines')
    expect(stats).toContain('2.0 KB')
    expect(q('md-doc-preview-flag-changed')).not.toBeNull()
    expect(q('md-doc-preview-flag-missing-refs')).not.toBeNull()
  })

  it('renders the lists with counts and navigates from link entries', async () => {
    const props = await render()
    expect(q('md-doc-preview-linked-from-count')!.textContent).toBe('2')
    expect(q('md-doc-preview-links-to-count')!.textContent).toBe('1')
    expect(q('md-doc-preview-links-to')!.textContent).not.toContain('missing')
    expect(q('md-doc-preview-named-by-code-count')!.textContent).toBe('2')
    expect(q('md-doc-preview-changed-since')!.textContent).toContain('src/a.ts')
    expect(q('md-doc-preview-changed-since')!.textContent).toContain('1d ago')
    expect(q('md-doc-preview-missing-paths')!.textContent).toContain('src/gone.ts')
    act(() => { (q('md-doc-preview-linked-from')!.querySelector('button') as HTMLButtonElement).click() })
    expect(props.onNavigate).toHaveBeenCalledWith('CLAUDE.md')
  })

  it('shows only path, preview and link lists without a census', async () => {
    await render({ network: network(false) })
    expect(q('md-doc-preview-path')).not.toBeNull()
    expect(q('md-doc-preview-role')).toBeNull()
    expect(q('md-doc-preview-named-by-code')).toBeNull()
    expect(q('md-doc-preview-linked-from-count')!.textContent).toBe('2')
  })

  it('intercepts links inside the preview', async () => {
    const props = await render()
    const body = q('md-doc-preview-body')!
    const link = (text: string) => Array.from(body.querySelectorAll('a')).find((a) => a.textContent === text)!
    const click = (a: HTMLAnchorElement) => {
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
      act(() => { a.dispatchEvent(ev) })
      return ev
    }
    expect(click(link('other')).defaultPrevented).toBe(true)
    expect(props.onNavigate).toHaveBeenLastCalledWith('docs/other.md')
    click(link('up'))
    expect(props.onNavigate).toHaveBeenLastCalledWith('README.md')
    expect(click(link('code')).defaultPrevented).toBe(true)
    expect(props.onNavigate).toHaveBeenCalledTimes(2)
    expect(click(link('web')).defaultPrevented).toBe(true)
    expect(shellOpen).toHaveBeenCalledTimes(1)
    expect(shellOpen).toHaveBeenCalledWith({ as: 'external', url: 'https://example.com' })
    expect(click(link('anchor')).defaultPrevented).toBe(false)
  })

  it('resolves relative hrefs against the doc folder', () => {
    expect(resolveRelative('docs/guide.md', './x/y.md#h')).toBe('docs/x/y.md')
    expect(resolveRelative('docs/guide.md', '../../out.md')).toBeNull()
    expect(resolveRelative('CLAUDE.md', 'docs/guide.md')).toBe('docs/guide.md')
  })

  it('opens in the editor and reveals in the folder', async () => {
    const onOpen = vi.fn()
    window.addEventListener('sm:open-editor', onOpen)
    await render()
    act(() => { q('md-doc-preview-open')!.click() })
    expect(openFile).toHaveBeenCalledWith('/p/alpha/docs/guide.md')
    expect(onOpen).toHaveBeenCalledTimes(1)
    window.removeEventListener('sm:open-editor', onOpen)
    act(() => { q('md-doc-preview-reveal')!.click() })
    await flush()
    expect(shellOpen).toHaveBeenCalledWith({ as: 'revealPath', path: '/p/alpha/docs/guide.md' })
    expect(toasts()).toHaveLength(0)
    shellOpen.mockResolvedValueOnce({ ok: false, error: 'no file manager' })
    act(() => { q('md-doc-preview-reveal')!.click() })
    await flush()
    expect(toasts().some((t) => t.kind === 'error' && t.message.includes('no file manager'))).toBe(true)
  })

  it('hides curation controls without all three callbacks', async () => {
    await render({ onVerdict: vi.fn() })
    expect(q('md-doc-preview-curation')).toBeNull()
  })

  it('renders curation controls and reports changes', async () => {
    const onVerdict = vi.fn()
    const onNote = vi.fn()
    const onMarkReviewed = vi.fn()
    const props = await render({ onVerdict, onNote, onMarkReviewed, verdict: 'keep', note: 'hi' })
    expect(q('md-doc-preview-verdict-keep')!.getAttribute('aria-pressed')).toBe('true')
    act(() => { q('md-doc-preview-verdict-keep')!.click() })
    expect(onVerdict).toHaveBeenLastCalledWith(null)
    act(() => { q('md-doc-preview-verdict-merge')!.click() })
    expect(onVerdict).toHaveBeenLastCalledWith('merge')
    const input = q('md-doc-preview-note') as HTMLInputElement
    expect(input.value).toBe('hi')
    expect(input.maxLength).toBe(280)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input, 'x'.repeat(300))
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onNote).toHaveBeenLastCalledWith('x'.repeat(280))
    expect(q('md-doc-preview-mark-reviewed')!.textContent).toBe('Mark reviewed')
    act(() => { q('md-doc-preview-mark-reviewed')!.click() })
    expect(onMarkReviewed).toHaveBeenCalledTimes(1)
    await act(async () => { root.render(<MdDocPreview {...props} reviewedAtMs={NOW - 2 * DAY} />) })
    expect(q('md-doc-preview-mark-reviewed')!.textContent).toBe('Reviewed 2d ago')
  })
})
