// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { SettingsEpicIsolation } from '../SettingsEpicIsolation'

/**
 * PRD 1035 — the per-project "disable Epic worktree isolation" toggle,
 * the UI-reachable equivalent of setting SM_EPIC_WORKTREE_DISABLE=1 for
 * just one project. Reuses SaveBar's dirty/save/revert shape.
 */

/** What the card's SourceChip reads (home dir + file mtime). */
function chipApi() {
  return {
    app: { homeDir: vi.fn().mockResolvedValue('/home/u') },
    config: { readText: vi.fn().mockResolvedValue({ exists: false, mtimeMs: 0 }), onChanged: vi.fn(() => () => {}) },
  }
}

function installWindowApiMock(opts: { disabled?: boolean } = {}) {
  const getWorktreeDisabled = vi.fn().mockResolvedValue({ disabled: opts.disabled ?? false })
  const setWorktreeDisabled = vi.fn(async ({ disabled }: { cwd: string; disabled: boolean }) => ({ disabled }))
  ;(window as unknown as { api: unknown }).api = {
    ...chipApi(),
    promptSessions: { getWorktreeDisabled, setWorktreeDisabled },
  }
  return { getWorktreeDisabled, setWorktreeDisabled }
}

/** The shared Toggle's switch button — the card no longer renders a raw checkbox. */
const toggle = (el: HTMLElement) =>
  el.querySelector('[data-testid="settings-epic-isolation-toggle"] [role="switch"]') as HTMLButtonElement

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

describe('SettingsEpicIsolation (PRD 1035)', () => {
  beforeEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
  })

  it('loads the current per-project value and starts unchecked/not dirty when isolation is enabled', async () => {
    const { getWorktreeDisabled } = installWindowApiMock({ disabled: false })
    const el = mount(createElement(SettingsEpicIsolation, { cwd: '/proj/alpha' }))
    await act(async () => {
      await flushAsync()
    })
    expect(getWorktreeDisabled).toHaveBeenCalledWith({ cwd: '/proj/alpha' })
    const checkbox = toggle(el)
    expect(checkbox.getAttribute('aria-checked')).toBe('false')
    // No dirty SaveBar shown until the human actually changes the value.
    expect(el.textContent).not.toContain('unsaved')
  })

  it('starts checked when the project already has isolation disabled', async () => {
    installWindowApiMock({ disabled: true })
    const el = mount(createElement(SettingsEpicIsolation, { cwd: '/proj/alpha' }))
    await act(async () => {
      await flushAsync()
    })
    const checkbox = toggle(el)
    expect(checkbox.getAttribute('aria-checked')).toBe('true')
  })

  it('toggling the checkbox shows unsaved state, and Save persists it via setWorktreeDisabled', async () => {
    const { setWorktreeDisabled } = installWindowApiMock({ disabled: false })
    const el = mount(createElement(SettingsEpicIsolation, { cwd: '/proj/alpha' }))
    await act(async () => {
      await flushAsync()
    })
    const checkbox = toggle(el)
    act(() => {
      checkbox.click()
    })
    expect(checkbox.getAttribute('aria-checked')).toBe('true')
    expect(el.textContent).toContain('unsaved')

    const saveButton = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Save')!
    await act(async () => {
      saveButton.click()
      await flushAsync()
    })
    expect(setWorktreeDisabled).toHaveBeenCalledWith({ cwd: '/proj/alpha', disabled: true })
    expect(el.textContent).not.toContain('unsaved')
  })

  it('renders on the design: ConfigDetailHeader + ConfigCard naming its file, no raw checkbox', async () => {
    installWindowApiMock({ disabled: false })
    const el = mount(createElement(SettingsEpicIsolation, { cwd: '/proj/alpha' }))
    await act(async () => {
      await flushAsync()
    })
    expect(el.querySelector('[data-testid="config-detail-header"]')?.textContent).toContain('Epic isolation')
    const card = el.querySelector('[data-testid="config-card"]')!
    expect(card.textContent).toContain('session-manager-operations/prompt-sessions/epic-worktree-config.json')
    expect(el.querySelector('input[type="checkbox"]')).toBeNull()
  })

  it('degrades to an unchecked, still-usable toggle when window.api has no promptSessions surface', async () => {
    ;(window as unknown as { api: unknown }).api = chipApi()
    const el = mount(createElement(SettingsEpicIsolation, { cwd: '/proj/alpha' }))
    await act(async () => {
      await flushAsync()
    })
    const checkbox = toggle(el)
    expect(checkbox.getAttribute('aria-checked')).toBe('false')
    expect(checkbox.disabled).toBe(false)
  })
})
