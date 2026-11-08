// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FolderTabs } from '../FolderTabs'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Key = 'skills' | 'mcp' | 'plugins'
const OPTIONS: ReadonlyArray<{ key: Key; label: string; count?: number | null }> = [
  { key: 'skills', label: 'Skills', count: 12 },
  { key: 'mcp', label: 'MCP Servers', count: null },
  { key: 'plugins', label: 'Plugins', count: 0 },
]

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

function render(ui: ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(ui))
}

const tab = (key: string) => container!.querySelector<HTMLButtonElement>(`[data-testid="folder-tab-${key}"]`)!
const count = (key: string) => container!.querySelector(`[data-testid="folder-tab-count-${key}"]`)

function press(key: string) {
  const el = document.activeElement as HTMLElement
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
}

/** Owns `active` the way a real caller does, so arrow keys move real selection. */
function Harness({ initial, onChange }: { initial: Key; onChange: (k: Key) => void }) {
  const [active, setActive] = useState<Key>(initial)
  return (
    <FolderTabs
      options={OPTIONS}
      active={active}
      onChange={(k) => { onChange(k); setActive(k) }}
      ariaLabel="Extensions"
    />
  )
}

describe('FolderTabs', () => {
  it('renders a labelled tablist of tab buttons with the trailing slot right-aligned after it', () => {
    render(
      <FolderTabs
        options={OPTIONS}
        active="skills"
        onChange={() => {}}
        ariaLabel="Extensions"
        trailing={<span data-testid="sources">~/.claude/skills</span>}
      />,
    )
    const list = container!.querySelector('[role="tablist"]')!
    expect(list.getAttribute('aria-label')).toBe('Extensions')
    const tabs = Array.from(list.children)
    expect(tabs.map((t) => t.getAttribute('role'))).toEqual(['tab', 'tab', 'tab'])
    expect(tabs.every((t) => t.tagName === 'BUTTON')).toBe(true)
    expect(tabs.map((t) => t.getAttribute('data-testid'))).toEqual([
      'folder-tab-skills',
      'folder-tab-mcp',
      'folder-tab-plugins',
    ])
    const slot = container!.querySelector('[data-testid="sources"]')!.parentElement!
    expect(slot.classList.contains('ml-auto')).toBe(true)
    expect(list.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('clicking an inactive tab calls onChange with its key; the active tab does not re-fire', () => {
    const onChange = vi.fn()
    render(<FolderTabs options={OPTIONS} active="skills" onChange={onChange} ariaLabel="Extensions" />)
    act(() => tab('plugins').click())
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('plugins')
    act(() => tab('skills').click())
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('sets aria-selected, tabIndex 0 and the open-folder shape on the active tab only', () => {
    render(<FolderTabs options={OPTIONS} active="mcp" onChange={() => {}} ariaLabel="Extensions" />)
    expect(['skills', 'mcp', 'plugins'].map((k) => tab(k).getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ])
    expect(['skills', 'mcp', 'plugins'].map((k) => tab(k).tabIndex)).toEqual([-1, 0, -1])
    expect(tab('mcp').className).toContain('h-[41px]')
    expect(tab('mcp').className).toContain('border-b-bg-elev')
    expect(tab('skills').className).toContain('h-[38px]')
    expect(tab('skills').className).not.toContain('border-accent')
  })

  it('renders the count only when it is a number (0 shown, null and absent hidden)', () => {
    render(
      <FolderTabs
        options={[...OPTIONS, { key: 'extra', label: 'Extra' }]}
        active="skills"
        onChange={() => {}}
        ariaLabel="Extensions"
      />,
    )
    expect(count('skills')?.textContent).toBe('12')
    expect(count('skills')!.className).toContain('text-accent')
    expect(count('plugins')?.textContent).toBe('0')
    expect(count('plugins')!.className).toContain('text-fg-faint')
    expect(count('mcp')).toBeNull()
    expect(count('extra')).toBeNull()
    expect(tab('mcp').textContent).toBe('MCP Servers')
  })

  it('ArrowRight/ArrowLeft move selection and focus with wrap-around (roving tabIndex)', () => {
    const onChange = vi.fn()
    render(<Harness initial="plugins" onChange={onChange} />)
    act(() => tab('plugins').focus())

    press('ArrowRight')
    expect(onChange).toHaveBeenLastCalledWith('skills')
    expect(document.activeElement).toBe(tab('skills'))
    expect(['skills', 'mcp', 'plugins'].map((k) => tab(k).tabIndex)).toEqual([0, -1, -1])

    press('ArrowLeft')
    expect(onChange).toHaveBeenLastCalledWith('plugins')
    expect(document.activeElement).toBe(tab('plugins'))
    expect(tab('plugins').getAttribute('aria-selected')).toBe('true')

    press('ArrowLeft')
    expect(onChange).toHaveBeenLastCalledWith('mcp')
    expect(document.activeElement).toBe(tab('mcp'))

    press('Enter')
    expect(onChange).toHaveBeenCalledTimes(3)
  })
})
