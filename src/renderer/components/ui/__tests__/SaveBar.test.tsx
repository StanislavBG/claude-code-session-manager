// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { useRef, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SaveBar } from '../SaveBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CLEAN = 'Saved — matches the file on disk'
const noop = () => {}

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  // setPlatform() shadows jsdom's prototype getter with an own property; drop it.
  Reflect.deleteProperty(window.navigator, 'platform')
  vi.restoreAllMocks()
})

/** First call mounts; later calls re-render the same root, like a parent updating props. */
function render(ui: ReactElement) {
  if (!container) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  act(() => root!.render(ui))
}

const q = (id: string) => container!.querySelector<HTMLElement>(`[data-testid="${id}"]`)
/** The bar's buttons are always [Revert, Save]. */
const saveButton = () => container!.querySelectorAll('button')[1]

function setPlatform(platform: string) {
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true })
}

describe('SaveBar — clean label (opt-in)', () => {
  it('shows a 6px sage dot and the clean label in place of "saved Ns ago" when clean', () => {
    render(<SaveBar dirty={false} busy={false} lastSavedAt={Date.now() - 10_000} onSave={noop} onRevert={noop} cleanLabel={CLEAN} />)
    const clean = q('savebar-clean')
    expect(clean?.textContent).toBe(CLEAN)
    expect(clean!.className).toMatch(/\btext-fg-faint\b/)
    const dot = clean!.firstElementChild as HTMLElement
    expect(dot.className.split(/\s+/)).toEqual(expect.arrayContaining(['w-1.5', 'h-1.5', 'rounded-full', 'bg-sage']))
    expect(container!.textContent).not.toMatch(/saved \d+s ago/)
  })

  it('hides the clean label while dirty or on a parse error', () => {
    const props = { busy: false, onSave: noop, onRevert: noop, cleanLabel: CLEAN }
    render(<SaveBar {...props} dirty />)
    expect(q('savebar-clean')).toBeNull()
    expect(container!.textContent).toContain('unsaved')
    render(<SaveBar {...props} dirty={false} parseError="Unexpected token" />)
    expect(q('savebar-clean')).toBeNull()
    expect(container!.textContent).toContain('Unexpected token')
  })

  it('renders as before when no opt-in prop is passed', () => {
    render(<SaveBar dirty={false} busy={false} lastSavedAt={Date.now() - 10_000} onSave={noop} onRevert={noop} />)
    expect(q('savebar-clean')).toBeNull()
    expect(container!.textContent).toMatch(/saved 10s ago/)
    expect(container!.querySelector('kbd')).toBeNull()
    expect(saveButton().innerHTML).toBe('Save')
    expect(saveButton().hasAttribute('aria-keyshortcuts')).toBe(false)
  })
})

describe('SaveBar — shortcut hint', () => {
  it.each([
    ['Linux x86_64', 'Ctrl S'],
    ['Win32', 'Ctrl S'],
    ['MacIntel', '⌘S'],
  ])('on %s the Save button shows a mono "%s" kbd', (platform, label) => {
    setPlatform(platform)
    render(<SaveBar dirty={false} busy={false} onSave={noop} onRevert={noop} shortcutHint />)
    const kbd = saveButton().querySelector('kbd')
    expect(kbd?.textContent).toBe(label)
    expect(kbd!.className).toMatch(/\bfont-mono\b/)
  })
})

interface PaneProps {
  dirty: boolean
  busy?: boolean
  parseError?: string | null
  onSave: () => void
  shortcutHint?: boolean
  scoped?: boolean
}

/** A caller's pane: the scope wraps an editor and the bar; one field sits outside it. */
function Pane({ dirty, busy = false, parseError = null, onSave, shortcutHint = true, scoped = true }: PaneProps) {
  const scopeRef = useRef<HTMLDivElement>(null)
  return (
    <div>
      <input data-testid="outside" />
      <div ref={scopeRef}>
        <textarea data-testid="inside" />
        <SaveBar
          dirty={dirty}
          busy={busy}
          parseError={parseError}
          onSave={onSave}
          onRevert={noop}
          shortcutHint={shortcutHint}
          scopeRef={scoped ? scopeRef : undefined}
        />
      </div>
    </div>
  )
}

/** Focus `id`, then press a key there the way a user would (bubbling, cancelable). */
function pressIn(id: string, init: KeyboardEventInit = { key: 's', ctrlKey: true }) {
  const el = q(id)!
  el.focus()
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => { el.dispatchEvent(ev) })
  return ev
}

describe('SaveBar — Ctrl/Cmd+S inside the scope', () => {
  it('saves on Ctrl+S and Cmd+S when focus is inside the scope and the bar is dirty', () => {
    const onSave = vi.fn()
    render(<Pane dirty onSave={onSave} />)
    expect(pressIn('inside').defaultPrevented).toBe(true)
    expect(pressIn('inside', { key: 's', metaKey: true }).defaultPrevented).toBe(true)
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(saveButton().getAttribute('aria-keyshortcuts')).toBe('Control+S')
  })

  it('does nothing when focus is outside the scope', () => {
    const onSave = vi.fn()
    render(<Pane dirty onSave={onSave} />)
    expect(pressIn('outside').defaultPrevented).toBe(false)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('does nothing when the save is not allowed: clean, busy, or a parse error', () => {
    const onSave = vi.fn()
    render(<Pane dirty={false} onSave={onSave} />)
    expect(pressIn('inside').defaultPrevented).toBe(false)
    render(<Pane dirty busy onSave={onSave} />)
    expect(pressIn('inside').defaultPrevented).toBe(false)
    render(<Pane dirty parseError="Unexpected token" onSave={onSave} />)
    expect(pressIn('inside').defaultPrevented).toBe(false)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('ignores a plain "s", other modifier combos, and a Ctrl+S an inner handler already took', () => {
    const onSave = vi.fn()
    render(<Pane dirty onSave={onSave} />)
    pressIn('inside', { key: 's' })
    pressIn('inside', { key: 'S', ctrlKey: true, shiftKey: true })
    pressIn('inside', { key: 's', ctrlKey: true, altKey: true })
    q('inside')!.addEventListener('keydown', (e) => e.preventDefault())
    pressIn('inside')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('listens only with both shortcutHint and scopeRef, and removes its listener on unmount', () => {
    const onSave = vi.fn()
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    render(<Pane dirty onSave={onSave} shortcutHint={false} />)
    pressIn('inside')
    render(<Pane dirty onSave={onSave} scoped={false} />)
    pressIn('inside')
    expect(onSave).not.toHaveBeenCalled()
    expect(add.mock.calls.some(([type]) => type === 'keydown')).toBe(false)

    render(<Pane dirty onSave={onSave} />)
    pressIn('inside')
    expect(onSave).toHaveBeenCalledTimes(1)
    const added = add.mock.calls.filter(([type]) => type === 'keydown').map(([, fn]) => fn)
    expect(added).toHaveLength(1)
    act(() => root!.unmount())
    root = null
    const removed = remove.mock.calls.filter(([type]) => type === 'keydown').map(([, fn]) => fn)
    expect(removed).toEqual(added)
  })
})
