// @vitest-environment jsdom
/**
 * Delete scope: the HOT KEYS strip Delete removes a macro from THIS project only
 * (macros.removeFromProject, same library call as the macro_delete MCP route);
 * only MacroEditor's "Delete everywhere" (behind a confirm) calls macros.delete.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SessionActionsBar } from '../SessionActionsBar'
import { __resetMacrosCacheForTests } from '../../../lib/useMacros'
import { useSessions } from '../../../state/sessions'
import { toast } from '../../../state/toast'
import type { AgentPersona, Macro } from '../../../../preload/api'

const CWD = '/home/bilko/Projects/alpha'
const OTHER = '/home/bilko/Projects/beta'
const m1: Macro = {
  id: 'm1', label: 'Sweep', agentName: 'scout', tag: 'bug', prompt: 'Sweep it.', projects: [CWD, OTHER],
  surface: 'sessions', createdAt: '', updatedAt: '',
} as Macro

const del = vi.fn(async () => ({ ok: true }))
const removeFromProject = vi.fn(async (_p: any): Promise<any> => ({ ok: true, deleted: false, macro: m1 }))
;(globalThis as any).window.api = {
  agents: {
    listPersonas: vi.fn(async (): Promise<AgentPersona[]> => [
      { name: 'scout', description: '', tools: [], model: null, effort: null, color: null, tags: ['bug'], projects: [], action: null, actionLabel: null, path: '', body: '', overridingProjects: [] } as AgentPersona,
    ]),
    onChanged: vi.fn(() => () => {}),
  },
  macros: {
    list: vi.fn(async () => [m1]),
    save: vi.fn(), setProject: vi.fn(), delete: del, removeFromProject,
    onChanged: vi.fn(() => () => {}),
  },
}

let container: HTMLDivElement | null = null
let root: Root | null = null
const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

beforeEach(async () => {
  __resetMacrosCacheForTests()
  del.mockClear(); removeFromProject.mockClear()
  useSessions.setState({ tabs: [{ id: 'tab-1', cwd: CWD } as any], activeTabId: 'tab-1' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} />) })
})
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

describe('macro delete scope', () => {
  it('strip Delete removes from this project only, never macros.delete', async () => {
    act(() => q('hotkey-manage')!.click())
    act(() => q('hotkey-delete')!.click())
    await act(async () => { q('hotkey-delete-yes')!.click() })
    expect(removeFromProject).toHaveBeenCalledWith({ id: 'm1', cwd: CWD })
    expect(del).not.toHaveBeenCalled()
  })

  it('strip Delete surfaces a refusal as a toast', async () => {
    const err = vi.spyOn(toast, 'error').mockImplementation(() => undefined as any)
    removeFromProject.mockResolvedValueOnce({ ok: false, error: 'nope' })
    act(() => q('hotkey-manage')!.click())
    act(() => q('hotkey-delete')!.click())
    await act(async () => { q('hotkey-delete-yes')!.click() })
    expect(err).toHaveBeenCalledWith('nope')
    err.mockRestore()
  })

  it('MacroEditor Delete everywhere confirms, then calls macros.delete', async () => {
    act(() => q('hotkey-manage')!.click())
    act(() => q('hotkey-edit')!.click())
    act(() => q('macro-delete-everywhere')!.click())
    expect(del).not.toHaveBeenCalled()
    act(() => q('macro-delete-everywhere-no')!.click())
    expect(del).not.toHaveBeenCalled()
    act(() => q('macro-delete-everywhere')!.click())
    await act(async () => { q('macro-delete-everywhere-yes')!.click() })
    expect(del).toHaveBeenCalledWith({ id: 'm1' })
    expect(removeFromProject).not.toHaveBeenCalled()
  })
})
