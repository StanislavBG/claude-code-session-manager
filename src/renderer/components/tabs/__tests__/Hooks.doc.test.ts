// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushAsync } from '../../../testUtils/domFlush'

/**
 * The Hooks tab sidebar should surface each event's HOOK_EVENT_DOCS `when`
 * summary inline under the event name (not only on hover via Tooltip), and
 * show "no documentation yet" inline for events without a doc entry.
 */

const SETTINGS_PATH = '/home/test/.claude/settings.json'

function installWindowApiMock() {
  const raw = JSON.stringify({ hooks: {} }, null, 2) + '\n'
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue('/home/test') },
    config: {
      readJson: vi.fn(async (path: string) => {
        if (path === SETTINGS_PATH) {
          return { exists: true, parseError: false, data: JSON.parse(raw), mtimeMs: 0, error: null, raw }
        }
        return { exists: false, parseError: false, data: null, mtimeMs: 0, error: null, raw: '' }
      }),
      readText: vi.fn(async (path: string) => {
        if (path === SETTINGS_PATH) return { exists: true, raw, mtimeMs: 0, error: null }
        return { exists: false, raw: '', mtimeMs: 0, error: null }
      }),
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
  return { api }
}

const flush = () => flushAsync(4)

describe('Hooks sidebar inline docs', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  it('shows the doc.when summary inline for documented events, and a no-documentation note for undocumented ones', async () => {
    installWindowApiMock()
    const { HOOK_EVENT_DOCS: REAL_DOCS } = await import('../../../data/hookEventDocs')

    const documentedEvent = 'PreToolUse'
    const undocumentedEvent = 'ElicitationResult'
    const expectedWhen = REAL_DOCS[documentedEvent]!.when

    // Real HOOK_EVENT_DOCS currently covers every HookEvent; stub it with one
    // entry removed so the "no documentation yet" inline path is exercised.
    const stubbedDocs = { ...REAL_DOCS } as Record<string, unknown>
    delete stubbedDocs[undocumentedEvent]
    vi.doMock('../../../data/hookEventDocs', () => ({ HOOK_EVENT_DOCS: stubbedDocs }))

    const { Hooks } = await import('../Hooks')

    const root = createRoot(container)
    act(() => {
      root.render(createElement(Hooks))
    })
    await flush()

    const eventsTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Events')
    expect(eventsTab).toBeTruthy()
    act(() => {
      eventsTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    const documentedButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(documentedEvent),
    )
    expect(documentedButton).toBeTruthy()
    expect(documentedButton!.textContent).toContain(expectedWhen)

    const undocumentedButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(undocumentedEvent),
    )
    expect(undocumentedButton).toBeTruthy()
    expect(undocumentedButton!.textContent).toContain('no documentation yet')

    act(() => root.unmount())
  })
})
