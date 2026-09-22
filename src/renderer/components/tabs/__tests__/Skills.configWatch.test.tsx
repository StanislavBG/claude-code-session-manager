// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { Skills } from '../Skills'
import { useLayout } from '../../../state/layout'
import { useSessions } from '../../../state/sessions'
import { useConfig } from '../../../state/config'
import type { ConfigChangedEvent } from '../../../../preload/api'

/**
 * Skills.tsx used to enumerate its scope root via a one-shot listDir in a
 * useEffect — only the currently-selected file was chokidar-watched. This
 * proves the whole scope-root directory (~/.claude/skills, ~/.claude/commands)
 * is now watched via the generic window.api.config.watch/config:changed
 * mechanism and the list re-fetches on an external change.
 */

vi.mock('../../ui/MarkdownEditor', () => ({
  MarkdownEditor: () => createElement('div', { 'data-testid': 'markdown-editor' }),
}))

const HOME = '/home/bilko'
const SKILLS_DIR = `${HOME}/.claude/skills`
const COMMANDS_DIR = `${HOME}/.claude/commands`

const SKILL_ONE_MD = ['---', 'name: skill-one', 'description: does one thing', '---', '', 'body'].join('\n')
const SKILL_TWO_MD = ['---', 'name: skill-two', 'description: does another thing', '---', '', 'body'].join('\n')

function installWindowApiMock() {
  const configChangedHandlers: Array<(e: ConfigChangedEvent) => void> = []
  let skillDirs = [{ name: 'skill-one', path: `${SKILLS_DIR}/skill-one`, isDirectory: true, isFile: false, mtimeMs: 0, size: 0 }]

  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      listDir: vi.fn(async (path: string, opts?: { filesOnly?: boolean; dirsOnly?: boolean }) => {
        if (path === SKILLS_DIR && opts?.dirsOnly) return { ok: true, error: null, entries: skillDirs }
        if (path === COMMANDS_DIR && opts?.filesOnly) return { ok: true, error: null, entries: [] }
        return { ok: true, error: null, entries: [] }
      }),
      readText: vi.fn(async (path: string) => {
        if (path === `${SKILLS_DIR}/skill-one/SKILL.md`) return { exists: true, text: SKILL_ONE_MD, mtimeMs: 0, error: null }
        if (path === `${SKILLS_DIR}/skill-two/SKILL.md`) return { exists: true, text: SKILL_TWO_MD, mtimeMs: 0, error: null }
        return { exists: false, text: '', mtimeMs: 0, error: null }
      }),
      writeText: vi.fn().mockResolvedValue({ ok: true }),
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
    files: { delete: vi.fn().mockResolvedValue({ ok: true }) },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return {
    api,
    addSkillTwo: () => {
      skillDirs = [
        ...skillDirs,
        { name: 'skill-two', path: `${SKILLS_DIR}/skill-two`, isDirectory: true, isFile: false, mtimeMs: 0, size: 0 },
      ]
    },
    emitConfigChanged: (path: string) =>
      configChangedHandlers.forEach((h) => h({ path, mtimeMs: Date.now(), kind: 'add' })),
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(Skills))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  return container
}

beforeEach(() => {
  useLayout.setState({ navFace: 'home' })
  useSessions.setState({ tabs: [], activeTabId: null })
  useConfig.setState({ files: {}, watchRefs: {} })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
})

describe('Skills watches its scope root via config:changed', () => {
  it('registers a watch on the user-scope skills and commands directories on mount', async () => {
    const { api } = installWindowApiMock()
    await mount()
    const watchedPaths = api.config.watch.mock.calls.flatMap((c) => c[0] as string[])
    expect(watchedPaths).toContain(SKILLS_DIR)
    expect(watchedPaths).toContain(COMMANDS_DIR)
  })

  it('re-lists skills when config:changed fires for the watched skills directory', async () => {
    const { addSkillTwo, emitConfigChanged } = installWindowApiMock()
    const el = await mount()
    expect(el.textContent).toContain('skill-one')
    expect(el.textContent).not.toContain('skill-two')

    addSkillTwo()
    await act(async () => {
      emitConfigChanged(SKILLS_DIR)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(el.textContent).toContain('skill-two')
  })

  it('unwatches the scope directories on unmount', async () => {
    const { api } = installWindowApiMock()
    await mount()
    act(() => root?.unmount())
    root = null
    const unwatchedPaths = api.config.unwatch.mock.calls.flatMap((c) => c[0] as string[])
    expect(unwatchedPaths).toContain(SKILLS_DIR)
    expect(unwatchedPaths).toContain(COMMANDS_DIR)
  })
})
