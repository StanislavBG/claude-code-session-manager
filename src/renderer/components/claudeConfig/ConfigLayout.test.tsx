// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import type { ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

import {
  ConfigCard,
  ConfigDetailHeader,
  ConfigFileCard,
  ConfigListRow,
  ConfigListToolbar,
  ConfigSavedLine,
  ConfigWorkbench,
} from './ConfigLayout'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(el: ReactElement) {
  act(() => root.render(el))
}

const rows = () => Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))

describe('ConfigLayout', () => {
  it('renders the workbench with a file card, rows, a detail header and a saved line', () => {
    render(
      <ConfigWorkbench
        list={
          <>
            <ConfigFileCard eyebrow="AGENTS FOLDER" badge={9} path="~/.claude/agents/" note="The actor a session opens with" />
            <ConfigListRow title="architect" meta="Designs the shape" trailing="opus" selected onSelect={vi.fn()} />
          </>
        }
        detail={
          <>
            <ConfigDetailHeader eyebrow="AGENT · USER" title="architect" pill="opus" actions={<button type="button">Duplicate</button>} />
            <ConfigSavedLine text="Saved · matches the file on disk" />
          </>
        }
      />,
    )
    const text = container.textContent ?? ''
    for (const s of ['AGENTS FOLDER', '9', '~/.claude/agents/', 'The actor a session opens with', 'architect', 'Designs the shape', 'opus', 'AGENT · USER', 'Duplicate', 'Saved · matches the file on disk']) {
      expect(text).toContain(s)
    }
    expect(container.querySelector('[data-testid="config-workbench-list"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="config-workbench-detail"]')).not.toBeNull()
  })

  it('row click calls onSelect and the selected row has aria-selected=true', () => {
    const a = vi.fn()
    const b = vi.fn()
    render(
      <div role="listbox" aria-label="Agents">
        <ConfigListRow title="architect" selected onSelect={a} />
        <ConfigListRow title="builder" selected={false} muted onSelect={b} />
      </div>,
    )
    expect(rows().map((r) => r.getAttribute('aria-selected'))).toEqual(['true', 'false'])
    act(() => rows()[1].click())
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).not.toHaveBeenCalled()
  })

  it('filter typing calls onFilterChange and the primary button calls onPrimary', () => {
    const onFilterChange = vi.fn()
    const onPrimary = vi.fn()
    render(
      <ConfigListToolbar filter="" onFilterChange={onFilterChange} placeholder="Filter" primaryLabel="+ New" onPrimary={onPrimary} />,
    )
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input, 'arch')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onFilterChange).toHaveBeenLastCalledWith('arch')
    const btn = Array.from(container.querySelectorAll('button')).find((x) => x.textContent === '+ New')!
    act(() => btn.click())
    expect(onPrimary).toHaveBeenCalledTimes(1)
  })

  it('ConfigCard renders its label, label note and action', () => {
    const onReveal = vi.fn()
    render(
      <ConfigCard label="INSTALLED AT" labelNote="user scope" action={<button type="button" onClick={onReveal}>Reveal</button>}>
        <span>~/.claude/plugins/x</span>
      </ConfigCard>,
    )
    const text = container.textContent ?? ''
    expect(text).toContain('INSTALLED AT')
    expect(text).toContain('user scope')
    expect(text).toContain('~/.claude/plugins/x')
    const btn = Array.from(container.querySelectorAll('button')).find((x) => x.textContent === 'Reveal')!
    act(() => btn.click())
    expect(onReveal).toHaveBeenCalledTimes(1)
  })

  it('uses no raw hex in any className', () => {
    render(
      <ConfigWorkbench
        list={
          <>
            <ConfigFileCard eyebrow="E" badge="3" path="p" note="n" />
            <ConfigListToolbar filter="" onFilterChange={vi.fn()} placeholder="Filter" primaryLabel="+ Add" onPrimary={vi.fn()} secondary={<span>x</span>} />
            <ConfigListRow title="a" meta="m" trailing="t" selected onSelect={vi.fn()} />
            <ConfigListRow title="b" selected={false} muted onSelect={vi.fn()} />
          </>
        }
        detail={
          <>
            <ConfigDetailHeader eyebrow="E" title="T" pill="p" />
            <ConfigCard label="L">c</ConfigCard>
            <ConfigSavedLine text="s" />
          </>
        }
      />,
    )
    const classes = Array.from(container.querySelectorAll<HTMLElement>('[class]')).map((el) => el.getAttribute('class') ?? '')
    expect(classes.length).toBeGreaterThan(0)
    for (const c of classes) expect(c).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
