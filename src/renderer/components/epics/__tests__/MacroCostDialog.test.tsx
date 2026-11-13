// @vitest-environment jsdom
/**
 * MacroCostDialog — the one host every macro press's high-effort warning renders
 * through. Reads useMacroCostPrompt; each button answers the pending ask().
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MacroCostDialog } from '../MacroCostDialog'
import { useMacroCostPrompt, type MacroCostChoice, type MacroCostRequest } from '../../../state/macroCostPrompt'
import { __resetModelCatalogForTests } from '../../../lib/useModelCatalog'

const REQ: MacroCostRequest = {
  cwd: '/home/bilko/Projects/alpha',
  macroLabel: 'Sweep',
  agentName: 'scout',
  model: 'opus',
  effort: 'max',
  message: '"Sweep" runs scout on opus at max effort, which can use a large share of your Claude usage.',
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<MacroCostDialog />)
  })
}

async function unmount() {
  if (root) await act(async () => root!.unmount())
  root = null
  container?.remove()
  container = null
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)

// Returns a box: an async function returning the bare promise would flatten it
// and wait for the human's answer.
async function open(req: MacroCostRequest = REQ): Promise<{ p: Promise<MacroCostChoice> }> {
  let p!: Promise<MacroCostChoice>
  await act(async () => {
    p = useMacroCostPrompt.getState().ask(req)
  })
  return { p }
}

async function click(id: string) {
  await act(async () => {
    q(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  __resetModelCatalogForTests()
  ;(window as unknown as { api: unknown }).api = {
    models: { catalog: vi.fn(() => Promise.reject(new Error('no catalog'))) },
  }
  useMacroCostPrompt.setState({ request: null, hostMounted: false })
})

afterEach(async () => {
  await unmount()
})

describe('MacroCostDialog', () => {
  it('renders nothing without a request', async () => {
    await mount()
    expect(q('macro-cost-dialog')).toBeNull()
  })

  it('mount sets hostMounted true and unmount sets it false', async () => {
    expect(useMacroCostPrompt.getState().hostMounted).toBe(false)
    await mount()
    expect(useMacroCostPrompt.getState().hostMounted).toBe(true)
    await unmount()
    expect(useMacroCostPrompt.getState().hostMounted).toBe(false)
  })

  it('a max request shows the message and lower options with medium selected', async () => {
    await mount()
    await open()
    expect(q('macro-cost-dialog')!.textContent).toContain(REQ.message)
    expect(document.body.textContent).toContain('Run at max effort?')
    const select = q('macro-cost-effort-select') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(select.value).toBe('medium')
    expect(q('macro-cost-run-as-is')!.textContent).toBe('Run at max')
    expect(q('macro-cost-run-lower')!.textContent).toBe('Run at medium')
  })

  it('Cancel resolves { proceed: false }', async () => {
    await mount()
    const { p } = await open()
    await click('macro-cost-cancel')
    await expect(p).resolves.toEqual({ proceed: false })
    expect(q('macro-cost-dialog')).toBeNull()
  })

  it('Run at <effort> resolves { proceed: true, effort: null }', async () => {
    await mount()
    const { p } = await open()
    await click('macro-cost-run-as-is')
    await expect(p).resolves.toEqual({ proceed: true, effort: null })
  })

  it('Run at <selected> resolves with the selected effort', async () => {
    await mount()
    const { p } = await open()
    await click('macro-cost-run-lower')
    await expect(p).resolves.toEqual({ proceed: true, effort: 'medium' })
  })

  it('Run at <selected> follows a changed selection', async () => {
    await mount()
    const { p } = await open()
    const select = q('macro-cost-effort-select') as HTMLSelectElement
    await act(async () => {
      select.value = 'low'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(q('macro-cost-run-lower')!.textContent).toBe('Run at low')
    await click('macro-cost-run-lower')
    await expect(p).resolves.toEqual({ proceed: true, effort: 'low' })
  })

  it('Esc resolves { proceed: false }', async () => {
    await mount()
    const { p } = await open()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await expect(p).resolves.toEqual({ proceed: false })
  })

  it('omits the select and lower button when there are no lower options', async () => {
    await mount()
    const { p } = await open({ ...REQ, effort: 'low' })
    expect(q('macro-cost-dialog')).not.toBeNull()
    expect(q('macro-cost-effort-select')).toBeNull()
    expect(q('macro-cost-run-lower')).toBeNull()
    await click('macro-cost-cancel')
    await expect(p).resolves.toEqual({ proceed: false })
  })
})
