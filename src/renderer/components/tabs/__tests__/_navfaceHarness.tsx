import { createElement, type ComponentType } from 'react'
import { afterEach, beforeEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useLayout } from '../../../state/layout'
import { useSessions, type SessionTab } from '../../../state/sessions'
import { useConfig } from '../../../state/config'

/**
 * Shared fixtures/helpers for the *.navface.test.tsx files whose tabs expose
 * a User/Project/Local scope switcher and (optionally) a view-tab toolbar.
 */

export const HOME = '/home/bilko'
export const PROJECT_CWD = '/home/bilko/Projects/alpha'

export const PROJECT_TAB: SessionTab = {
  id: 'tab-alpha',
  sessionId: 'tab-alpha',
  label: 'alpha',
  cwd: PROJECT_CWD,
  pid: null,
  status: 'dormant',
  exitCode: null,
  startupCommand: null,
  presetId: null,
  generation: 0,
}

/**
 * Registers beforeEach/afterEach (call at module or describe level) and
 * returns `mount` for the given component. `installApi` installs the
 * per-tab window.api mock.
 */
export function useNavfaceHarness(Component: ComponentType, installApi: () => unknown) {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  async function mount() {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(Component))
      await Promise.resolve()
      await Promise.resolve()
    })
    return container
  }

  beforeEach(() => {
    installApi()
    useLayout.setState({ navFace: 'home' })
    useSessions.setState({ tabs: [], activeTabId: null })
    useConfig.setState({ files: {}, watchRefs: {} })
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
    delete (window as unknown as { api?: unknown }).api
  })

  return { mount }
}

const SCOPE_LABELS = ['User', 'Project', 'Local']

export function activeScope(el: HTMLElement): string | null {
  const btn = Array.from(el.querySelectorAll('button')).find(
    (b) => SCOPE_LABELS.includes(b.textContent?.trim() ?? '') && b.classList.contains('bg-bg-hi'),
  )
  return btn?.textContent?.trim() ?? null
}

export function clickScope(el: HTMLElement, label: string) {
  const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
  ;(btn as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

export function viewTabLabels(el: HTMLElement): string[] {
  const toolbar = el.querySelector('.flex.rounded.border.border-line.overflow-hidden')
  return Array.from(toolbar?.querySelectorAll('button') ?? []).map((b) => b.textContent?.trim() ?? '')
}

export function clickViewTab(el: HTMLElement, label: string) {
  const toolbar = el.querySelector('.flex.rounded.border.border-line.overflow-hidden')
  const btn = Array.from(toolbar?.querySelectorAll('button') ?? []).find((b) => b.textContent?.trim() === label)
  ;(btn as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
}
