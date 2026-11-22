// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach, vi } from 'vitest'

/**
 * DocumentEditorPane is the one document editor every markdown file opens in
 * (CLAUDE.md, SKILL.md, agent prompts, memory). These tests pin the designed
 * chrome contract — a Document | Markdown switch that shows ONE mode at a time,
 * a Full screen overlay that Escape exits, and a status bar whose Save/Revert
 * are live only when the buffer is dirty — without booting Monaco or Tiptap,
 * neither of which renders under jsdom.
 */

vi.mock('../CodeEditorPane', () => ({
  CodeEditorPane: ({ path, value, readOnly }: any) =>
    createElement('div', { 'data-testid': 'code-pane', 'data-path': path, 'data-readonly': String(!!readOnly) }, value),
}))
vi.mock('../TiptapBody', () => ({
  TiptapBody: ({ value }: any) => createElement('div', { 'data-testid': 'tiptap-body' }, value),
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

function render(props: Record<string, unknown>) {
  act(() => root!.render(createElement(DocumentEditorPane as any, { onChange: () => {}, ...props } as any)))
}

function mount(props: Record<string, unknown>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  render(props)
  return container
}

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const modeLabels = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('[data-testid="document-mode-toggle"] button')).map((b) => b.textContent)
const modeButton = (el: HTMLElement, label: string) =>
  Array.from(el.querySelectorAll('[data-testid="document-mode-toggle"] button'))
    .find((b) => b.textContent === label) as HTMLButtonElement

const MD = '/home/u/.claude/CLAUDE.md'

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('DocumentEditorPane — title bar + mode switch', () => {
  it('offers exactly Document | Markdown, opens in Document, and shows only that mode', () => {
    const el = mount({ path: MD, value: '# hi\n\nbody' })
    expect(modeLabels(el)).toEqual(['Document', 'Markdown'])
    expect(modeButton(el, 'Document').getAttribute('aria-pressed')).toBe('true')
    expect(q(el, 'tiptap-body')).not.toBeNull()
    expect(q(el, 'code-pane')).toBeNull()
    // The file name sits in the title bar.
    expect(q(el, 'document-title')?.textContent).toBe('CLAUDE.md')
  })

  it('switching to Markdown swaps the body to the source pane + markdown toolbar — never side by side', () => {
    const el = mount({ path: MD, value: '# hi' })
    act(() => modeButton(el, 'Markdown').click())
    expect(q(el, 'code-pane')).not.toBeNull()
    expect(q(el, 'tiptap-body')).toBeNull()
    expect(q(el, 'preview')).toBeNull()
    expect(Array.from(el.querySelectorAll('button')).some((b) => b.textContent === 'H1')).toBe(true)

    act(() => modeButton(el, 'Document').click())
    expect(q(el, 'tiptap-body')).not.toBeNull()
    expect(q(el, 'code-pane')).toBeNull()
  })

  it('maps a legacy defaultMode: edit opens Markdown, split/preview open Document', () => {
    let el = mount({ path: MD, value: '# hi', defaultMode: 'edit' })
    expect(q(el, 'code-pane')).not.toBeNull()
    act(() => root?.unmount()); container?.remove()

    el = mount({ path: MD, value: '# hi', defaultMode: 'split' })
    expect(q(el, 'tiptap-body')).not.toBeNull()
    expect(q(el, 'code-pane')).toBeNull()
  })

  it('opens a read-only document rendered (not editable) with a locked source view', () => {
    const el = mount({ path: MD, value: '# hi', readOnly: true })
    expect(q(el, 'preview')).not.toBeNull()
    expect(q(el, 'tiptap-body')).toBeNull()
    expect(el.textContent).toContain('read-only')
    act(() => modeButton(el, 'Markdown').click())
    expect(q(el, 'code-pane')?.getAttribute('data-readonly')).toBe('true')
    expect(Array.from(el.querySelectorAll('button')).some((b) => b.textContent === 'H1')).toBe(false)
  })

  it('offers no mode switch for a non-markdown file and just shows the editor', () => {
    const el = mount({ path: '/home/u/notes.txt', value: 'plain' })
    expect(q(el, 'document-mode-toggle')).toBeNull()
    expect(q(el, 'code-pane')).not.toBeNull()
  })

  it('starts with the outline closed; the toggle opens and closes it, and THIS FILE lives only inside it', () => {
    const el = mount({ path: MD, value: '# Alpha\n## Beta\n' })
    const outlineLinks = () => Array.from(el.querySelectorAll('nav button')).map((b) => b.textContent)
    expect(outlineLinks()).toEqual([])
    expect(q(el, 'doc-outline-stats')).toBeNull()
    expect(el.textContent).not.toMatch(/this file/i)
    expect(q(el, 'document-outline-toggle')?.getAttribute('aria-pressed')).toBe('false')

    act(() => q(el, 'document-outline-toggle')!.click())
    expect(outlineLinks()).toEqual(['Alpha', 'Beta'])
    expect(q(el, 'doc-outline')?.contains(q(el, 'doc-outline-stats'))).toBe(true)
    expect(q(el, 'doc-outline-stats')?.textContent).toContain('2 lines')

    act(() => q(el, 'document-outline-toggle')!.click())
    expect(outlineLinks()).toEqual([])
    expect(q(el, 'doc-outline-stats')).toBeNull()
  })
})

describe('DocumentEditorPane — full screen', () => {
  it('Full screen expands over the page with an Exit control; Escape exits', () => {
    const el = mount({ path: MD, value: '# hi' })
    const pane = q(el, 'document-editor-pane')!
    expect(pane.className).not.toContain('fixed')
    expect(q(el, 'document-exit-fullscreen')).toBeNull()

    act(() => q(el, 'document-fullscreen')!.click())
    expect(pane.className).toContain('fixed')
    expect(pane.className).toContain('inset-0')
    expect(q(el, 'document-exit-fullscreen')?.textContent).toContain('Exit full screen')
    // Full screen also names the full path.
    expect(pane.textContent).toContain(MD)

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(pane.className).not.toContain('fixed')
    expect(q(el, 'document-exit-fullscreen')).toBeNull()
  })

  it('full screen starts with the outline open; the toggle still closes it; exiting closes it again', () => {
    const el = mount({ path: MD, value: '# Alpha\n' })
    expect(q(el, 'doc-outline')).toBeNull()
    act(() => q(el, 'document-fullscreen')!.click())
    expect(q(el, 'doc-outline')).not.toBeNull()
    expect(q(el, 'doc-outline-stats')).not.toBeNull()
    act(() => q(el, 'document-outline-toggle')!.click())
    expect(q(el, 'doc-outline')).toBeNull()
    act(() => q(el, 'document-outline-toggle')!.click())
    expect(q(el, 'doc-outline')).not.toBeNull()
    act(() => q(el, 'document-exit-fullscreen')!.click())
    expect(q(el, 'doc-outline')).toBeNull()
  })

  it('the Exit full screen button also exits', () => {
    const el = mount({ path: MD, value: '# hi' })
    act(() => q(el, 'document-fullscreen')!.click())
    act(() => q(el, 'document-exit-fullscreen')!.click())
    expect(q(el, 'document-editor-pane')!.className).not.toContain('fixed')
  })
})

describe('DocumentEditorPane — status bar', () => {
  it('reports words and ~tokens (chars/4) unless the host hides it', () => {
    // 13 chars → ceil(13/4) = 4 tokens
    const el = mount({ path: MD, value: 'one two three' })
    expect(q(el, 'editor-status-bar')?.textContent).toContain('3 words · ~4 tokens')

    render({ path: MD, value: 'one two three', hideStatusBar: true })
    expect(q(el, 'editor-status-bar')).toBeNull()
  })

  it('Save and Revert are enabled only when dirty, with the matching save-state text', () => {
    const onSave = vi.fn()
    const onRevert = vi.fn()
    const el = mount({ path: MD, value: '# hi', dirty: false, onSave, onRevert })
    const save = () => q(el, 'editor-save') as HTMLButtonElement
    const revert = () => q(el, 'editor-revert') as HTMLButtonElement

    expect(q(el, 'editor-save-state')?.textContent).toBe('Saved · matches the file on disk')
    expect(save().disabled).toBe(true)
    expect(revert().disabled).toBe(true)
    expect(save().textContent).toContain('Ctrl S')

    render({ path: MD, value: '# hi!', dirty: true, onSave, onRevert })
    expect(q(el, 'editor-save-state')?.textContent).toBe('Unsaved changes')
    expect(save().disabled).toBe(false)
    expect(revert().disabled).toBe(false)
    act(() => save().click())
    act(() => revert().click())
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onRevert).toHaveBeenCalledTimes(1)
  })

  it('a new file says it will be created on first save', () => {
    const el = mount({ path: MD, value: '', dirty: false, isNew: true, onSave: () => {} })
    expect(q(el, 'editor-save-state')?.textContent).toBe('New file · created on first save')
    expect(q(el, 'editor-save')?.textContent).toContain('Create file')
  })
})
