// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { createRequire } from 'node:module'
import { ValidationQuality, MISS_KIND_MEANINGS, APPROVAL_LINE } from '../panels/ValidationQuality'
import { useToast } from '../../../../../state/toast'

let container: HTMLDivElement
let root: Root

const NO_UNCLASSIFIED = { count: 0, prds: [], reasons: [] }
const week = (topMiss: unknown = null, unclassified: unknown = NO_UNCLASSIFIED) => ({ fromMs: 0, toMs: 1, topMiss, unclassified })

function projects(topMiss: unknown = null, unclassified: unknown = NO_UNCLASSIFIED) {
  return [
    {
      cwd: '/a',
      project: 'alpha',
      firstPass: { pct: 75, prds: ['p1', 'p2', 'p3'] },
      refuted: { pct: 25, prds: ['p4'] },
      fixWaves: { perPlan: 0.5, plans: [{ plan: 'plan-a', fixWaves: ['plan-a-fix'] }, { plan: 'plan-b', fixWaves: [] }] },
      escapes: [{ fixPrd: 'f9', escapedPrd: 'p2', verifiedBy: 'v1', missKind: 'regression', reason: 'broke save', at: 5 }],
      week: week(topMiss, unclassified),
    },
    {
      cwd: '/b',
      project: 'beta',
      firstPass: { pct: null, prds: [] },
      refuted: { pct: null, prds: [] },
      fixWaves: { perPlan: null, plans: [] },
      escapes: [],
      week: week(),
    },
  ]
}

async function mount(validationQuality: () => Promise<unknown>) {
  ;(globalThis as any).window.api = { history: { validationQuality: vi.fn(validationQuality), onUpdated: vi.fn(() => () => {}) } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(ValidationQuality))
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (globalThis as any).window?.api
  vi.restoreAllMocks()
})

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const qa = (id: string) => Array.from(container.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[]

describe('ValidationQuality', () => {
  it('renders one row per project with an em dash for null values', async () => {
    await mount(async () => ({ ok: true, projects: projects() }))
    expect(qa('val-q-row').length).toBe(2)
    expect(qa('val-q-firstPass').map((e) => e.textContent)).toEqual(['75%', '—'])
    expect(qa('val-q-refuted').map((e) => e.textContent)).toEqual(['25%', '—'])
    expect(qa('val-q-fixWaves').map((e) => e.textContent)).toEqual(['0.5', '—'])
    expect(qa('val-q-escapes').map((e) => e.textContent)).toEqual(['1', '0'])
  })

  it('expands a number to the PRD slugs behind it, escapes as fix lines', async () => {
    await mount(async () => ({ ok: true, projects: projects() }))
    expect(q('val-q-detail')).toBeNull()
    act(() => qa('val-q-firstPass')[0].click())
    expect(qa('val-q-detail-item').map((e) => e.textContent)).toEqual(['p1', 'p2', 'p3'])
    act(() => qa('val-q-escapes')[0].click())
    expect(qa('val-q-detail-item').map((e) => e.textContent)).toEqual(['f9 fixes p2 — broke save'])
    act(() => qa('val-q-fixWaves')[0].click())
    expect(qa('val-q-detail-item').map((e) => e.textContent)).toEqual(['plan-a: plan-a-fix'])
    act(() => qa('val-q-fixWaves')[0].click())
    expect(q('val-q-detail')).toBeNull()
  })

  it('shows the week top miss with meaning, PRDs, reasons, proposal and approval line', async () => {
    const reasons = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']
    await mount(async () => ({
      ok: true,
      projects: projects({ missKind: 'missing-test', count: 3, prds: ['p4', 'p5'], reasons, proposal: 'Every AC names a test.' }),
    }))
    const block = q('val-q-top-miss')!
    expect(block.textContent).toContain('missing-test')
    expect(block.textContent).toContain(MISS_KIND_MEANINGS['missing-test'])
    expect(block.textContent).toContain('3×')
    expect(block.textContent).toContain('p4, p5')
    expect(qa('val-q-reason').length).toBe(5)
    expect(q('val-q-proposal')!.textContent).toContain('Every AC names a test.')
    expect(block.textContent).toContain(APPROVAL_LINE)
    expect(q('val-q-week-empty')).toBeNull()
  })

  it('shows the empty week when there is neither a top miss nor unclassified verdicts', async () => {
    await mount(async () => ({ ok: true, projects: projects() }))
    expect(q('val-q-week-empty')!.textContent).toBe('No validator misses this week.')
    expect(q('val-q-unclassified')).toBeNull()
    expect(q('val-q-top-miss')).toBeNull()
  })

  it('shows unclassified verdicts alone, without the empty line', async () => {
    const reasons = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7']
    await mount(async () => ({ ok: true, projects: projects(null, { count: 2, prds: ['old-1', 'old-2'], reasons }) }))
    const block = q('val-q-unclassified')!
    expect(block.textContent).toContain('Not classified (recorded before checked verdicts): 2')
    expect(block.textContent).toContain('old-1, old-2')
    expect(qa('val-q-unclassified-reason').map((e) => e.textContent)).toEqual(['u1', 'u2', 'u3', 'u4', 'u5'])
    expect(q('val-q-week-empty')).toBeNull()
    expect(q('val-q-top-miss')).toBeNull()
  })

  it('shows unclassified verdicts under the top miss', async () => {
    await mount(async () => ({
      ok: true,
      projects: projects(
        { missKind: 'gate-red', count: 1, prds: ['p4'], reasons: ['red'], proposal: 'Run the gate.' },
        { count: 1, prds: ['old-1'], reasons: ['legacy'] },
      ),
    }))
    const top = q('val-q-top-miss')!
    const unc = q('val-q-unclassified')!
    expect(top.textContent).toContain('gate-red')
    expect(unc.textContent).toContain('Not classified (recorded before checked verdicts): 1')
    expect(unc.textContent).toContain('old-1')
    expect(qa('val-q-unclassified-reason').map((e) => e.textContent)).toEqual(['legacy'])
    expect(top.compareDocumentPosition(unc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(q('val-q-week-empty')).toBeNull()
  })

  it('toasts an error on a rejected fetch and on ok:false', async () => {
    const show = vi.fn()
    useToast.setState({ show } as any)
    await mount(async () => {
      throw new Error('boom')
    })
    expect(show).toHaveBeenCalledWith('error', expect.stringContaining('boom'))
    expect(q('val-q-error')).not.toBeNull()
    act(() => root.unmount())
    container.remove()
    await mount(async () => ({ ok: false, error: 'nope' }))
    expect(show).toHaveBeenCalledWith('error', expect.stringContaining('nope'))
  })

  it('miss-kind map equals MISS_KIND_MEANINGS in validatorVerdictSchema.cjs', () => {
    const schema = createRequire(import.meta.url)('../../../../../../main/lib/scheduler/validatorVerdictSchema.cjs')
    expect(schema.MISS_KINDS.length).toBe(10)
    expect(Object.keys(MISS_KIND_MEANINGS)).toEqual([...schema.MISS_KINDS])
    expect({ ...MISS_KIND_MEANINGS }).toEqual({ ...schema.MISS_KIND_MEANINGS })
  })
})
