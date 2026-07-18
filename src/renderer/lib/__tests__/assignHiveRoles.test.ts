import { describe, expect, it } from 'vitest'
import { assignHiveRolesToRunningTabs } from '../assignHiveRoles'

const role = (label: string) => ({ label, prompt: `do ${label}` })
const tab = (id: string) => ({ id, label: `tab-${id}`, presetId: null })

describe('assignHiveRolesToRunningTabs', () => {
  it('rejects with zero running tabs instead of silently no-oping', () => {
    const result = assignHiveRolesToRunningTabs([role('debugger')], [])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/at least one running tab/i)
  })

  it('rejects when there are fewer running tabs than roles', () => {
    const result = assignHiveRolesToRunningTabs(
      [role('debugger'), role('test-runner')],
      [tab('1')],
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/2 agents but only 1 running tab/i)
  })

  it('assigns one role per running tab, in order, when there are enough tabs', () => {
    const result = assignHiveRolesToRunningTabs(
      [role('debugger'), role('test-runner')],
      [tab('1'), tab('2'), tab('3')],
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.picks).toHaveLength(2)
      expect(result.picks[0]).toMatchObject({ tabId: '1', prompt: 'do debugger' })
      expect(result.picks[1]).toMatchObject({ tabId: '2', prompt: 'do test-runner' })
    }
  })
})
