// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach, vi } from 'vitest'

/**
 * DocumentEditorPane is the Editor scene's document view, reused by screens
 * that edit one known file (System Prompt today). These tests pin the chrome
 * contract — which modes exist, when the formatting toolbar appears, and that
 * a read-only document can't be typed into — without booting Monaco, which
 * doesn't render under jsdom.
 */

vi.mock('../CodeEditorPane', () => ({
  CodeEditorPane: ({ path, value, readOnly }: any) =>
    createElement('div', { 'data-testid': 'code-pane', 'data-path': path, 'data-readonly': String(!!readOnly) }, value),
}))
vi.mock('../MarkdownPreview', async () => {
  const actual = await vi.importActual<any>('../MarkdownPreview')
  return {
    ...actual,
    MarkdownPreview: ({ text }: any) => createElement('div', { 'data-testid': 'preview' }, text),
  }
})

const { DocumentEditorPane } = await import('../DocumentEditorPane')

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(props: Record<string, unknown>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(createElement(DocumentEditorPane as any, { onChange: () => {}, ...props } as any)))
  return container
}

const modeLabels = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('[data-testid="document-mode-toggle"] button')).map((b) => b.textContent)

const MD = '/home/u/.claude/CLAUDE.md'

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('DocumentEditorPane', () => {
  it('gives an editable markdown file the full edit/preview/split set and the formatting toolbar', () => {
    const el = mount({ path: MD, value: '# hi\n\nbody', defaultMode: 'split' })
    expect(modeLabels(el)).toEqual(['edit', 'preview', 'split'])
    // Split shows source and rendered output at once.
    expect(el.querySelector('[data-testid="code-pane"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="preview"]')).not.toBeNull()
    // The markdown formatting strip is present for an editable document.
    expect(Array.from(el.querySelectorAll('button')).some((b) => b.textContent === 'H1')).toBe(true)
  })

  it('honours defaultMode, and switching modes swaps the body', () => {
    const el = mount({ path: MD, value: '# hi', defaultMode: 'edit' })
    expect(el.querySelector('[data-testid="preview"]')).toBeNull()

    const preview = Array.from(el.querySelectorAll('[data-testid="document-mode-toggle"] button'))
      .find((b) => b.textContent === 'preview') as HTMLButtonElement
    act(() => preview.click())

    expect(el.querySelector('[data-testid="preview"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="code-pane"]')).toBeNull()
  })

  it('opens a read-only document rendered, with no split, no toolbar, and a locked editor', () => {
    const el = mount({ path: MD, value: '# hi', readOnly: true, defaultMode: 'split' })
    expect(modeLabels(el)).toEqual(['preview', 'edit'])
    expect(el.querySelector('[data-testid="preview"]')).not.toBeNull()
    expect(el.textContent).toContain('read-only')
    expect(Array.from(el.querySelectorAll('button')).some((b) => b.textContent === 'H1')).toBe(false)

    const edit = Array.from(el.querySelectorAll('[data-testid="document-mode-toggle"] button'))
      .find((b) => b.textContent === 'edit') as HTMLButtonElement
    act(() => edit.click())
    expect(el.querySelector('[data-testid="code-pane"]')?.getAttribute('data-readonly')).toBe('true')
  })

  it('offers no view modes for a non-renderable file and just shows the editor', () => {
    const el = mount({ path: '/home/u/notes.txt', value: 'plain' })
    expect(el.querySelector('[data-testid="document-mode-toggle"]')).toBeNull()
    expect(el.querySelector('[data-testid="code-pane"]')).not.toBeNull()
  })

  it('reports document metrics in the status bar unless the host hides it', () => {
    const el = mount({ path: MD, value: 'one two three', defaultMode: 'edit' })
    expect(el.textContent).toContain('3 words')

    act(() => root!.render(createElement(DocumentEditorPane as any, {
      path: MD, value: 'one two three', defaultMode: 'edit', onChange: () => {}, hideStatusBar: true,
    } as any)))
    expect(el.textContent).not.toContain('3 words')
  })

  it('toggles the document outline in rendered modes', () => {
    const el = mount({ path: MD, value: '# Alpha\n## Beta\n', defaultMode: 'preview' })
    // The outline lists one nav button per heading, alongside the preview.
    const outlineLinks = () => Array.from(el.querySelectorAll('nav button')).map((b) => b.textContent)
    expect(outlineLinks()).toEqual(['Alpha', 'Beta'])

    const toggle = el.querySelector('[data-testid="document-outline-toggle"]') as HTMLButtonElement
    act(() => toggle.click())
    expect(outlineLinks()).toEqual([])
  })
})
