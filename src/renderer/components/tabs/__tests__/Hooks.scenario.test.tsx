// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react-dom/test-utils'
import { Hooks } from '../Hooks'
import { useConfig, type FileState } from '../../../state/config'
import { useToast } from '../../../state/toast'
import { useLayout } from '../../../state/layout'
import { useSessions } from '../../../state/sessions'
import { HOME, PROJECT_CWD, PROJECT_TAB, useNavfaceHarness, clickViewTab } from './_navfaceHarness'

const USER_PATH = `${HOME}/.claude/settings.json`
const PROJECT_PATH = `${PROJECT_CWD}/.claude/settings.json`

function installWindowApiMock() {
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      readJson: vi.fn().mockImplementation(() => new Promise(() => {})),
      readText: vi.fn().mockImplementation(() => new Promise(() => {})),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      writeText: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      exists: vi.fn().mockResolvedValue(true),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

function fileState(path: string, raw: string): FileState {
  return {
    path,
    diskRaw: raw,
    draftRaw: raw,
    diskData: null,
    exists: true,
    parseError: null,
    loadError: null,
    mtimeMs: 0,
    dirty: false,
    busy: false,
    lastSavedAt: null,
  }
}

function seedDrafts(drafts: Record<string, string>) {
  const setDraft = vi.fn()
  const saveJson = vi.fn().mockResolvedValue({ ok: true })
  useConfig.setState({
    files: Object.fromEntries(Object.entries(drafts).map(([p, raw]) => [p, fileState(p, raw)])),
    watchRefs: {},
    setDraft,
    saveJson,
    loadJson: vi.fn().mockResolvedValue(undefined),
    watchFile: vi.fn(),
    unwatchFile: vi.fn(),
  })
  return { setDraft, saveJson }
}

const click = (el: Element | undefined | null) =>
  act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })

const buttonByText = (el: HTMLElement, text: string) =>
  Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)

const errorToasts = () => useToast.getState().toasts.filter((t) => t.kind === 'error')

describe('Hooks no-clobber on bad draft', () => {
  const { mount } = useNavfaceHarness(Hooks, installWindowApiMock)

  beforeEach(() => {
    useToast.setState({ toasts: [] })
  })

  async function openEvents(drafts: Record<string, string>) {
    const mocks = seedDrafts(drafts)
    const el = await mount()
    await act(async () => {
      clickViewTab(el, 'Events')
      await Promise.resolve()
    })
    return { el, ...mocks }
  }

  it.each([
    ['unparseable JSON', '{ "model": "opus", "hooks": { '],
    ['array', '[1, 2]'],
  ])('%s draft: controls disabled, error shown, no setDraft', async (_n, raw) => {
    const { el, setDraft, saveJson } = await openEvents({ [USER_PATH]: raw })
    expect(el.textContent).toMatch(/invalid JSON/i)
    expect(buttonByText(el, '+ add group')?.disabled).toBe(true)
    await click(buttonByText(el, '+ add group'))
    expect(setDraft).not.toHaveBeenCalled()
    expect(saveJson).not.toHaveBeenCalled()
  })

  it('invalid target draft: override gives an error toast and no setDraft', async () => {
    useLayout.setState({ navFace: 'project' })
    useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
    const { setDraft, saveJson } = seedDrafts({ [PROJECT_PATH]: '{ "permissions": { ' })
    const el = await mount()
    // Unset schema keys render as ghost rows whose "set" button calls overrideInto.
    const set = buttonByText(el, 'set')
    expect(set).toBeTruthy()
    await click(set)
    expect(setDraft).not.toHaveBeenCalled()
    expect(saveJson).not.toHaveBeenCalled()
    expect(errorToasts().some((t) => /invalid JSON/i.test(t.message))).toBe(true)
  })

  it('valid draft keeps permissions, env and model after adding a hook group', async () => {
    const original = {
      permissions: { allow: ['Read(*)'] },
      env: { FOO: 'bar' },
      model: 'opus',
    }
    const { el, setDraft } = await openEvents({ [USER_PATH]: JSON.stringify(original, null, 2) })
    const add = buttonByText(el, '+ add group')
    expect(add?.disabled).toBe(false)
    await click(add)
    expect(setDraft).toHaveBeenCalledTimes(1)
    const [path, raw] = setDraft.mock.calls[0] as [string, string]
    expect(path).toBe(USER_PATH)
    const next = JSON.parse(raw)
    expect(next.permissions).toEqual(original.permissions)
    expect(next.env).toEqual(original.env)
    expect(next.model).toBe('opus')
    expect(next.hooks.PreToolUse).toHaveLength(1)
    expect(errorToasts()).toHaveLength(0)
  })
})
