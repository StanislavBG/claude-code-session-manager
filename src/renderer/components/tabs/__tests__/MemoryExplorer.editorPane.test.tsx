// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

vi.mock('../editor/DocumentEditorPane', () => ({
  DocumentEditorPane: (p: any) => createElement('div', {
    'data-testid': 'doc-editor', 'data-path': p.path, 'data-dirty': String(!!p.dirty), 'data-mode': p.defaultMode,
  }, [
    createElement('span', { key: 'v', 'data-testid': 'doc-editor-value' }, p.value),
    createElement('button', { key: 's', 'data-testid': 'doc-editor-save', onClick: () => p.onSave?.() }, 'Save'),
    createElement('button', { key: 'r', 'data-testid': 'doc-editor-revert', onClick: () => p.onRevert?.() }, 'Revert'),
    createElement('button', { key: 'c', 'data-testid': 'doc-editor-change', onClick: () => p.onChange('changed') }, 'Type'),
  ]),
}))

const { MemoryEditorPane } = await import('../memory/explorer/MemoryEditorPane')

let container: HTMLDivElement | null = null
let root: Root | null = null

function props(over: Record<string, unknown> = {}) {
  return {
    mode: 'edit' as 'edit' | 'new' | 'none',
    name: 'deploy_freeze',
    title: '',
    onTitle: vi.fn(),
    body: '---\nname: x\n---\n\nhello\n',
    path: '/m/deploy_freeze.md',
    onRevert: vi.fn(),
    onBody: vi.fn(),
    onSave: vi.fn(),
    onCancel: vi.fn(),
    saving: false,
    dirty: true,
    ...over,
  }
}

function mount(p: ReturnType<typeof props>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(createElement(MemoryEditorPane, p))
  })
}

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('MemoryEditorPane', () => {
  it('none mode shows the empty state only', () => {
    mount(props({ mode: 'none', name: null }))
    expect(q('mx-editor-none')?.textContent).toContain('No memory selected')
    expect(q('mx-editor-none')?.textContent).toContain('Pick one from the list, or press /.')
    expect(q('mx-editor')).toBeNull()
  })

  it('edit mode is the shared document editor on the whole file, in Document mode', () => {
    const p = props()
    mount(p)
    const ed = q('doc-editor')!
    expect(ed.getAttribute('data-path')).toBe('/m/deploy_freeze.md')
    expect(ed.getAttribute('data-mode')).toBe('document')
    expect(ed.getAttribute('data-dirty')).toBe('true')
    expect(q('doc-editor-value')!.textContent).toBe('---\nname: x\n---\n\nhello\n')
    expect(q('mx-editor-body')).toBeNull()
    expect(q('mx-editor-name')).toBeNull()
    act(() => q('doc-editor-change')!.click())
    expect(p.onBody).toHaveBeenCalledWith('changed')
    act(() => q('doc-editor-save')!.click())
    expect(p.onSave).toHaveBeenCalledTimes(1)
    act(() => q('doc-editor-revert')!.click())
    expect(p.onRevert).toHaveBeenCalledTimes(1)
  })

  it('edit-mode Save is a no-op when clean or already saving', () => {
    const p = props({ dirty: false })
    mount(p)
    act(() => q('doc-editor-save')!.click())
    act(() => root!.render(createElement(MemoryEditorPane, { ...p, dirty: true, saving: true })))
    act(() => q('doc-editor-save')!.click())
    expect(p.onSave).not.toHaveBeenCalled()
  })

  it('new mode shows heading, name input with placeholder and slug hint', () => {
    mount(props({ mode: 'new', name: null, title: 'Deploy Freeze Fridays' }))
    expect(q('mx-editor')?.textContent).toContain('New memory')
    const input = q('mx-editor-name') as HTMLInputElement
    expect(input.placeholder).toBe('e.g. deploy freeze fridays')
    expect(q('mx-editor')?.textContent).toContain('deploy_freeze_fridays')
  })

  it('new mode: Save disabled only while saving', () => {
    mount(props({ mode: 'new', name: null, dirty: false }))
    expect((q('mx-editor-save') as HTMLButtonElement).disabled).toBe(false)
    act(() => root!.render(createElement(MemoryEditorPane, props({ mode: 'new', name: null, saving: true }))))
    expect((q('mx-editor-save') as HTMLButtonElement).disabled).toBe(true)
  })

  it('new mode: Cmd/Ctrl+S saves, Esc cancels, helper copy', () => {
    const p = props({ mode: 'new', name: null, body: 'hello' })
    mount(p)
    expect((q('mx-editor-body') as HTMLTextAreaElement).value).toBe('hello')
    expect(q('mx-editor')?.textContent).toContain('Markdown. Frontmatter is added on save. Saving marks the memory verified.')
    const ta = q('mx-editor-body')!
    act(() => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
    })
    expect(p.onSave).toHaveBeenCalledTimes(1)
    act(() => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
    })
    expect(p.onSave).toHaveBeenCalledTimes(2)
    act(() => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(p.onCancel).toHaveBeenCalledTimes(1)
    act(() => q('mx-editor-cancel')!.click())
    expect(p.onCancel).toHaveBeenCalledTimes(2)
  })
})
