// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { PhAgentTools } from '../PhAgentTools'
import type { DelegationReadinessCheck } from '../../../../../preload/api'

const checksMock = vi.fn((): DelegationReadinessCheck[] => [])

vi.mock('../../../../lib/useMcpAgentTools', () => ({
  useMcpAgentTools: () => ({
    tools: [],
    recipes: [],
    checks: checksMock(),
    loaded: true,
    error: 'stubbed for readiness-strip test',
  }),
}))

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
  root?.unmount()
  container?.remove()
  container = null
  root = null
  checksMock.mockReset()
  checksMock.mockReturnValue([])
})

describe('PhAgentTools readiness strip', () => {
  it('renders one row per check, however many checkDelegationReadiness returns (not hard-coded to 4)', () => {
    const checks: DelegationReadinessCheck[] = [
      { id: 'scheduler-mcp', label: 'a', ok: false, detail: 'd', fix: null, fixAction: null },
      { id: 'scheduler-mcp-live', label: 'b', ok: false, detail: 'd', fix: null, fixAction: null },
      { id: 'scheduler-mcp-project-duplicate', label: 'c', ok: true, detail: 'd', fix: null, fixAction: null },
      { id: 'dev-plugin', label: 'e', ok: true, detail: 'd', fix: null, fixAction: null },
      { id: 'agent-personas', label: 'f', ok: true, detail: 'd', fix: null, fixAction: null },
    ]
    checksMock.mockReturnValue(checks)

    const el = mount(<PhAgentTools cwd="/home/bilko/Projects/x" />)

    for (const c of checks) {
      expect(el.querySelector(`[data-testid="agent-tools-readiness-${c.id}"]`)).not.toBeNull()
    }
    expect(el.querySelectorAll('[data-testid^="agent-tools-readiness-"]')).toHaveLength(checks.length)
  })
})
