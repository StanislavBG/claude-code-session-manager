// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { BudgetStrip } from '../BudgetStrip'
import { useToast } from '../../../../../state/toast'
import type { HistoryDashboardDay } from '../../../../../../preload/api'

let container: HTMLDivElement
let root: Root
let store: Record<string, unknown>
let readJson: ReturnType<typeof vi.fn>
let writeJson: ReturnType<typeof vi.fn>

function installApi() {
  store = {}
  readJson = vi.fn(async () => ({ exists: Object.keys(store).length > 0, data: { ...store } }))
  writeJson = vi.fn(async (_path: string, data: unknown) => {
    store = { ...(data as Record<string, unknown>) }
    return { ok: true, mtimeMs: Date.now() }
  })
  ;(globalThis as any).window.api = { config: { readJson, writeJson } }
}

async function mountAndHydrate(days: HistoryDashboardDay[] = []) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(BudgetStrip, { days }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(async () => {
  installApi()
  await mountAndHydrate()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (globalThis as any).window?.api
})

const capInput = () => container.querySelector('input[type="number"]') as HTMLInputElement

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('BudgetStrip', () => {
  it('paints with the default $50 cap before hydration resolves', async () => {
    act(() => root.unmount())
    container.remove()
    installApi()
    let resolveRead!: (v: { exists: boolean; data: unknown }) => void
    readJson.mockReturnValueOnce(new Promise((r) => { resolveRead = r }))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => { root.render(createElement(BudgetStrip, { days: [] })) })
    expect(capInput().value).toBe('50')
    await act(async () => {
      resolveRead({ exists: true, data: { history: { budgetCapUsd: 120 } } })
      await Promise.resolve()
    })
    expect(capInput().value).toBe('120')
  })

  it('hydrates a persisted cap from ui-settings-prefs.json', async () => {
    act(() => root.unmount())
    container.remove()
    installApi()
    store.history = { budgetCapUsd: 200 }
    await mountAndHydrate()
    expect(capInput().value).toBe('200')
  })

  it('persists a cap change via the IPC config path, preserving sibling history fields', async () => {
    store.history = { measure: 'spend', range: 30 }
    await act(async () => {
      setNativeValue(capInput(), '75')
      await Promise.resolve()
    })
    expect(writeJson).toHaveBeenCalledWith(
      '~/.claude/session-manager/ui-settings-prefs.json',
      expect.objectContaining({ history: expect.objectContaining({ measure: 'spend', range: 30, budgetCapUsd: 75 }) }),
    )
  })

  it('reverts and toasts when the write fails (never swallow errors)', async () => {
    useToast.setState({ toasts: [], history: [], unreadCount: 0 })
    writeJson.mockRejectedValueOnce(new Error('disk full'))
    await act(async () => {
      setNativeValue(capInput(), '999')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(capInput().value).toBe('50')
    expect(useToast.getState().toasts.some((t) => t.kind === 'error')).toBe(true)
  })
})
