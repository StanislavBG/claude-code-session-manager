// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useConfig } from '../../../state/config'
import { useToast } from '../../../state/toast'
import { CATALOG_PROMPT_PRESETS } from '../../../data/catalog'
import { readActivePresetIds, togglePreset } from '../../../lib/presetBlock'
import { flushAsync } from '../../../testUtils/domFlush'

/**
 * The Presets view shares `~/.claude/CLAUDE.md` with the System Prompt editor
 * through the `useConfig` store: it reads the store's disk text, refuses to
 * write over an unsaved editor draft, and saves through the store.
 */

const { PromptPresetsLibrary } = await import('../Library')

const HOME = '/home/bilko'
const PATH = `${HOME}/.claude/CLAUDE.md`
const PRESET = CATALOG_PROMPT_PRESETS[0]

let disk = '# mine\n'
let writeText: ReturnType<typeof vi.fn>
let readText: ReturnType<typeof vi.fn>

function installWindowApiMock() {
  writeText = vi.fn(async (_p: string, text: string) => {
    disk = text
    return { ok: true, mtimeMs: 1 }
  })
  readText = vi.fn(async () => ({ text: disk, raw: disk, exists: true, mtimeMs: 0, error: null }))
  ;(window as any).api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: { readText, writeText, watch: vi.fn(), unwatch: vi.fn(), onChanged: vi.fn(() => () => {}) },
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(PromptPresetsLibrary))
    await flushAsync(4)
  })
  await flushAsync(4)
  return container
}

const toggleBtn = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('button')).find((b) =>
    /^(on|off)$/.test(b.textContent ?? ''),
  ) as HTMLButtonElement
const firstState = (el: HTMLElement) => toggleBtn(el).textContent
const click = async (node: HTMLElement) => {
  await act(async () => { node.click(); await flushAsync(6) })
}

beforeEach(() => {
  disk = '# mine\n'
  installWindowApiMock()
  useConfig.setState({ files: {}, watchRefs: {} })
  useToast.setState({ toasts: [] })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as any).api
})

describe('Presets library shares CLAUDE.md state with the editor via useConfig', () => {
  it('toggling while clean writes the preset block through the store', async () => {
    const el = await mount()
    expect(firstState(el)).toBe('off')

    await click(toggleBtn(el))

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toBe(PATH)
    expect(readActivePresetIds(writeText.mock.calls[0][1])).toContain(PRESET.id)
    expect(writeText.mock.calls[0][1]).toContain('# mine')
    const f = useConfig.getState().files[PATH]
    expect(f.diskRaw).toBe(disk)
    expect(f.dirty).toBe(false)
    expect(firstState(el)).toBe('on')
  })

  it('toggling while the editor holds unsaved edits is blocked and writes nothing', async () => {
    const el = await mount()
    act(() => useConfig.getState().setDraft(PATH, '# mine\nunsaved edit\n'))
    await flushAsync(2)

    expect(toggleBtn(el).disabled).toBe(true)
    expect(el.textContent).toMatch(/unsaved changes/i)
    await click(toggleBtn(el))

    expect(writeText).not.toHaveBeenCalled()
    expect(useConfig.getState().files[PATH].draftRaw).toBe('# mine\nunsaved edit\n')
  })

  it('an external change updates the toggle state without a remount', async () => {
    const el = await mount()
    expect(firstState(el)).toBe('off')

    disk = togglePreset(disk, PRESET.id, CATALOG_PROMPT_PRESETS)
    await act(async () => {
      useConfig.getState().onExternalChange(PATH)
      await flushAsync(4)
    })

    expect(firstState(el)).toBe('on')
  })

  it('a rejected write toasts and leaves the store text unchanged', async () => {
    writeText.mockResolvedValueOnce({ ok: false, error: 'disk full' })
    const el = await mount()

    await click(toggleBtn(el))

    const toasts = useToast.getState().toasts
    expect(toasts.some((t) => t.kind === 'error' && /disk full/.test(t.message))).toBe(true)
    const f = useConfig.getState().files[PATH]
    expect(f.diskRaw).toBe('# mine\n')
    expect(f.draftRaw).toBe('# mine\n')
    expect(f.dirty).toBe(false)
    expect(firstState(el)).toBe('off')
  })
})
