// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { PasteThumbnail } from '../PasteThumbnail'

// Covers the AC: thumbnail renders on a successful image paste (img.ok) and does not
// linger after a load failure. The "does not render on a text-only paste" half of the
// AC is covered at the call-site data layer — Terminal.tsx / TerminalChat.tsx only
// mount <PasteThumbnail> when a paste actually resolved to an image path (see
// tests/unit/pasteImageIntoChat.spec.ts: imagePath is undefined on text-only paste).

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

describe('PasteThumbnail', () => {
  it('renders an img pointed at the smfile:// URL for the pasted path', () => {
    const el = mount(<PasteThumbnail path="/tmp/session-manager-clipboard/clipboard-1.png" onDismiss={vi.fn()} />)
    const img = el.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe('smfile://local/tmp/session-manager-clipboard/clipboard-1.png')
  })

  it('calls onDismiss when the dismiss button is clicked', () => {
    const onDismiss = vi.fn()
    const el = mount(<PasteThumbnail path="/tmp/foo.png" onDismiss={onDismiss} />)
    const btn = el.querySelector('button')!
    act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('hides itself silently when the image fails to load', () => {
    const el = mount(<PasteThumbnail path="/tmp/missing.png" onDismiss={vi.fn()} />)
    const img = el.querySelector('img')!
    act(() => img.dispatchEvent(new Event('error')))
    expect(el.querySelector('img')).toBeNull()
    expect(el.innerHTML).toBe('')
  })
})
