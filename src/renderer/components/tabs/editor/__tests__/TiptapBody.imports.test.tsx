// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { TiptapBody } from '../TiptapBody'

/**
 * CLAUDE.md `@path` import lines: each source line matching ^@\S+ is its own
 * block in Document mode (accent `@` marker + mono path), and survives a
 * save — untouched or after edits elsewhere — exactly as written.
 */

if (!(Range.prototype as any).getClientRects) {
  ;(Range.prototype as any).getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })
  ;(Range.prototype as any).getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 })
}
if (!(document as any).elementFromPoint) (document as any).elementFromPoint = () => null

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
})

async function mount(value: string, onChange = vi.fn()) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(createElement(TiptapBody, { value, onChange })) })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return { el: host, onChange }
}

const pm = (el: HTMLElement) => el.querySelector('[data-testid="tiptap-editor"]') as HTMLElement
const imports = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-testid="tiptap-editor"] [data-sm-import]'))

/** The Tiptap editor behind the rendered DOM (ProseMirror stores the view on the node). */
function editorOf(el: HTMLElement): any {
  return (pm(el) as any).editor
}

/** Drive the component's save path with a net-zero edit (type then delete one char). */
function emitUnchanged(el: HTMLElement, onChange: ReturnType<typeof vi.fn>, source: string): string {
  // Anything the editor emitted on load (before any edit) must already be the source.
  for (const [text] of onChange.mock.calls) expect(text).toBe(source)
  const ed = editorOf(el)
  act(() => { ed.chain().insertContentAt(1, 'x').run() })
  act(() => { ed.chain().deleteRange({ from: 1, to: 2 }).run() })
  return onChange.mock.calls.at(-1)![0] as string
}

const CLAUDE_MD = [
  '# House rules',
  '',
  'Plain language everywhere.',
  '',
  '- Push to `main` only on green.',
  '',
  '@~/.claude/rules/git.md',
  '@~/.claude/rules/writing.md',
  '',
].join('\n')

describe('TiptapBody — @ import lines', () => {
  it('renders two consecutive @ lines as two blocks with an @ marker and a mono path', async () => {
    const { el } = await mount(CLAUDE_MD)
    const blocks = imports(el)
    expect(blocks).toHaveLength(2)
    // Each is a top-level block of the document, not a run-on paragraph.
    for (const b of blocks) expect(b.parentElement).toBe(pm(el))
    expect(Array.from(pm(el).querySelectorAll('p')).some((p) => p.textContent?.includes('@'))).toBe(false)
    const [a, b] = blocks
    expect(a.querySelector('[data-sm-import-marker]')?.textContent).toBe('@')
    expect(a.querySelector('[data-sm-import-path]')?.textContent).toBe('~/.claude/rules/git.md')
    expect(a.querySelector('[data-sm-import-path]')?.className).toContain('font-mono')
    expect(a.querySelector('[data-sm-import-marker]')?.className).toContain('text-accent')
    expect(b.querySelector('[data-sm-import-path]')?.textContent).toBe('~/.claude/rules/writing.md')
  })

  it('round trip: load then save without edits is byte-identical', async () => {
    const { el, onChange } = await mount(CLAUDE_MD)
    expect(emitUnchanged(el, onChange, CLAUDE_MD)).toBe(CLAUDE_MD)
  })

  it('round trip keeps blank-line spacing, mid-paragraph @ lines, and frontmatter as written', async () => {
    const src = '---\nname: x\n---\nIntro line\n@a/b.md\n\n@c_d*.md\nafter\n'
    const { el, onChange } = await mount(src)
    expect(imports(el)).toHaveLength(2)
    expect(emitUnchanged(el, onChange, src)).toBe(src)
  })

  it('editing text elsewhere keeps every @ line as written', async () => {
    const { el, onChange } = await mount(CLAUDE_MD)
    const ed = editorOf(el)
    act(() => { ed.chain().setTextSelection(1).insertContent('Our ').run() })
    const out = onChange.mock.calls.at(-1)![0] as string
    expect(out.startsWith('# Our House rules\n')).toBe(true)
    expect(out).toContain('\n@~/.claude/rules/git.md\n@~/.claude/rules/writing.md\n')
  })
})
