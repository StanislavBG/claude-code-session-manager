// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { Settings } from '../Settings'
import { OWNED_KEYS, planGroups } from '../../../lib/settingsGroups'
import { useLayout } from '../../../state/layout'
import { HOME, useNavfaceHarness } from './_navfaceHarness'

function installApi() {
  const data = { model: 'opus', permissions: { allow: ['Bash(ls:*)'] }, hooks: {}, disableAllHooks: false }
  const raw = JSON.stringify(data, null, 2) + '\n'
  const api = {
    claudeConfig: { patch: vi.fn().mockResolvedValue({ ok: true, path: '', data: {} }) },
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      readJson: vi.fn().mockResolvedValue({ raw, data, exists: true, mtimeMs: 0, parseError: null, error: null }),
      readText: vi.fn().mockResolvedValue({ text: raw, raw, exists: true, mtimeMs: 0, error: null }),
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

const { mount } = useNavfaceHarness(Settings, installApi)
const chips = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-testid="source-chip-path"]')).map((c) => c.textContent ?? '')
const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const click = async (b: HTMLElement | null | undefined) => {
  await act(async () => {
    b!.click()
    await Promise.resolve()
  })
}
const rawButton = (el: HTMLElement) => Array.from(el.querySelectorAll('button')).find((b) => b.textContent === '{ } Raw JSON')

describe('Settings panes', () => {
  it('General has no path chip row; owned keys live behind the Permissions / Hooks rows, never as cards', async () => {
    const el = await mount()
    expect(chips(el)).toEqual([])
    expect(q(el, 'settings-row-permissions')?.textContent).toContain('1 rule')
    expect(q(el, 'settings-row-hooks')?.textContent).toContain('2/4')
    for (const k of OWNED_KEYS) {
      expect(planGroups(new Set([k])).flatMap((g) => g.keys)).not.toContain(k)
      expect(el.querySelector(`[data-testid="setting-card"][data-key="${k}"]`)).toBeNull()
    }
  })

  it('the Permissions row opens the rules editor', async () => {
    const el = await mount()
    await click(q(el, 'settings-row-permissions'))
    expect(q(el, 'settings-detail-header')?.textContent).toContain('Permissions')
    expect(el.textContent).toContain('Default Mode')
  })

  it('the Hooks row opens the event editor', async () => {
    const el = await mount()
    await click(q(el, 'settings-row-hooks'))
    expect(q(el, 'settings-hooks-body')).not.toBeNull()
    expect(el.textContent).toContain('PreToolUse')
  })

  it('{ } Raw JSON opens the raw editor with the SaveBar', async () => {
    const el = await mount()
    await click(rawButton(el))
    expect(chips(el)).toEqual([])
    expect(q(el, 'settings-raw-editor')).not.toBeNull()
    expect(el.textContent?.toLowerCase()).toContain('save')
  })

  it("honours a 'settings' panel tab hint (deep link) for a pane", async () => {
    useLayout.setState({ panelTabHint: { id: 'settings', tab: 'hooks' } })
    const el = await mount()
    expect(q(el, 'settings-hooks-body')).not.toBeNull()
  })
})
