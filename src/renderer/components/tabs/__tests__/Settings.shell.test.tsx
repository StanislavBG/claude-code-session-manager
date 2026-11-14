// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { Settings } from '../Settings'
import { HOME, useNavfaceHarness, clickViewTab } from './_navfaceHarness'

/**
 * Settings > Permissions / Hooks / Raw render through PageShell: scope note +
 * SourceChip are the fixed header, the Hooks event list is the subnav rail,
 * and the editor is the only scroller (Raw: Monaco fills a non-scrolling
 * content box, SaveBar is the footer). The double-scroll regression was an
 * outer overflow-auto body wrapping an inner scroller; this pins that only
 * page-shell-subnav / page-shell-content may carry a scroll class.
 */

function installApi() {
  const data = { model: 'opus', permissions: { allow: ['Bash(ls:*)'] }, hooks: {} }
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

const go = async (el: HTMLElement, label: string) => {
  await act(async () => {
    clickViewTab(el, label)
    await Promise.resolve()
  })
}

const SCROLL_CLASS = /(^|\s)overflow(-y)?-(auto|scroll)(\s|$)/

function region(el: HTMLElement, id: string): HTMLElement | null {
  return el.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

/** Every scroll-class element inside the shell is one of the two shell scrollers. */
function scrollersIn(shell: HTMLElement): string[] {
  const all = [shell, ...Array.from(shell.querySelectorAll<HTMLElement>('*'))]
  return all
    .filter((n) => SCROLL_CLASS.test(n.getAttribute('class') ?? ''))
    .map((n) => n.getAttribute('data-testid') ?? `<${n.tagName.toLowerCase()} class="${n.getAttribute('class')}">`)
}

function expectShellHeader(el: HTMLElement, chip: string) {
  const header = region(el, 'page-shell-header')!
  expect(header).not.toBeNull()
  expect(header.querySelector('[data-testid="settings-scope-note"]')).not.toBeNull()
  expect(header.querySelector('[data-testid="source-chip-path"]')?.textContent).toBe(chip)
  // Nothing in the header scrolls (and nothing outside it duplicates the note).
  expect(el.querySelectorAll('[data-testid="settings-scope-note"]').length).toBe(1)
}

describe('Settings non-General views render through PageShell', () => {
  it('Permissions: scope note + chip in header, editor is the only scroller', async () => {
    const el = await mount()
    await go(el, 'Permissions')
    const shell = region(el, 'page-shell')!
    expect(shell).not.toBeNull()
    expectShellHeader(el, '~/.claude/settings.json › permissions')
    expect(region(el, 'page-shell-content')?.textContent).toContain('Default Mode')
    expect(region(el, 'page-shell-subnav')).toBeNull()
    expect(scrollersIn(shell)).toEqual(['page-shell-content'])
  })

  it('Hooks: event list is the subnav rail, event editor is the content', async () => {
    const el = await mount()
    await go(el, 'Hooks')
    const shell = region(el, 'page-shell')!
    expect(shell).not.toBeNull()
    expectShellHeader(el, '~/.claude/settings.json › hooks')
    const subnav = region(el, 'page-shell-subnav')!
    expect(subnav).not.toBeNull()
    expect(subnav.textContent).toContain('PreToolUse')
    expect(subnav.textContent).toContain('PostToolUse')
    const content = region(el, 'page-shell-content')!
    expect(content.textContent).toContain('+ add group')
    expect(content.textContent).not.toContain('PostToolUse')
    expect(scrollersIn(shell).sort()).toEqual(['page-shell-content', 'page-shell-subnav'])

    // Selecting an event in the rail drives the content editor.
    const btn = Array.from(subnav.querySelectorAll('button')).find((b) =>
      b.textContent?.startsWith('PostToolUse'),
    ) as HTMLButtonElement
    await act(async () => {
      btn.click()
      await Promise.resolve()
    })
    expect(content.querySelector('h3')?.textContent).toBe('PostToolUse')
  })

  it('Raw: Monaco fills a non-scrolling content box, SaveBar is the footer', async () => {
    const el = await mount()
    await go(el, 'Raw')
    const shell = region(el, 'page-shell')!
    expect(shell).not.toBeNull()
    expectShellHeader(el, '~/.claude/settings.json')
    const footer = region(el, 'page-shell-footer')!
    expect(footer).not.toBeNull()
    expect(footer.textContent?.toLowerCase()).toContain('save')
    const editorBox = region(el, 'settings-raw-editor')!
    expect(editorBox.parentElement?.getAttribute('data-testid')).toBe('page-shell-content')
    expect(editorBox.className).toMatch(/(^|\s)h-full(\s|$)/)
    expect(editorBox.className).toMatch(/(^|\s)overflow-clip(\s|$)/)
    expect(scrollersIn(shell)).toEqual(['page-shell-content'])
  })
})
