// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

const { stub } = vi.hoisted(() => ({
  stub: (id: string) => () => ({ type: 'div', props: { 'data-testid': `stub-${id}` }, key: null, ref: null, $$typeof: Symbol.for('react.element') }),
}))
vi.mock('../../layout/VoiceModal', () => ({ VoiceModal: stub('voice') }))
vi.mock('../home/TerminalAppearanceCard', () => ({ TerminalAppearanceCard: stub('terminal') }))
vi.mock('../SettingsTelemetry', () => ({ SettingsTelemetry: stub('telemetry') }))
vi.mock('../SettingsRemote', () => ({ SettingsRemote: stub('remote') }))
vi.mock('../SettingsUpdates', () => ({ SettingsUpdates: stub('updates') }))
vi.mock('../SettingsOpsRetention', () => ({ SettingsOpsRetention: stub('retention') }))
vi.mock('../DataModel', () => ({ DataModel: stub('datamodel') }))
vi.mock('../../../lib/useDensity', () => ({ useDensity: () => ({ density: 'roomy', setDensity: vi.fn() }) }))

import { AppSettings } from '../AppSettings'

const HOME = '/home/bilko'
let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  ;(window as unknown as { api: unknown }).api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      readText: vi.fn().mockResolvedValue({ exists: true, mtimeMs: 0 }),
      onChanged: vi.fn(() => () => {}),
      readJson: vi.fn().mockResolvedValue({ raw: '{}', data: {}, exists: true, mtimeMs: 0, parseError: null, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
    },
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(createElement(AppSettings)); await Promise.resolve() })
})
afterEach(() => { act(() => root.unmount()); container.remove() })

const click = async (label: string) => {
  const b = Array.from(container.querySelectorAll('button')).find((x) => x.textContent === label)!
  await act(async () => { b.click(); await Promise.resolve(); await Promise.resolve() })
}
const chips = () => Array.from(container.querySelectorAll('[data-testid="source-chip-path"]')).map((c) => c.textContent ?? '')

describe('AppSettings', () => {
  it('offers the seven tabs', () => {
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent).slice(0, 7)
    expect(labels).toEqual(['Voice', 'Appearance', 'Telemetry', 'Phone remote', 'Updates & retention', 'Startup', 'Storage map'])
  })

  const cases: Array<[string, string[], string[]]> = [
    ['Voice', ['stub-voice'], ['voice.json']],
    ['Appearance', ['stub-terminal'], ['ui-settings-prefs.json', 'ui-chrome-prefs.json']],
    ['Telemetry', ['stub-telemetry'], ['telemetry.json', 'otel.json']],
    ['Phone remote', ['stub-remote'], ['web-remote.json']],
    ['Updates & retention', ['stub-updates', 'stub-retention'], ['updater.json', 'ops-retention.json']],
    ['Storage map', ['stub-datamodel'], []],
  ]
  it.each(cases)('%s mounts its view and names its files', async (label, ids, files) => {
    await click(label)
    for (const id of ids) expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull()
    const got = chips()
    expect(got).toHaveLength(files.length)
    files.forEach((fname, i) => expect(got[i]).toContain(fname))
  })

  it('Startup shows the open-to-Home toggle and app-prefs.json', async () => {
    await click('Startup')
    expect(container.textContent).toContain('Open to Home on launch')
    expect(chips()[0]).toContain('app-prefs.json')
  })
})
