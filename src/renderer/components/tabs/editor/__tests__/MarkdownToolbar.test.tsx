// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach } from 'vitest'
import { MarkdownToolbar } from '../MarkdownToolbar'

/**
 * Markdown mode's toolbar is the design's literal-syntax strip:
 * H1 H2 H3 **B** _I_ `code` - List 1. List > Quote [Link]. Each inserts its
 * markdown into the Monaco buffer. Monaco does not run under jsdom, so a
 * one-line fake editor stands in for it.
 */

interface Sel { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }

function fakeEditor(initial: string, sel: Sel) {
  const state = { text: initial, sel }
  const offset = (line: number, col: number) => {
    const lines = state.text.split('\n')
    let o = 0
    for (let i = 0; i < line - 1; i++) o += lines[i].length + 1
    return o + col - 1
  }
  const ed = {
    state,
    getModel: () => ({
      getValueInRange: (r: Sel) => state.text.slice(offset(r.startLineNumber, r.startColumn), offset(r.endLineNumber, r.endColumn)),
    }),
    getSelection: () => state.sel,
    executeEdits: (_src: string, edits: { range: Sel; text: string }[]) => {
      // Apply from the end so earlier offsets stay valid.
      const sorted = [...edits].sort((a, b) => offset(b.range.startLineNumber, b.range.startColumn) - offset(a.range.startLineNumber, a.range.startColumn))
      for (const e of sorted) {
        const s = offset(e.range.startLineNumber, e.range.startColumn)
        const en = offset(e.range.endLineNumber, e.range.endColumn)
        state.text = state.text.slice(0, s) + e.text + state.text.slice(en)
      }
      return true
    },
    focus: () => {},
  }
  return ed
}

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
})

function mount(ed: ReturnType<typeof fakeEditor>) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(MarkdownToolbar, { getEditor: () => ed as any })))
  return host
}

const btn = (el: HTMLElement, label: string) =>
  Array.from(el.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement

describe('MarkdownToolbar', () => {
  it('shows H1 H2 H3 **B** _I_ `code` - List 1. List > Quote [Link] in order', () => {
    const el = mount(fakeEditor('', { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }))
    expect(Array.from(el.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'H1', 'H2', 'H3', '**B**', '_I_', '`code`', '- List', '1. List', '> Quote', '[Link]',
    ])
  })

  it('**B** wraps the selection in **', () => {
    // select "world"
    const ed = fakeEditor('hello world', { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 12 })
    const el = mount(ed)
    act(() => btn(el, '**B**').click())
    expect(ed.state.text).toBe('hello **world**')
  })

  it('line actions prefix the line; [Link] wraps the selection as a link', () => {
    const ed = fakeEditor('title', { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 })
    const el = mount(ed)
    act(() => btn(el, '[Link]').click())
    expect(ed.state.text).toBe('[title](url)')
    act(() => btn(el, '> Quote').click())
    expect(ed.state.text).toBe('> [title](url)')
  })
})
