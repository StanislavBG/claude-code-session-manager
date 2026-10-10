// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react-dom/test-utils'
import { Permissions } from '../Permissions'
import { useConfig, type FileState } from '../../../state/config'
import { useToast } from '../../../state/toast'
import { HOME, useNavfaceHarness, clickViewTab } from './_navfaceHarness'

const USER_PATH = `${HOME}/.claude/settings.json`

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

function seedDraft(raw: string): ReturnType<typeof vi.fn> {
  const file: FileState = {
    path: USER_PATH,
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
  const setDraft = vi.fn()
  const saveJson = vi.fn().mockResolvedValue({ ok: true })
  useConfig.setState({
    files: { [USER_PATH]: file },
    watchRefs: {},
    setDraft,
    saveJson,
    loadJson: vi.fn().mockResolvedValue(undefined),
    watchFile: vi.fn(),
    unwatchFile: vi.fn(),
  })
  return setDraft
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Permissions no-clobber on bad draft', () => {
  const { mount } = useNavfaceHarness(Permissions, installWindowApiMock)

  beforeEach(() => {
    useToast.setState({ toasts: [] })
  })

  async function openRules(raw: string) {
    const setDraft = seedDraft(raw)
    const el = await mount()
    await act(async () => {
      clickViewTab(el, 'Rules')
      await Promise.resolve()
    })
    return { el, setDraft }
  }

  const errorToasts = () => useToast.getState().toasts.filter((t) => t.kind === 'error')

  it('invalid JSON draft: inputs disabled, no setDraft, error toast', async () => {
    const { el, setDraft } = await openRules('{ "model": "opus", "permissions": { ')
    const inputs = Array.from(el.querySelectorAll('input'))
    expect(inputs.length).toBeGreaterThan(0)
    expect(inputs.every((i) => i.disabled)).toBe(true)
    expect(el.textContent).toMatch(/invalid JSON/i)

    // Even a forced click on a mode button must not write.
    const mode = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'plan')
    await act(async () => {
      mode?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(setDraft).not.toHaveBeenCalled()
    expect(errorToasts().some((t) => /invalid JSON/i.test(t.message))).toBe(true)
  })

  it('array draft is refused like invalid JSON', async () => {
    const { el, setDraft } = await openRules('[1, 2]')
    expect(Array.from(el.querySelectorAll('input')).every((i) => i.disabled)).toBe(true)
    const mode = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'plan')
    await act(async () => {
      mode?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(setDraft).not.toHaveBeenCalled()
    expect(errorToasts().length).toBeGreaterThan(0)
  })

  it('valid draft keeps hooks, env and model after adding an allow rule', async () => {
    const original = {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
      env: { FOO: 'bar' },
      model: 'opus',
      permissions: { allow: ['Read(*)'] },
    }
    const { el, setDraft } = await openRules(JSON.stringify(original, null, 2))
    const input = el.querySelector('input') as HTMLInputElement
    expect(input.disabled).toBe(false)
    await act(async () => {
      typeInto(input, 'Bash(ls:*)')
      await Promise.resolve()
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    expect(setDraft).toHaveBeenCalledTimes(1)
    const [path, raw] = setDraft.mock.calls[0] as [string, string]
    expect(path).toBe(USER_PATH)
    const next = JSON.parse(raw)
    expect(next.hooks).toEqual(original.hooks)
    expect(next.env).toEqual(original.env)
    expect(next.model).toBe('opus')
    expect(next.permissions.allow).toEqual(['Read(*)', 'Bash(ls:*)'])
    expect(errorToasts()).toHaveLength(0)
  })
})
