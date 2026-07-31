// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { openPrdSlug, openPromptSession, TagSelector } from '../epicNav'
import { takePendingPrdSlug } from '../prdDeepLink'
import { takePendingPromptSessionId } from '../promptSessionDeepLink'

/**
 * Coverage for the three exports moved out of the retired TerminalChat.tsx
 * (openPrdSlug/openPromptSession/TagSelector) — replaces the equivalent
 * assertions from the deleted QueueTicketPanel.test.tsx.
 */

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('openPrdSlug', () => {
  it('sets the pending PRD slug and dispatches sm:navigate to scheduler', () => {
    const navHandler = vi.fn()
    window.addEventListener('sm:navigate', navHandler)
    try {
      openPrdSlug('123-do-the-thing')
      expect(takePendingPrdSlug()).toBe('123-do-the-thing')
      expect(navHandler).toHaveBeenCalledTimes(1)
      expect((navHandler.mock.calls[0][0] as CustomEvent<string>).detail).toBe('scheduler')
    } finally {
      window.removeEventListener('sm:navigate', navHandler)
    }
  })
})

describe('openPromptSession', () => {
  it('sets the pending prompt session id and dispatches sm:navigate to terminal', () => {
    const navHandler = vi.fn()
    window.addEventListener('sm:navigate', navHandler)
    try {
      openPromptSession('psess-abc')
      expect(takePendingPromptSessionId()).toBe('psess-abc')
      expect(navHandler).toHaveBeenCalledTimes(1)
      expect((navHandler.mock.calls[0][0] as CustomEvent<string>).detail).toBe('terminal')
    } finally {
      window.removeEventListener('sm:navigate', navHandler)
    }
  })
})

describe('TagSelector', () => {
  it('marks the current value as pressed and fires onChange for the other options', () => {
    const onChange = vi.fn()
    const el = mount(<TagSelector value="feature" onChange={onChange} />)
    const buttons = Array.from(el.querySelectorAll('button'))
    const feature = buttons.find((b) => b.textContent === 'Feature')!
    const bug = buttons.find((b) => b.textContent === 'Bug')!
    const discussion = buttons.find((b) => b.textContent === 'Discussion')!

    expect(feature.getAttribute('aria-pressed')).toBe('true')
    expect(bug.getAttribute('aria-pressed')).toBe('false')
    expect(discussion.getAttribute('aria-pressed')).toBe('false')

    act(() => {
      bug.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith('bug')
  })

  it('disables all buttons when disabled is true', () => {
    const el = mount(<TagSelector value="feature" onChange={vi.fn()} disabled />)
    const buttons = Array.from(el.querySelectorAll('button'))
    expect(buttons.every((b) => b.disabled)).toBe(true)
  })
})
