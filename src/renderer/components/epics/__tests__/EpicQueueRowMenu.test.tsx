// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { EpicQueue } from '../EpicQueue'
import { usePromptSessions, type PromptSession, type PromptSessionEvent } from '../../../state/promptSessions'
import { useEpicTerminal } from '../../../state/epicTerminal'
import { toast } from '../../../state/toast'
import type { EpicSnapshots } from '../../../lib/epicDerive'
import { flushAsync } from '../../../testUtils/domFlush'

/**
 * Row overflow menu (PRDs 830/wire-row-menu) — the 8-action `useRowMenuItems`
 * list in EpicQueue.tsx, plus its RowEditor (rename/edit-goal). None of this
 * had direct coverage before: EpicQueue/EpicQueueControls tests only exercise
 * search/filter/group/sort/pin/paging/keyboard nav, which pass unchanged
 * even if every menu item were broken.
 *
 * Store actions (renameEpic/duplicateEpic/deleteEpic/resumeArchived/
 * markCompleted) already have full behavioral coverage in
 * state/__tests__/promptSessions.test.ts — these tests only assert the
 * component wires clicks to those actions correctly, so store methods are
 * spied rather than re-exercised end to end.
 */

const NOW = Date.parse('2026-08-01T12:00:00.000Z')

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

function makeEpic(overrides: Partial<PromptSession> = {}): PromptSession {
  return {
    id: overrides.id ?? 'epic-1',
    cwd: '/proj',
    goalText: 'Ship it\n\nGet it out the door.',
    claudeSessionId: 'claude-1',
    status: 'active',
    createdAt: new Date(NOW - 60_000).toISOString(),
    completedAt: null,
    tag: 'feature',
    ...overrides,
  }
}

function emptySnapshots(overrides: Partial<EpicSnapshots> = {}): EpicSnapshots {
  return { sessions: {}, chats: {}, jobs: [], prds: [], ...overrides }
}

function baseProps(epic: PromptSession, extra: Partial<React.ComponentProps<typeof EpicQueue>> = {}) {
  const snapshots = emptySnapshots({ sessions: { [epic.id]: epic } })
  return {
    epics: [epic],
    snapshots,
    events: {} as Record<string, PromptSessionEvent[]>,
    selectedId: null,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    now: NOW,
    // EpicQueue's default grouping starts the 'completed' section collapsed —
    // force every section open so a completed-epic row is always reachable.
    closedKeys: new Set<string>(),
    ...extra,
  }
}

function openMenu(el: HTMLElement) {
  const trigger = el.querySelector('[data-testid="epic-queue-row-menu-trigger"]') as HTMLButtonElement
  act(() => trigger.click())
  return el.querySelector('[data-testid="epic-queue-row-menu"]') as HTMLDivElement
}

function menuItemButtons(menu: HTMLElement) {
  return Array.from(menu.querySelectorAll('button'))
}

function clickMenuItem(menu: HTMLElement, label: string) {
  const btn = menuItemButtons(menu).find((b) => b.textContent === label) as HTMLButtonElement
  act(() => btn.click())
  return btn
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.restoreAllMocks()
})

describe('EpicQueue row menu', () => {
  it('opens on trigger click, closes on outside mousedown, and closes on Escape', () => {
    const epic = makeEpic()
    const el = mount(createElement(EpicQueue, baseProps(epic)))

    expect(el.querySelector('[data-testid="epic-queue-row-menu"]')).toBeNull()
    const menu = openMenu(el)
    expect(menu).not.toBeNull()

    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(el.querySelector('[data-testid="epic-queue-row-menu"]')).toBeNull()

    openMenu(el)
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(el.querySelector('[data-testid="epic-queue-row-menu"]')).toBeNull()
  })

  it('lists all 8 actions for an active Epic, hiding Reopen', () => {
    const epic = makeEpic({ status: 'active' })
    const el = mount(createElement(EpicQueue, baseProps(epic)))
    const menu = openMenu(el)
    const labels = menuItemButtons(menu).map((b) => b.textContent)

    expect(labels).toEqual([
      'Copy Epic ID',
      'Rename title',
      'Edit goal / first prompt',
      'Resume in terminal',
      'Mark completed',
      'Duplicate as new Epic',
      'Delete Epic',
    ])
  })

  it('hides Resume in terminal and Mark completed for a completed Epic, and shows Reopen instead', () => {
    const epic = makeEpic({ status: 'completed', completedAt: new Date().toISOString() })
    const el = mount(createElement(EpicQueue, baseProps(epic)))
    const menu = openMenu(el)
    const labels = menuItemButtons(menu).map((b) => b.textContent)

    expect(labels).toEqual([
      'Copy Epic ID',
      'Rename title',
      'Edit goal / first prompt',
      'Reopen',
      'Duplicate as new Epic',
      'Delete Epic',
    ])
  })

  it('Copy Epic ID writes the epic id to the clipboard', async () => {
    const epic = makeEpic({ id: 'epic-copy-me' })
    const el = mount(createElement(EpicQueue, baseProps(epic)))
    const menu = openMenu(el)
    clickMenuItem(menu, 'Copy Epic ID')
    await flushAsync(2)

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('epic-copy-me')
  })

  it('Mark completed calls the store markCompleted with the epic id', () => {
    const markCompleted = vi.spyOn(usePromptSessions.getState(), 'markCompleted').mockResolvedValue(undefined)
    const epic = makeEpic({ status: 'active' })
    const el = mount(createElement(EpicQueue, baseProps(epic)))
    const menu = openMenu(el)
    clickMenuItem(menu, 'Mark completed')

    expect(markCompleted).toHaveBeenCalledWith(epic.id, 'EpicQueue row menu')
  })

  it('Resume in terminal selects the epic and switches EpicTerminal mode to terminal', () => {
    const setMode = vi.spyOn(useEpicTerminal.getState(), 'setMode')
    const epic = makeEpic({ status: 'active' })
    const onSelect = vi.fn()
    const el = mount(createElement(EpicQueue, baseProps(epic, { onSelect })))
    const menu = openMenu(el)
    clickMenuItem(menu, 'Resume in terminal')

    expect(onSelect).toHaveBeenCalledWith(epic.id)
    expect(setMode).toHaveBeenCalledWith(epic.id, 'terminal')
  })

  describe('RowEditor (Rename / Edit goal)', () => {
    it('Rename title opens the inline editor prefilled with the title, Save is disabled until dirty + non-empty', () => {
      const epic = makeEpic()
      const el = mount(createElement(EpicQueue, baseProps(epic)))
      const menu = openMenu(el)
      clickMenuItem(menu, 'Rename title')

      const editor = el.querySelector('[data-testid="epic-queue-row-editor"]') as HTMLDivElement
      expect(editor).not.toBeNull()
      const titleInput = el.querySelector('[data-testid="epic-queue-row-editor-title"]') as HTMLInputElement
      expect(titleInput.value).toBe('Ship it')
      const saveBtn = el.querySelector('[data-testid="epic-queue-row-editor-save"]') as HTMLButtonElement
      expect(saveBtn.disabled).toBe(true)

      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setter.call(titleInput, 'A new title')
        titleInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(saveBtn.disabled).toBe(false)

      act(() => {
        setter.call(titleInput, '   ')
        titleInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(saveBtn.disabled).toBe(true)
    })

    it('Edit goal / first prompt opens the inline editor prefilled with the goal, focused on the goal textarea', () => {
      const epic = makeEpic()
      const el = mount(createElement(EpicQueue, baseProps(epic)))
      const menu = openMenu(el)
      clickMenuItem(menu, 'Edit goal / first prompt')

      const goalTextarea = el.querySelector('[data-testid="epic-queue-row-editor-goal"]') as HTMLTextAreaElement
      expect(goalTextarea).not.toBeNull()
      expect(goalTextarea.value).toBe('Get it out the door.')
    })

    it('Save calls renameEpic with the id, title, and goal', async () => {
      const renameEpic = vi.spyOn(usePromptSessions.getState(), 'renameEpic').mockResolvedValue(undefined)
      const epic = makeEpic()
      const el = mount(createElement(EpicQueue, baseProps(epic)))
      const menu = openMenu(el)
      clickMenuItem(menu, 'Rename title')

      const titleInput = el.querySelector('[data-testid="epic-queue-row-editor-title"]') as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setter.call(titleInput, 'Renamed')
        titleInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const saveBtn = el.querySelector('[data-testid="epic-queue-row-editor-save"]') as HTMLButtonElement
      act(() => saveBtn.click())
      await flushAsync(2)

      expect(renameEpic).toHaveBeenCalledWith(epic.id, 'Renamed', 'Get it out the door.')
    })

    it('Cancel discards the edit without calling renameEpic', () => {
      const renameEpic = vi.spyOn(usePromptSessions.getState(), 'renameEpic').mockResolvedValue(undefined)
      const epic = makeEpic()
      const el = mount(createElement(EpicQueue, baseProps(epic)))
      const menu = openMenu(el)
      clickMenuItem(menu, 'Rename title')

      const titleInput = el.querySelector('[data-testid="epic-queue-row-editor-title"]') as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setter.call(titleInput, 'Renamed')
        titleInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const cancelBtn = el.querySelector('[data-testid="epic-queue-row-editor-cancel"]') as HTMLButtonElement
      act(() => cancelBtn.click())

      expect(renameEpic).not.toHaveBeenCalled()
      expect(el.querySelector('[data-testid="epic-queue-row-editor"]')).toBeNull()
      expect(el.querySelector('[data-testid="epic-queue-row"]')).not.toBeNull()
    })

    it('Escape discards the edit without calling renameEpic', () => {
      const renameEpic = vi.spyOn(usePromptSessions.getState(), 'renameEpic').mockResolvedValue(undefined)
      const epic = makeEpic()
      const el = mount(createElement(EpicQueue, baseProps(epic)))
      const menu = openMenu(el)
      clickMenuItem(menu, 'Rename title')

      const editor = el.querySelector('[data-testid="epic-queue-row-editor"]') as HTMLDivElement
      const titleInput = el.querySelector('[data-testid="epic-queue-row-editor-title"]') as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setter.call(titleInput, 'Renamed')
        titleInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
      act(() => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))

      expect(renameEpic).not.toHaveBeenCalled()
      expect(el.querySelector('[data-testid="epic-queue-row-editor"]')).toBeNull()
    })
  })

  it('Duplicate as new Epic calls duplicateEpic and selects the returned epic', () => {
    const dup = makeEpic({ id: 'epic-dup', claudeSessionId: 'claude-dup' })
    const duplicateEpic = vi.spyOn(usePromptSessions.getState(), 'duplicateEpic').mockReturnValue(dup)
    const epic = makeEpic()
    const onSelect = vi.fn()
    const el = mount(createElement(EpicQueue, baseProps(epic, { onSelect })))
    const menu = openMenu(el)
    clickMenuItem(menu, 'Duplicate as new Epic')

    expect(duplicateEpic).toHaveBeenCalledWith(epic.id, 'EpicQueue row menu')
    expect(onSelect).toHaveBeenCalledWith('epic-dup')
  })

  describe('Delete Epic', () => {
    it('requires a second click within the confirm window before calling deleteEpic', () => {
      const deleteEpic = vi.spyOn(usePromptSessions.getState(), 'deleteEpic').mockResolvedValue(undefined)
      const epic = makeEpic()
      const el = mount(createElement(EpicQueue, baseProps(epic)))
      const menu = openMenu(el)

      const first = clickMenuItem(menu, 'Delete Epic')
      expect(deleteEpic).not.toHaveBeenCalled()
      expect(first.getAttribute('data-testid')).toBe('epic-queue-row-menu-confirm')
      expect(first.textContent).toBe('Click again to delete…')

      act(() => first.click())
      expect(deleteEpic).toHaveBeenCalledWith(epic.id, 'EpicQueue row menu')
    })

    it('surfaces a thrown deleteEpic error via toast.error and leaves the row in place', async () => {
      vi.spyOn(usePromptSessions.getState(), 'deleteEpic').mockRejectedValue(new Error('cannot delete: job running'))
      const toastError = vi.spyOn(toast, 'error')
      const epic = makeEpic()
      const el = mount(createElement(EpicQueue, baseProps(epic)))
      const menu = openMenu(el)

      const first = clickMenuItem(menu, 'Delete Epic')
      act(() => first.click())
      await flushAsync(2)

      expect(toastError).toHaveBeenCalledWith('cannot delete: job running')
      expect(el.querySelector('[data-epic-id="epic-1"]')).not.toBeNull()
    })
  })

  it('Reopen calls resumeArchived with the epic id', () => {
    const resumeArchived = vi.spyOn(usePromptSessions.getState(), 'resumeArchived').mockReturnValue(makeEpic())
    const epic = makeEpic({ status: 'completed', completedAt: new Date().toISOString() })
    const el = mount(createElement(EpicQueue, baseProps(epic)))
    const menu = openMenu(el)
    clickMenuItem(menu, 'Reopen')

    expect(resumeArchived).toHaveBeenCalledWith(epic.id, 'EpicQueue row menu')
  })
})
