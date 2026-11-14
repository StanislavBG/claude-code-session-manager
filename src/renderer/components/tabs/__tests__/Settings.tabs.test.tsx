// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { Settings } from '../Settings'
import { OWNED_KEYS, planGroups } from '../../../lib/settingsGroups'
import { HOME, useNavfaceHarness, viewTabLabels, clickViewTab } from './_navfaceHarness'

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
const go = async (el: HTMLElement, label: string) => {
  await act(async () => {
    clickViewTab(el, label)
    await Promise.resolve()
  })
}

describe('Settings tabs', () => {
  it('offers General / Permissions / Hooks / Raw and no Tree', async () => {
    const el = await mount()
    const labels = viewTabLabels(el)
    expect(labels.slice(0, 4)).toEqual(['General', 'Permissions', 'Hooks', 'Raw'])
    expect(labels).not.toContain('Tree')
    expect(labels).not.toContain('Guided')
  })

  it('General summarises owned keys per owner and hides their cards', async () => {
    const el = await mount()
    const s = el.querySelector('[data-testid="owned-summary-permissions"]')
    expect(s?.textContent).toContain('1 of 1 keys set')
    expect(el.querySelector('[data-testid="owned-summary-hooks"]')).not.toBeNull()
    expect(chips(el)).toEqual([`~/.claude/settings.json`])
    for (const k of OWNED_KEYS) {
      expect(planGroups(new Set([k])).flatMap((g) => g.keys)).not.toContain(k)
    }
  })

  it('General keeps owned summaries in the scrolling content, not the fixed header', async () => {
    const el = await mount()
    const summaries = el.querySelector('[data-testid="settings-owned-summaries"]')
    expect(summaries).not.toBeNull()
    expect(summaries?.closest('[data-testid="page-shell-content"]')).not.toBeNull()
    expect(summaries?.closest('[data-testid="page-shell-header"]')).toBeNull()
    const header = el.querySelector('[data-testid="page-shell-header"]')
    expect(header?.querySelector('[data-testid="settings-scope-note"]')).not.toBeNull()
    expect(header?.querySelector('[data-testid="source-chip-path"]')).toBeNull()
  })

  it('a summary line switches to its tab, which shows the keyed SourceChip', async () => {
    const el = await mount()
    const btn = Array.from(el.querySelectorAll('[data-testid="owned-summary-permissions"] button'))[0] as HTMLButtonElement
    await act(async () => {
      btn.click()
      await Promise.resolve()
    })
    expect(chips(el)).toEqual(['~/.claude/settings.json › permissions'])
    expect(el.textContent).toContain('Default Mode')
  })

  it('Hooks tab shows the hooks SourceChip and event editor', async () => {
    const el = await mount()
    await go(el, 'Hooks')
    expect(chips(el)).toEqual(['~/.claude/settings.json › hooks'])
    expect(el.textContent).toContain('PreToolUse')
  })

  it('Raw tab shows the file chip and the SaveBar', async () => {
    const el = await mount()
    await go(el, 'Raw')
    expect(chips(el)).toEqual(['~/.claude/settings.json'])
    expect(el.textContent?.toLowerCase()).toContain('save')
  })
})
