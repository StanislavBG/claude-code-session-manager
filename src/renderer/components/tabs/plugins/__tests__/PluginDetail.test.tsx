// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { PluginDetail, pluginUpdateState, compareVersions } from '../PluginDetail'
import type { PluginRow } from '../../../../lib/pluginContents'
import { flushAsync } from '../../../../testUtils/domFlush'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * PluginDetail's header shows `Up to date` / `Update available` from the marketplace.json version the
 * catalog reader returns (omitted when it records none), and WHAT IT ADDS keeps manifest/folder order.
 */

const HOME = '/home/test'
const ROOT = `${HOME}/.claude/plugins`
const PATH = `${ROOT}/cache/mkt/commit-commands/1.0.1`
const MKT_FILE = `${ROOT}/marketplaces/mkt/.claude-plugin/marketplace.json`

const md = (name: string) => `---\nname: ${name}\ndescription: ${name} desc\n---\nbody\n`
const COMMANDS: Record<string, string> = {
  // Manifest-declared, deliberately not alphabetical.
  [`${PATH}/extra/zeta.md`]: md('zeta'),
  [`${PATH}/extra/alpha.md`]: md('alpha'),
  // Default folder, in listing order (also not alphabetical).
  [`${PATH}/commands/commit.md`]: md('commit'),
  [`${PATH}/commands/commit-push-pr.md`]: md('commit-push-pr'),
  [`${PATH}/commands/clean_gone.md`]: md('clean_gone'),
}
const FOLDER_ORDER = ['commit.md', 'commit-push-pr.md', 'clean_gone.md']

function makeRow(over: Partial<PluginRow> = {}): PluginRow {
  return {
    name: 'commit-commands',
    path: PATH,
    mtimeMs: 0,
    hasManifest: true,
    manifest: { name: 'commit-commands', version: '1.0.1', description: 'Git workflow commands' },
    hasLsp: false,
    monitors: 0,
    hooks: 0,
    agents: 0,
    commands: 5,
    skills: 0,
    binCount: 0,
    hasMcp: false,
    mcpServers: 0,
    marketplace: 'mkt',
    scope: 'user',
    key: 'commit-commands@mkt',
    enabled: true,
    ...over,
  }
}

const json = (data: unknown) => ({ exists: true, parseError: null, data, mtimeMs: 0, error: null })
const none = { exists: false, parseError: null, data: null, mtimeMs: 0, error: null }

function installApi(marketVersion: string | undefined) {
  ;(window as unknown as { api: unknown }).api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      readJson: vi.fn(async (p: string) => {
        if (p === `${PATH}/.claude-plugin/plugin.json`)
          return json({ name: 'commit-commands', version: '1.0.1', commands: ['./extra/zeta.md', './extra/alpha.md'] })
        if (p === `${ROOT}/known_marketplaces.json`) return json({ mkt: {} })
        if (p === MKT_FILE)
          return json({
            plugins: [
              { name: 'other', version: '9.9.9' },
              { name: 'commit-commands', ...(marketVersion ? { version: marketVersion } : {}) },
            ],
          })
        return none
      }),
      readText: vi.fn(async (p: string) =>
        COMMANDS[p] !== undefined ? { exists: true, text: COMMANDS[p], mtimeMs: 0, error: null } : { exists: false, text: '', mtimeMs: 0, error: null },
      ),
      exists: vi.fn(async (p: string) => p === `${PATH}/.claude-plugin/plugin.json` || p === `${PATH}/commands`),
      listDir: vi.fn(async (p: string) => ({
        ok: true,
        error: null,
        entries:
          p === `${PATH}/commands`
            ? FOLDER_ORDER.map((name) => ({ name, path: `${p}/${name}`, isDirectory: false, isFile: true, mtimeMs: 0, size: 0 }))
            : [],
      })),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(row: PluginRow = makeRow()) {
  act(() => {
    root.render(
      <PluginDetail row={row} home={HOME} busy={false} onToggle={() => {}} onUninstall={() => {}} onJump={() => {}} />,
    )
  })
  await flushAsync(30)
}

const updateControl = () => container.querySelector('[data-testid="plugin-update-state"]')

describe('PluginDetail update state', () => {
  it('shows "Up to date" when the marketplace lists the installed version', async () => {
    installApi('1.0.1')
    await render()
    expect(updateControl()?.textContent).toBe('Up to date')
    expect(updateControl()?.getAttribute('data-state')).toBe('up-to-date')
  })

  it('shows "Update available" when the marketplace lists a newer version', async () => {
    installApi('1.10.0')
    await render()
    expect(updateControl()?.textContent).toBe('Update available')
    expect(updateControl()?.getAttribute('title')).toBe('Installed v1.0.1 · mkt lists v1.10.0')
  })

  it('omits the control when the marketplace entry records no version', async () => {
    installApi(undefined)
    await render()
    expect(container.querySelector('[data-testid="plugin-detail"]')).not.toBeNull()
    expect(updateControl()).toBeNull()
  })

  it('omits the control when the installed manifest has no version', async () => {
    installApi('1.0.1')
    await render(makeRow({ manifest: { name: 'commit-commands' } }))
    expect(updateControl()).toBeNull()
  })

  it('compares versions numerically and never flags an older marketplace version', () => {
    expect(compareVersions('1.10.0', '1.9.2')).toBe(1)
    expect(compareVersions('v2.0', '2.0.0')).toBe(0)
    expect(pluginUpdateState('2.0.0', '1.9.0')).toBe('up-to-date')
    expect(pluginUpdateState('1.0.0', '1.0.1')).toBe('update-available')
    expect(pluginUpdateState('1.0.0', null)).toBeNull()
  })
})

describe('PluginDetail WHAT IT ADDS order', () => {
  it('lists manifest-declared commands in manifest order, then the folder in listing order — never alphabetical', async () => {
    installApi('1.0.1')
    await render()
    const names = [...container.querySelectorAll('[data-testid="plugin-adds-command"] .font-mono')].map((n) => n.textContent)
    expect(names).toEqual(['/zeta', '/alpha', '/commit', '/commit-push-pr', '/clean_gone'])
  })
})
