// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MemoryEditorPane } from '../memory/explorer/MemoryEditorPane'

let container: HTMLDivElement | null = null
let root: Root | null = null

function props(over: Record<string, unknown> = {}) {
  return {
    mode: 'edit' as 'edit' | 'new' | 'none',
    name: 'deploy_freeze',
    title: '',
    onTitle: vi.fn(),
    body: 'hello',
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

  it('edit mode shows heading, textarea, helper, unsaved marker, no name field', () => {
    mount(props())
    expect(q('mx-editor')?.textContent).toContain('Editing deploy_freeze')
    expect(q('mx-editor-name')).toBeNull()
    expect((q('mx-editor-body') as HTMLTextAreaElement).value).toBe('hello')
    expect(q('mx-editor')?.textContent).toContain(
      'Markdown. Frontmatter is kept on save. Saving marks the memory verified.',
    )
    expect(q('mx-editor')?.textContent).toContain('unsaved')
  })

  it('new mode shows heading, name input with placeholder and slug hint', () => {
    mount(props({ mode: 'new', name: null, title: 'Deploy Freeze Fridays' }))
    expect(q('mx-editor')?.textContent).toContain('New memory')
    const input = q('mx-editor-name') as HTMLInputElement
    expect(input.placeholder).toBe('e.g. deploy freeze fridays')
    expect(q('mx-editor')?.textContent).toContain('deploy_freeze_fridays')
  })

  it('Save disabled rules', () => {
    mount(props({ dirty: false }))
    expect((q('mx-editor-save') as HTMLButtonElement).disabled).toBe(true)
    act(() => root!.render(createElement(MemoryEditorPane, props({ dirty: true }))))
    expect((q('mx-editor-save') as HTMLButtonElement).disabled).toBe(false)
    act(() => root!.render(createElement(MemoryEditorPane, props({ dirty: true, saving: true }))))
    expect((q('mx-editor-save') as HTMLButtonElement).disabled).toBe(true)
    act(() => root!.render(createElement(MemoryEditorPane, props({ mode: 'new', name: null, dirty: false }))))
    expect((q('mx-editor-save') as HTMLButtonElement).disabled).toBe(false)
  })

  it('Cmd/Ctrl+S saves when enabled, Esc cancels', () => {
    const p = props()
    mount(p)
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
  })

  it('Cmd+S does nothing when Save is disabled; buttons wire up', () => {
    const p = props({ dirty: false })
    mount(p)
    act(() => {
      q('mx-editor-body')!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
    })
    expect(p.onSave).not.toHaveBeenCalled()
    act(() => q('mx-editor-cancel')!.click())
    expect(p.onCancel).toHaveBeenCalledTimes(1)
  })
})
