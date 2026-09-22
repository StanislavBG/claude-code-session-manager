import { describe, it, expect, afterEach, vi } from 'vitest'
import { readHistoryAnalyticsPrefs, writeHistoryAnalyticsPrefs } from '../historyAnalyticsPrefs'
import { UI_SETTINGS_PREFS_FILE } from '../uiSettingsPrefs'

function installApi(overrides: { readJson: any; writeJson: any }) {
  if (!(globalThis as any).window) (globalThis as any).window = {}
  ;(globalThis as any).window.api = { config: overrides }
}

afterEach(() => {
  delete (globalThis as any).window?.api
})

describe('historyAnalyticsPrefs', () => {
  it('readHistoryAnalyticsPrefs returns {} when the file does not exist', async () => {
    installApi({ readJson: vi.fn().mockResolvedValue({ exists: false }), writeJson: vi.fn() })
    expect(await readHistoryAnalyticsPrefs()).toEqual({})
  })

  it('readHistoryAnalyticsPrefs returns the persisted history sub-object', async () => {
    const readJson = vi.fn().mockResolvedValue({ exists: true, data: { history: { measure: 'spend', range: 30 } } })
    installApi({ readJson, writeJson: vi.fn() })
    expect(await readHistoryAnalyticsPrefs()).toEqual({ measure: 'spend', range: 30 })
  })

  it('writeHistoryAnalyticsPrefs merges the patch into history without clobbering sibling top-level fields', async () => {
    const readJson = vi.fn().mockResolvedValue({ exists: true, data: { rawSessionModel: 'sonnet', history: { measure: 'spend' } } })
    const writeJson = vi.fn().mockResolvedValue(undefined)
    installApi({ readJson, writeJson })
    await writeHistoryAnalyticsPrefs({ range: 60 })
    expect(writeJson).toHaveBeenCalledWith(UI_SETTINGS_PREFS_FILE, {
      rawSessionModel: 'sonnet',
      history: { measure: 'spend', range: 60 },
    })
  })

  it('serializes two overlapping writes (measure vs budgetCapUsd) so neither clobbers the other', async () => {
    let store: Record<string, unknown> = { history: { measure: 'spend', range: 30 } }
    const readJson = vi.fn(async () => ({ exists: true, data: { ...store } }))
    const writeResolvers: Array<() => void> = []
    const writeJson = vi.fn((_path: string, data: unknown) => new Promise<void>((resolve) => {
      writeResolvers.push(() => {
        store = { ...(data as Record<string, unknown>) }
        resolve()
      })
    }))
    installApi({ readJson, writeJson })

    // HistoryDashboard.tsx writes measure/range; BudgetStrip.tsx writes
    // budgetCapUsd — both funnel through this module's queue so the second
    // write's read-modify-write picks up the first's already-applied field.
    const p1 = writeHistoryAnalyticsPrefs({ measure: 'sessions' })
    await vi.waitFor(() => expect(writeJson).toHaveBeenCalledTimes(1))

    const p2 = writeHistoryAnalyticsPrefs({ budgetCapUsd: 75 })
    await new Promise((r) => setTimeout(r, 0))
    expect(writeJson).toHaveBeenCalledTimes(1)

    writeResolvers[0]()
    await p1
    await vi.waitFor(() => expect(writeJson).toHaveBeenCalledTimes(2))
    expect(writeJson.mock.calls[1][1]).toEqual({
      history: { measure: 'sessions', range: 30, budgetCapUsd: 75 },
    })

    writeResolvers[1]()
    await p2
    expect(store).toEqual({ history: { measure: 'sessions', range: 30, budgetCapUsd: 75 } })
  })
})
