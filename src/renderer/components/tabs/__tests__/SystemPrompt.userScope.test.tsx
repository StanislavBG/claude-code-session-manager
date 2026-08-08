// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SystemPrompt } from '../SystemPrompt'
import { useLayout } from '../../../state/layout'
import { useSessions, type SessionTab } from '../../../state/sessions'
import { useConfig } from '../../../state/config'

/**
 * System Prompt edits ONE file — `~/.claude/CLAUDE.md` — and nothing else.
 *
 * The screen is HOME-only in the sidebar (navGroups.ts), where there is no
 * project context, so the old three-way User/Project/Local ScopeSwitcher could
 * only either dead-end ("no active project") or silently point at whatever
 * project owned the active top tab while the user was on a machine-wide
 * screen. `<cwd>/CLAUDE.md` and `<cwd>/CLAUDE.local.md` are contextual to a
 * project and are read by the CLI from the session's own cwd at invocation;
 * this suite locks in that neither is reachable — or readable — from here.
 */

const HOME = '/home/bilko'
const PROJECT_CWD = '/home/bilko/Projects/alpha'
const USER_CLAUDE_MD = `${HOME}/.claude/CLAUDE.md`

const PROJECT_TAB: SessionTab = {
  id: 'tab-alpha',
  sessionId: 'tab-alpha',
  label: 'alpha',
  cwd: PROJECT_CWD,
  pid: null,
  status: 'dormant',
  exitCode: null,
  startupCommand: null,
  presetId: null,
  generation: 0,
}

function installWindowApiMock() {
  const raw = '# user instructions\n'
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      readText: vi.fn().mockResolvedValue({ text: raw, raw, exists: true, mtimeMs: 0, error: null }),
      readJson: vi.fn().mockResolvedValue({
        raw: '{}', data: {}, exists: true, mtimeMs: 0, parseError: null, error: null,
      }),
      writeText: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      exists: vi.fn().mockResolvedValue(true),
      parseImports: vi.fn().mockResolvedValue({ ok: true, imports: [], error: null }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(SystemPrompt))
    await Promise.resolve()
    await Promise.resolve()
  })
  return container
}

function buttonLabels(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim() ?? '')
}

beforeEach(() => {
  installWindowApiMock()
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

describe('SystemPrompt is user-scope only', () => {
  it('offers no Project or Local scope control', async () => {
    const el = await mount()
    const labels = buttonLabels(el)
    expect(labels).not.toContain('Project')
    expect(labels).not.toContain('Local')
    expect(labels).not.toContain('User')
  })

  it('reads only ~/.claude/CLAUDE.md — never a project-scoped CLAUDE.md', async () => {
    await mount()
    const api = window.api as unknown as { config: { readText: ReturnType<typeof vi.fn>; watch: ReturnType<typeof vi.fn> } }
    const readPaths = api.config.readText.mock.calls.map((c) => String(c[0]))
    expect(readPaths).toContain(USER_CLAUDE_MD)
    expect(readPaths.some((p) => p.startsWith(PROJECT_CWD))).toBe(false)
    expect(api.config.watch.mock.calls.map((c) => String(c[0]))).toEqual([USER_CLAUDE_MD])
  })

  it('an active project tab changes nothing — still the one user file', async () => {
    const el = await mount()
    const api = window.api as unknown as { config: { readText: ReturnType<typeof vi.fn> } }
    await act(async () => {
      useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
      await Promise.resolve()
    })
    expect(api.config.readText.mock.calls.every((c) => String(c[0]) === USER_CLAUDE_MD)).toBe(true)
    expect(buttonLabels(el)).not.toContain('Project')
  })

  // A background split (Workbench's `renderer: 'always'`) can keep this screen
  // mounted while a TabBar click elsewhere flips navFace to 'project'. That
  // used to re-default the scope to the other project's CLAUDE.md underneath
  // the user; with one scope there is nothing left to flip.
  it('a navFace flip to project does not repoint the editor', async () => {
    const el = await mount()
    const api = window.api as unknown as { config: { readText: ReturnType<typeof vi.fn> } }
    await act(async () => {
      useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
      useLayout.setState({ navFace: 'project' })
      await Promise.resolve()
    })
    expect(api.config.readText.mock.calls.every((c) => String(c[0]) === USER_CLAUDE_MD)).toBe(true)
    expect(el.textContent).toContain(USER_CLAUDE_MD)
  })
})

describe('SystemPrompt states which file it edits and how far it reaches', () => {
  const note = (el: HTMLElement) =>
    el.querySelector('[data-testid="system-prompt-scope-note"]')?.textContent ?? ''

  it('names the real file, its machine-wide reach, and where project files are handled instead', async () => {
    const el = await mount()
    expect(note(el)).toContain('User system prompt')
    expect(note(el)).toContain('~/.claude/CLAUDE.md')
    expect(note(el)).toContain('every session it starts on this machine')
    expect(note(el)).toContain('not edited here')
    // The resolved absolute path, not just the ~ shorthand.
    expect(note(el)).toContain(USER_CLAUDE_MD)
  })
})
