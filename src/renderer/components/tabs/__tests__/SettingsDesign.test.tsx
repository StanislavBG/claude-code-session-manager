// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { Settings } from '../Settings'
import { useSessions } from '../../../state/sessions'
import { settingSources } from '../../ui/EffectiveCards'
import { mergeScopes, getAtPath } from '../../../lib/mergeScopes'
import { useConfigSearchFocus } from '../../../state/configSearchFocus'
import { HOME, PROJECT_CWD, PROJECT_TAB, useNavfaceHarness } from './_navfaceHarness'

/**
 * The Settings tab on the ConfigWorkbench design: SETTINGS FILE card (Project / Local radio
 * rows in a project, the user file on Home), a 'Search N settings' field, the group rail with
 * set/total counts plus Permissions and Hooks rows, and one group's setting cards in the
 * detail, each with one control by type, a source ladder (Default — User on Home, all four in a
 * project) and a ⋯ menu holding Reset.
 */

const USER = `${HOME}/.claude/settings.json`
const PROJECT = `${PROJECT_CWD}/.claude/settings.json`
const LOCAL = `${PROJECT_CWD}/.claude/settings.local.json`

let disk: Record<string, Record<string, unknown>> = {}

function installApi() {
  const read = (p: string) => {
    const data = disk[p]
    const raw = data ? JSON.stringify(data, null, 2) + '\n' : ''
    return { raw, text: raw, data: data ?? null, exists: !!data, mtimeMs: data ? Date.now() - 3 * 86_400_000 : 0, parseError: null, error: null }
  }
  const api = {
    claudeConfig: { patch: vi.fn().mockResolvedValue({ ok: true, path: '', data: {} }) },
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      readJson: vi.fn(async (p: string) => read(p)),
      readText: vi.fn(async (p: string) => read(p)),
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

let onScope = vi.fn<(s: string) => void>()
let mode: 'user' | 'project' = 'user'

function Host() {
  const [scope, setScope] = useState<'project' | 'local'>('project')
  if (mode === 'user') return <Settings scope="user" />
  return (
    <Settings
      scope={scope}
      onScopeChange={(s) => {
        onScope(s)
        setScope(s)
      }}
    />
  )
}

const { mount: rawMount } = useNavfaceHarness(Host, installApi)

async function mount(m: 'user' | 'project') {
  mode = m
  onScope = vi.fn<(s: string) => void>()
  if (m === 'project') useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
  const el = await rawMount()
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  return el
}

const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const railRow = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="settings-group-row"][data-group-id="${id}"]`)
const ladder = (el: HTMLElement, key: string) =>
  el.querySelector<HTMLElement>(`[data-testid="setting-card"][data-key="${key}"] [data-testid="source-ladder"]`)
const effectiveStage = (l: HTMLElement | null) =>
  Array.from(l?.querySelectorAll<HTMLElement>('[data-stage]') ?? [])
    .filter((s) => s.dataset.effective === 'true')
    .map((s) => s.dataset.stage)


function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const cards = {
  setShowAdvanced: (el: HTMLElement) =>
    Array.from(el.querySelectorAll<HTMLElement>('[role="switch"]'))
      .find((b) => b.closest('label')?.textContent?.includes('Advanced'))!
      .click(),
  search: (el: HTMLElement, text: string) => setInputValue(el.querySelector<HTMLInputElement>('input[type="search"]')!, text),
}

describe('Settings — ConfigWorkbench design', () => {
  it('Home: user file card, search count, group rail set/total, Permissions + Hooks rows', async () => {
    disk = { [USER]: { model: 'opus', permissions: { allow: ['Bash(ls:*)'] }, hooks: {} } }
    const el = await mount('user')
    const card = q(el, 'settings-file-card')!
    expect(card.textContent).toContain('SETTINGS FILE')
    expect(card.textContent).toContain('~/.claude/settings.json')
    expect(card.textContent).toMatch(/edited 3d ago/)
    expect(card.querySelectorAll('[role="radio"]').length).toBe(0)

    const search = el.querySelector<HTMLInputElement>('input[type="search"]')!
    expect(search.placeholder).toMatch(/^Search \d+ settings$/)

    expect(railRow(el, 'essentials')?.textContent).toContain('Essentials')
    expect(railRow(el, 'essentials')?.textContent).toContain('1/3')
    expect(q(el, 'settings-row-permissions')?.textContent).toContain('Permissions')
    expect(q(el, 'settings-row-hooks')?.textContent).toContain('Hooks')

    const header = q(el, 'settings-detail-header')!
    expect(header.textContent).toContain('USER SETTINGS · 1 OF 3 SET')
    expect(header.textContent).toContain('Essentials')
    expect(header.textContent).toContain('Show unset')
    expect(header.textContent).toContain('Advanced')
    expect(header.textContent).toContain('{ } Raw JSON')
  })

  it('a rail row selects that group; Permissions, Hooks and Raw JSON open their panes', async () => {
    disk = { [USER]: { model: 'opus', includeCoAuthoredBy: false } }
    const el = await mount('user')
    await act(async () => railRow(el, 'git')!.click())
    expect(q(el, 'settings-detail-header')?.textContent).toContain('Git & Commits')
    expect(el.querySelector('[data-testid="setting-card"][data-key="includeCoAuthoredBy"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="setting-card"][data-key="model"]')).toBeNull()

    await act(async () => q(el, 'settings-row-permissions')!.click())
    expect(el.textContent).toContain('Default Mode')
    await act(async () => q(el, 'settings-row-hooks')!.click())
    expect(el.textContent).toContain('PreToolUse')
    await act(async () => Array.from(el.querySelectorAll('button')).find((b) => b.textContent === '{ } Raw JSON')!.click())
    expect(q(el, 'settings-raw-editor')).not.toBeNull()
  })

  it('Project: the radio rows switch the file between Project and Local', async () => {
    disk = { [PROJECT]: { model: 'sonnet' }, [LOCAL]: { language: 'French' } }
    const el = await mount('project')
    const radios = () => Array.from(q(el, 'settings-file-card')!.querySelectorAll<HTMLElement>('[role="radio"]'))
    expect(radios().map((r) => r.textContent)).toEqual([
      expect.stringContaining('.claude/settings.json · in git'),
      expect.stringContaining('settings.local.json · this machine'),
    ])
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    expect(q(el, 'settings-detail-header')?.textContent).toContain('PROJECT SETTINGS · 2 OF 3 SET')

    await act(async () => radios()[1].click())
    expect(onScope).toHaveBeenCalledWith('local')
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true'])
    expect(q(el, 'settings-detail-header')?.textContent).toContain('LOCAL SETTINGS')
  })

  it('each card shows name, key and a Default — User — Project — Local ladder marking the effective source', async () => {
    disk = {
      [USER]: { model: 'opus', language: 'English' },
      [PROJECT]: { model: 'sonnet' },
      [LOCAL]: {},
    }
    const el = await mount('project')
    const model = el.querySelector<HTMLElement>('[data-testid="setting-card"][data-key="model"]')!
    expect(model.textContent).toContain('Model')
    expect(model.textContent).toContain('model')
    const stages = Array.from(ladder(el, 'model')!.querySelectorAll<HTMLElement>('[data-stage]')).map((s) => s.dataset.stage)
    expect(stages).toEqual(['default', 'user', 'project', 'local'])
    expect(effectiveStage(ladder(el, 'model'))).toEqual(['project'])
    expect(effectiveStage(ladder(el, 'language'))).toEqual(['user'])
    expect(effectiveStage(ladder(el, 'outputStyle'))).not.toContain('project')
  })
})

const card = (el: HTMLElement, key: string) =>
  el.querySelector<HTMLElement>(`[data-testid="setting-card"][data-key="${key}"]`)!
const stagesOf = (l: HTMLElement | null) =>
  Array.from(l?.querySelectorAll<HTMLElement>('[data-stage]') ?? []).map((s) => s.dataset.stage)

describe('Settings — setting row model (wave-3 findings 9, 10, 11, 13)', () => {
  it('an enum row with no value shows the default in its select; no Set to / save / SET IN / OVERRIDING chips', async () => {
    disk = { [USER]: { model: 'opus' } }
    const el = await mount('user')
    const sel = card(el, 'outputStyle').querySelector<HTMLSelectElement>('select')!
    expect(sel.selectedOptions[0].textContent).toBe('default')
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(
      expect.arrayContaining(['default', 'Proactive', 'Explanatory', 'Learning']),
    )
    const text = el.textContent ?? ''
    expect(text).not.toMatch(/Set to:/)
    expect(text).not.toMatch(/save →/)
    expect(text).not.toMatch(/set in user/i)
    expect(text).not.toMatch(/overriding/i)
  })

  it('a schema enum with a default shows that default when unset', async () => {
    disk = { [USER]: {} }
    const el = await mount('user')
    await act(async () => cards.setShowAdvanced(el))
    await act(async () => cards.search(el, 'editorMode'))
    const sel = card(el, 'editorMode').querySelector<HTMLSelectElement>('select')!
    expect(sel.selectedOptions[0].textContent).toBe('normal')
  })

  it('a change writes the selected scope (Local) through claudeConfig.patch', async () => {
    disk = { [PROJECT]: { model: 'sonnet' }, [LOCAL]: {} }
    const el = await mount('project')
    await act(async () => q(el, 'settings-file-local')!.click())
    const api = (window as unknown as { api: { claudeConfig: { patch: ReturnType<typeof vi.fn> } } }).api
    api.claudeConfig.patch.mockClear()

    const sel = card(el, 'outputStyle').querySelector<HTMLSelectElement>('select')!
    const idx = Array.from(sel.options).findIndex((o) => o.textContent === 'Explanatory')
    await act(async () => {
      sel.value = sel.options[idx].value
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(api.claudeConfig.patch).toHaveBeenLastCalledWith(
      expect.objectContaining({ fileId: 'settings', scope: 'local', keyPath: ['outputStyle'], value: 'Explanatory' }),
    )

    const input = card(el, 'language').querySelector<HTMLInputElement>('input')!
    await act(async () => {
      setInputValue(input, 'French')
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(api.claudeConfig.patch).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: 'local', keyPath: ['language'], value: 'French' }),
    )
  })

  it('Home ladder has two scopes and Home ignores the active project tab', async () => {
    disk = { [USER]: { model: 'opus' }, [PROJECT]: { model: 'sonnet' } }
    useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
    const home = await mount('user')
    expect(stagesOf(ladder(home, 'model'))).toEqual(['default', 'user'])
    expect(effectiveStage(ladder(home, 'model'))).toEqual(['user'])
    expect(card(home, 'model').querySelector<HTMLInputElement>('input')!.value).toBe('opus')
  })

  it('a project ladder has four scopes', async () => {
    disk = { [USER]: { model: 'opus' }, [PROJECT]: { model: 'sonnet' } }
    const project = await mount('project')
    expect(stagesOf(ladder(project, 'model'))).toEqual(['default', 'user', 'project', 'local'])
    expect(effectiveStage(ladder(project, 'model'))).toEqual(['project'])
  })

  it('reset and the values-across-scopes table are reachable from the row ⋯ menu', async () => {
    disk = { [USER]: { model: 'opus' }, [PROJECT]: { model: 'sonnet' } }
    const el = await mount('project')
    const api = (window as unknown as { api: { claudeConfig: { patch: ReturnType<typeof vi.fn> } } }).api
    api.claudeConfig.patch.mockClear()
    const row = card(el, 'model')
    expect(row.querySelector('[role="menu"]')).toBeNull()
    await act(async () => row.querySelector<HTMLElement>('[data-testid="setting-row-menu"]')!.click())
    const reset = row.querySelector<HTMLElement>('[data-testid="setting-row-reset"]')!
    expect(reset.textContent).toContain('Project')
    await act(async () => reset.click())
    expect(api.claudeConfig.patch).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: 'project', keyPath: ['model'], value: undefined }),
    )

    await act(async () => row.querySelector<HTMLElement>('[data-testid="setting-row-menu"]')!.click())
    await act(async () => row.querySelector<HTMLElement>('[data-testid="setting-row-details"]')!.click())
    expect(row.querySelector('[data-testid="setting-details"]')?.textContent).toContain('Values across all scopes')
  })

  it('the page body has no path chip row and no schema link; the link lives in the header ⋯', async () => {
    disk = { [USER]: { model: 'opus' } }
    const el = await mount('user')
    expect(el.querySelector('[data-testid="source-chip-path"]')).toBeNull()
    expect(el.textContent).not.toContain('schema reference')
    await act(async () => q(el, 'settings-more')!.click())
    const link = el.querySelector<HTMLAnchorElement>('[role="menu"] a[href="https://code.claude.com/docs/en/settings"]')
    expect(link?.textContent).toContain('schema reference')
  })
})

describe('Settings — config-search focus', () => {
  it('opens the (advanced) group holding the key, scrolls its card into view in the detail, then clears the request', async () => {
    disk = { [USER]: { model: 'opus', allowedMcpServers: [] } }
    useConfigSearchFocus.getState().clear()
    const scrollBy = vi.fn()
    const origScrollBy = HTMLElement.prototype.scrollBy
    HTMLElement.prototype.scrollBy = scrollBy as unknown as typeof HTMLElement.prototype.scrollBy
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.dataset.key === 'allowedMcpServers' ? 400 : 0
      return { top, bottom: top + 50, left: 0, right: 0, width: 0, height: 50, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    })
    try {
      const el = await mount('user')
      expect(q(el, 'settings-detail-header')?.textContent).toContain('Essentials')
      await act(async () => {
        useConfigSearchFocus.getState().set('settings', 'settings:allowedMcpServers')
        await Promise.resolve()
      })
      expect(q(el, 'settings-detail-header')?.textContent).toContain('Advanced / Enterprise')
      expect(el.querySelector('[data-testid="setting-card"][data-key="allowedMcpServers"]')).not.toBeNull()
      expect(scrollBy).toHaveBeenCalledTimes(1)
      expect(scrollBy.mock.instances[0]).toBe(q(el, 'config-workbench-detail'))
      expect(scrollBy.mock.calls[0][0]).toMatchObject({ top: 400 })
      expect(useConfigSearchFocus.getState()).toMatchObject({ tab: null, id: null })
    } finally {
      rect.mockRestore()
      HTMLElement.prototype.scrollBy = origScrollBy
    }
  })

  it('keeps the current group for a key that matches nothing, and still clears the request', async () => {
    disk = { [USER]: { model: 'opus', includeCoAuthoredBy: false } }
    useConfigSearchFocus.getState().clear()
    const el = await mount('user')
    await act(async () => railRow(el, 'git')!.click())
    await act(async () => {
      useConfigSearchFocus.getState().set('settings', 'settings:noSuchSettingKey')
      await Promise.resolve()
    })
    expect(q(el, 'settings-detail-header')?.textContent).toContain('Git & Commits')
    expect(useConfigSearchFocus.getState()).toMatchObject({ tab: null, id: null })
  })
})

describe('settingSources (the ladder data, read off mergeScopes)', () => {
  const merged = mergeScopes([
    { scope: 'user', data: { env: { A: '1' }, list: ['a'] } },
    { scope: 'project', data: { list: ['b'] } },
    { scope: 'local', data: { env: { B: '2' } } },
  ])
  it('arrays and objects: the most specific contributing scope is effective', () => {
    const list = settingSources(getAtPath(merged, ['list']) ?? undefined, undefined)
    expect(list.effective).toBe('project')
    expect([...list.has].sort()).toEqual(['project', 'user'])
    expect(settingSources(getAtPath(merged, ['env']) ?? undefined, undefined).effective).toBe('local')
  })
  it('unset: Default when the schema has one, otherwise nothing', () => {
    expect(settingSources(undefined, true).effective).toBe('default')
    expect(settingSources(undefined, undefined).effective).toBeNull()
  })
})
