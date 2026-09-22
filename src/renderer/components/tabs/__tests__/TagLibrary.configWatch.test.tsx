// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TagLibrary } from '../TagLibrary'
import type { AgentPersona, ConfigChangedEvent } from '../../../../preload/api'

/**
 * Mirrors AgentLibrary.configWatch.test.tsx: agents:changed only echoes this
 * app's own writes, so TagLibrary must also watch ~/.claude/agents via the
 * generic config:changed mechanism and re-list on an external change.
 */

const HOME = '/home/bilko'
const AGENTS_DIR = `${HOME}/.claude/agents`

const PERSONAS: AgentPersona[] = [
  {
    name: 'builder', description: 'd', tools: [], model: null, effort: null, color: null,
    tags: ['feature'], projects: [], action: null, actionLabel: null,
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
      onChanged: vi.fn(() => () => {}),
    },
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
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
    root!.render(createElement(TagLibrary))
    await Promise.resolve()
    await Promise.resolve()
  })
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
})

describe('TagLibrary watches ~/.claude/agents via config:changed', () => {
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
      { ...PERSONAS[0], name: 'debugger', tags: [], path: `${AGENTS_DIR}/debugger.md` },
    ])
    await act(async () => {
      emitConfigChanged(AGENTS_DIR)
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
