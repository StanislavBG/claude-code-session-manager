// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AgentLibrary } from '../AgentLibrary'
import { useSessions, type SessionTab } from '../../../state/sessions'
import type { AgentPersona, ConfigChangedEvent } from '../../../../preload/api'

// The real pane mounts Tiptap/Monaco; the stub keeps the contract this page relies on:
// controlled body text, Document mode by default, and the status bar's Save/Revert.
// These tests drive the expanded 316 px list; the default (collapsed rail) has its own spec, AgentSheet.test.tsx.
vi.mock('../../../lib/uiSettingsPrefs', () => ({
  readUiSettingsPrefs: async () => ({ agentsListExpanded: true }),
  writeUiSettingsPrefs: async () => {},
}))

vi.mock('../editor/DocumentEditorPane', () => ({
  DocumentEditorPane: (p: { path: string; value: string; defaultMode?: string; dirty?: boolean; onChange: (v: string) => void; onSave?: () => void; onRevert?: () => void }) =>
    createElement('div', { 'data-testid': 'document-editor-pane', 'data-mode': p.defaultMode, 'data-path': p.path }, [
      createElement('textarea', { key: 'ta', 'data-testid': 'document-editor-body', value: p.value, onChange: (e: { target: { value: string } }) => p.onChange(e.target.value) }),
      createElement('button', { key: 'r', 'data-testid': 'editor-revert', disabled: !p.dirty, onClick: () => p.onRevert?.() }, 'Revert'),
      createElement('button', { key: 's', 'data-testid': 'editor-save', disabled: !p.dirty, onClick: () => p.onSave?.() }, 'Save'),
    ]),
}))

/**
 * agents:changed (window.api.agents.onChanged) only fires as a write-echo
 * from this app's OWN save/delete (agentLibrary.cjs) — an external edit to
 * ~/.claude/agents/*.md is otherwise invisible. This proves AgentLibrary also
 * watches the agents directory via the generic window.api.config.watch/
 * config:changed mechanism (useScopedConfigFiles.ts's pattern) and re-lists
 * on a change event for that path, independent of the agents:changed echo.
 */

const HOME = '/home/bilko'
const AGENTS_DIR = `${HOME}/.claude/agents`

const PERSONAS: AgentPersona[] = [
  {
    name: 'builder', loadout: 'unbound', description: 'd', tools: [], model: null, effort: null, color: null,
    tags: [], projects: [], action: null, actionLabel: null,
    path: `${AGENTS_DIR}/builder.md`, body: 'b', overridingProjects: [],
  },
]

function installWindowApiMock() {
  const configChangedHandlers: Array<(e: ConfigChangedEvent) => void> = []
  const api = {
    agents: {
      listPersonas: vi.fn().mockResolvedValue(PERSONAS),
      savePersona: vi.fn().mockResolvedValue({ ok: true, path: '' }),
      deletePersona: vi.fn().mockResolvedValue({ ok: true }),
      removeOverride: vi.fn().mockResolvedValue({ ok: true }),
      // agents:changed — never fired in this suite, proving the config:changed
      // path is the one doing the work below.
      onChanged: vi.fn(() => () => {}),
    },
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      listDir: vi.fn().mockResolvedValue([]),
      readText: vi.fn().mockResolvedValue(''),
      exists: vi.fn().mockResolvedValue(false),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn((handler: (e: ConfigChangedEvent) => void) => {
        configChangedHandlers.push(handler)
        return () => {
          const i = configChangedHandlers.indexOf(handler)
          if (i >= 0) configChangedHandlers.splice(i, 1)
        }
      }),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return {
    api,
    emitConfigChanged: (path: string) =>
      configChangedHandlers.forEach((h) => h({ path, mtimeMs: Date.now(), kind: 'change' })),
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(AgentLibrary))
    await Promise.resolve()
    await Promise.resolve()
  })
  // The roster is the landing; open the first persona's sheet like the old auto-selection did.
  await act(async () => {
    container!.querySelector<HTMLElement>('[data-testid="agent-card"]')?.click()
    await Promise.resolve()
  })
  return container
}

beforeEach(() => {
  useSessions.setState({ tabs: [], activeTabId: null })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
})

describe('AgentLibrary watches ~/.claude/agents via config:changed', () => {
  it('registers a watch on the global agents directory on mount', async () => {
    const { api } = installWindowApiMock()
    await mount()
    const watchedPaths = api.config.watch.mock.calls.flatMap((c) => c[0] as string[])
    expect(watchedPaths).toContain(AGENTS_DIR)
  })

  it('re-fetches personas when config:changed fires for the watched agents directory', async () => {
    const { api, emitConfigChanged } = installWindowApiMock()
    await mount()
    expect(api.agents.listPersonas).toHaveBeenCalledTimes(1)

    api.agents.listPersonas.mockResolvedValueOnce([
      ...PERSONAS,
      { ...PERSONAS[0], name: 'debugger', path: `${AGENTS_DIR}/debugger.md` },
    ])
    await act(async () => {
      emitConfigChanged(AGENTS_DIR)
      await Promise.resolve()
    })
    expect(api.agents.listPersonas).toHaveBeenCalledTimes(2)
  })

  it('does not re-fetch for a config:changed event on an unrelated path', async () => {
    const { api, emitConfigChanged } = installWindowApiMock()
    await mount()
    expect(api.agents.listPersonas).toHaveBeenCalledTimes(1)
    await act(async () => {
      emitConfigChanged('/home/bilko/.claude/settings.json')
      await Promise.resolve()
    })
    expect(api.agents.listPersonas).toHaveBeenCalledTimes(1)
  })

  it('watches every open project overlay directory with no active tab set, and re-lists on a change in one', async () => {
    const tab = (id: string, cwd: string): SessionTab => ({
      id, sessionId: id, label: id, cwd,
      pid: null, status: 'dormant', exitCode: null, startupCommand: null, presetId: null, generation: 0,
    })
    useSessions.setState({
      tabs: [tab('t1', '/home/bilko/Projects/alpha'), tab('t2', '/home/bilko/Projects/beta/')],
      activeTabId: null,
    })
    const { api, emitConfigChanged } = installWindowApiMock()
    await mount()
    const watchedPaths = api.config.watch.mock.calls.flatMap((c) => c[0] as string[])
    expect(watchedPaths).toEqual(expect.arrayContaining([
      AGENTS_DIR,
      '/home/bilko/Projects/alpha/.claude/agents',
      '/home/bilko/Projects/beta/.claude/agents',
    ]))
    expect(api.agents.listPersonas).toHaveBeenCalledTimes(1)
    await act(async () => {
      emitConfigChanged('/home/bilko/Projects/beta/.claude/agents')
      await Promise.resolve()
    })
    expect(api.agents.listPersonas).toHaveBeenCalledTimes(2)
  })

  it('unwatches the agents directory on unmount', async () => {
    const { api } = installWindowApiMock()
    await mount()
    act(() => root?.unmount())
    root = null
    const unwatchedPaths = api.config.unwatch.mock.calls.flatMap((c) => c[0] as string[])
    expect(unwatchedPaths).toContain(AGENTS_DIR)
  })
})
