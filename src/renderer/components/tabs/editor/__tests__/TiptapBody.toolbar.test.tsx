// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { TiptapBody } from '../TiptapBody'

/**
 * The Document-mode toolbar is the design's: a block-style menu labelled with
 * the current block, then B, I, </>, • List, 1. List, Quote, Link — each a
 * real Tiptap command. Runs the real editor under jsdom.
 */

// ProseMirror measures layout when it scrolls the selection into view.
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

const toolbarLabels = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('[data-testid="doc-toolbar"] button:not([role="menuitem"])')).map((b) => b.textContent)
const styleBtn = (el: HTMLElement) => el.querySelector('[data-testid="doc-style-menu"]') as HTMLButtonElement
const press = (b: Element) => {
  act(() => {
    b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  })
}

describe('TiptapBody — Document toolbar', () => {
  it('shows the style menu then B, I, </>, • List, 1. List, Quote, Link in order', async () => {
    const { el } = await mount('hello world\n')
    expect(styleBtn(el).textContent).toContain('Normal text')
    expect(toolbarLabels(el)).toEqual(['Normal text▾', 'B', 'I', '</>', '• List', '1. List', 'Quote', 'Link'])
  })

  it('the style menu offers the four block styles and turns a paragraph into Heading 2', async () => {
    const { el, onChange } = await mount('hello world\n')
    press(styleBtn(el))
    const opts = Array.from(el.querySelectorAll('[data-testid="doc-style-menu-list"] [role="menuitem"]'))
    expect(opts.map((o) => o.textContent)).toEqual(['Normal text', 'Heading 1', 'Heading 2', 'Heading 3'])
    press(opts[2])
    expect(el.querySelector('[data-testid="tiptap-editor"] h2')?.textContent).toBe('hello world')
    expect(styleBtn(el).textContent).toContain('Heading 2')
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining('## hello world'))
    // The menu closes after a pick.
    expect(el.querySelector('[data-testid="doc-style-menu-list"]')).toBeNull()
  })

  it('Quote applies the blockquote command', async () => {
    const { el } = await mount('hello\n')
    const quote = Array.from(el.querySelectorAll('[data-testid="doc-toolbar"] button:not([role="menuitem"])')).find((b) => b.textContent === 'Quote')!
    press(quote)
    expect(el.querySelector('[data-testid="tiptap-editor"] blockquote')).not.toBeNull()
  })
})
