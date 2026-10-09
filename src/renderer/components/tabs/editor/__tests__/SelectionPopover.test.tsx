// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { SelectionPopover } from '../SelectionPopover'

/**
 * The popover must never steal focus from the document selection (focusing an
 * input collapses it, so ⌘C copied nothing), and must offer an explicit Copy.
 */

const noop = () => {}
const writeText = vi.fn().mockResolvedValue({ ok: true })

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount() {
  ;(window as any).api = { clipboard: { writeText } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() =>
    root!.render(
      createElement(SelectionPopover, {
        phase: 'popover',
        rect: { top: 100, left: 100, width: 10, height: 10 } as any,
        selectedText: 'hello selection',
        diff: null,
        transcript: '',
        modelStatus: null,
        onQuickAction: noop,
        onRunCustom: noop,
        onListen: noop,
        onSendHeard: noop,
        onCancel: noop,
        onAccept: noop,
        onReject: noop,
        onRetry: noop,
      }),
    ),
  )
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  writeText.mockClear()
})

describe('SelectionPopover', () => {
  it('does not focus the instruction input on mount', () => {
    const el = mount()
    const input = el.querySelector('input')!
    expect(input).toBeTruthy()
    expect(document.activeElement).not.toBe(input)
  })

  it('Copy button writes the selected text via the clipboard IPC', async () => {
    const el = mount()
    const btn = el.querySelector('[data-testid="doc-edit-copy"]') as HTMLButtonElement
    expect(btn.textContent).toBe('Copy')
    await act(async () => {
      btn.click()
    })
    expect(writeText).toHaveBeenCalledWith('hello selection')
    expect(btn.textContent).toBe('Copied')
  })
})
