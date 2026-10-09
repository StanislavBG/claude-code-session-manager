// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

vi.mock('../lib/createPickedSession', () => ({
  openOrStartProject: vi.fn(),
  openProjectAt: vi.fn(),
  startNewProject: vi.fn(),
}))

import { StartProjectDialog } from './StartProjectDialog'
import { openOrStartProject, openProjectAt, startNewProject } from '../lib/createPickedSession'

let container: HTMLDivElement | null = null
let root: Root | null = null
const onClose = vi.fn()
const onOpened = vi.fn()
const pickDirectory = vi.fn()

function q<T extends HTMLElement>(id: string): T {
  return document.querySelector(`[data-testid="${id}"]`) as T
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<StartProjectDialog open onClose={onClose} onOpened={onOpened} defaultParentDir="/work" />)
  })
}

async function typeName(value: string) {
  const input = q<HTMLInputElement>('start-project-name')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(id: string) {
  await act(async () => {
    q(id).click()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { api: unknown }).api = { app: { pickDirectory } }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('StartProjectDialog', () => {
  it('disables Create for a blank name', async () => {
    await mount()
    expect(q<HTMLButtonElement>('start-project-create').disabled).toBe(true)
    await typeName('   ')
    expect(q<HTMLButtonElement>('start-project-create').disabled).toBe(true)
  })

  it('creates with (parentDir, trimmed name) and fires onOpened on ok', async () => {
    vi.mocked(startNewProject).mockResolvedValue({ ok: true, path: '/work/foo' })
    await mount()
    await typeName('  foo ')
    expect(q('start-project-dialog').textContent).toContain('/work/foo')
    await click('start-project-create')
    expect(startNewProject).toHaveBeenCalledWith('/work', 'foo')
    expect(onOpened).toHaveBeenCalledTimes(1)
  })

  it("on 'exists' shows Open it which calls openProjectAt", async () => {
    vi.mocked(startNewProject).mockResolvedValue({ ok: false, code: 'exists', error: 'Already exists', path: '/work/foo' })
    await mount()
    await typeName('foo')
    await click('start-project-create')
    expect(q('start-project-error').textContent).toContain('Already exists')
    expect(onOpened).not.toHaveBeenCalled()
    const openIt = Array.from(q('start-project-error').querySelectorAll('button')).find((b) => b.textContent === 'Open it')!
    await act(async () => {
      openIt.click()
    })
    expect(openProjectAt).toHaveBeenCalledWith('/work/foo')
    expect(onOpened).toHaveBeenCalledTimes(1)
  })

  it('Change… updates the parent dir', async () => {
    pickDirectory.mockResolvedValue('/other')
    await mount()
    await click('start-project-change-parent')
    expect(q('start-project-parent').textContent).toContain('/other')
  })

  it('Open existing calls openOrStartProject and reports onOpened on a non-null id', async () => {
    vi.mocked(openOrStartProject).mockResolvedValue('tab-1')
    await mount()
    await click('start-project-open-existing')
    expect(openOrStartProject).toHaveBeenCalledTimes(1)
    expect(onOpened).toHaveBeenCalledTimes(1)
  })
})
