// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { Settings } from '../Settings'
import { HOME, useNavfaceHarness } from './_navfaceHarness'

/**
 * Settings renders in the ConfigWorkbench frame: the left list and the detail are the only
 * scrollers, except Hooks (event list + event editor scroll side by side inside a
 * fixed-height body) and Raw (Monaco fills a non-scrolling box, SaveBar below it). The
 * double-scroll regression was an outer scroller wrapping an inner one; this pins every
 * scroll class to a known region.
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

const SCROLL_CLASS = /(^|\s)overflow(-y)?-(auto|scroll)(\s|$)/
const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`)

/** Scroll-class elements under `detail` (the detail region itself excluded). */
function innerScrollers(detail: HTMLElement): HTMLElement[] {
  return Array.from(detail.querySelectorAll<HTMLElement>('*')).filter((n) => SCROLL_CLASS.test(n.getAttribute('class') ?? ''))
}

async function open(el: HTMLElement, testId: string) {
  await act(async () => {
    q(el, testId)!.click()
    await Promise.resolve()
  })
}

describe('Settings scrolling inside the ConfigWorkbench', () => {
  it('General and Permissions: the detail region is the only detail scroller', async () => {
    const el = await mount()
    const detail = q(el, 'config-workbench-detail')!
    expect(SCROLL_CLASS.test(detail.className)).toBe(true)
    expect(innerScrollers(detail)).toEqual([])
    await open(el, 'settings-row-permissions')
    expect(detail.textContent).toContain('Default Mode')
    expect(innerScrollers(detail)).toEqual([])
  })

  it('Hooks: the event list and event editor are the two scrollers, inside a fixed-height body', async () => {
    const el = await mount()
    await open(el, 'settings-row-hooks')
    const body = q(el, 'settings-hooks-body')!
    expect(body.className).toMatch(/(^|\s)min-h-0(\s|$)/)
    const scrollers = innerScrollers(q(el, 'config-workbench-detail')!)
    expect(scrollers).toHaveLength(2)
    expect(scrollers.every((s) => s.parentElement === body)).toBe(true)
    expect(scrollers[0].textContent).toContain('PostToolUse')
    expect(scrollers[1].textContent).toContain('+ add group')
  })

  it('Raw: Monaco fills a non-scrolling box with the SaveBar below it', async () => {
    const el = await mount()
    await act(async () => {
      Array.from(el.querySelectorAll('button')).find((b) => b.textContent === '{ } Raw JSON')!.click()
      await Promise.resolve()
    })
    const box = q(el, 'settings-raw-editor')!
    expect(box.className).toMatch(/(^|\s)overflow-clip(\s|$)/)
    expect(box.className).toMatch(/(^|\s)flex-1(\s|$)/)
    expect(box.nextElementSibling?.textContent?.toLowerCase()).toContain('save')
    expect(innerScrollers(q(el, 'config-workbench-detail')!)).toEqual([])
  })
})
