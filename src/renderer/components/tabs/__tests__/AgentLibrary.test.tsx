// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AgentLibrary } from '../AgentLibrary'
import type { AgentPersona } from '../../../../preload/api'
import { useConfigSearchFocus } from '../../../state/configSearchFocus'

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
 * AgentLibrary is a component-local fetch (no store) list+detail page, per
 * Skills.tsx's canonical shape — mirrors Skills.navface.test.tsx's
 * window.api mocking approach but with no NavFace-driven scope switcher
 * (this page is Home-face-only).
 */

const PERSONAS: AgentPersona[] = [
  {
    name: 'builder',
    description: 'Watch git history and drive the next publish.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    model: null,
    effort: null, color: null,
    tags: [], projects: [], action: null, actionLabel: null,
    path: '/home/bilko/.claude/agents/builder.md',
    body: 'You are the Builder agent.',
    overridingProjects: ['session-manager'],
    overrideDetails: [{ project: 'session-manager', cwd: '/home/bilko/Projects/session-manager', fields: [], bodyOverridden: true, issue: null }],
  },
  {
    name: 'debugger',
    description: 'Diagnose a failing test.',
    tools: [],
    model: null,
    effort: null, color: null,
    tags: [], projects: [], action: null, actionLabel: null,
    path: '/home/bilko/.claude/agents/debugger.md',
    body: 'You are the Debugger agent.',
    overridingProjects: [],
    overrideDetails: [],
  },
]

// Pinned to a concrete model id outside AgentLibrary's fixed MODELS tuple —
// the Choice control must still render this as selected (never blank, never
// silently overwritten on first click).
const PINNED_MODEL_PERSONA: AgentPersona = {
  name: 'pinned-model-agent',
  description: 'Pinned to a concrete model id outside the standard list.',
  tools: [],
  model: 'claude-opus-5',
  effort: null, color: null,
  tags: [], projects: [], action: null, actionLabel: null,
  path: '/home/bilko/.claude/agents/pinned-model-agent.md',
  body: 'You are pinned to a concrete model.',
  overridingProjects: [],
  overrideDetails: [],
}

function installWindowApiMock(personas: AgentPersona[] = PERSONAS) {
  const changedHandlers: Array<() => void> = []
  const api = {
    agents: {
      listPersonas: vi.fn().mockResolvedValue(personas),
      savePersona: vi.fn().mockResolvedValue({ ok: true, path: '' }),
      deletePersona: vi.fn().mockResolvedValue({ ok: true }),
      removeOverride: vi.fn().mockResolvedValue({ ok: true }),
      onChanged: vi.fn((handler: () => void) => {
        changedHandlers.push(handler)
        return () => {
          const i = changedHandlers.indexOf(handler)
          if (i >= 0) changedHandlers.splice(i, 1)
        }
      }),
    },
    app: { homeDir: vi.fn().mockResolvedValue('/home/bilko') },
    config: {
      listDir: vi.fn().mockResolvedValue([]),
      readText: vi.fn().mockResolvedValue(''),
      exists: vi.fn().mockResolvedValue(false),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { api, emitChanged: () => changedHandlers.forEach((h) => h()) }
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
  installWindowApiMock()
  useConfigSearchFocus.getState().clear()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
})

describe('AgentLibrary', () => {
  it('fetches personas on mount and lists them', async () => {
    const el = await mount()
    expect(el.textContent).toContain('builder')
    expect(el.textContent).toContain('debugger')
    const card = el.querySelector('[data-testid="config-file-card"]')!
    expect(card.textContent).toContain('AGENTS FOLDER')
    expect(card.textContent).toContain('~/.claude/agents/')
    expect(card.textContent).toContain('2')
    expect(card.textContent).toContain('The actor a session opens with')
  })

  it('selects the first persona by default and shows its detail, incl. the overriding project (AC 6: builder overridden by session-manager)', async () => {
    const el = await mount()
    expect(el.textContent).toContain('Watch git history and drive the next publish.')
    expect(el.textContent).toContain('session-manager')
    expect(el.textContent).toContain('Read')
  })

  it('surfaces the model field as this persona\'s per-Epic default model (agent-model-nav-consolidation)', async () => {
    const el = await mount()
    const runtime = el.querySelector('[data-testid="agent-runtime-card"]')!
    for (const label of ['model', 'effort', 'runs on']) expect(runtime.textContent).toContain(label)
    expect(el.querySelector('[data-testid="agent-tools-row"]')).toBeTruthy()
    expect(el.querySelector('[data-testid="agent-overrides-row"]')!.textContent).toContain('project overrides')
    expect((el.querySelector('[data-testid="model-select"]') as HTMLSelectElement).title).toContain("This persona's default model for its Epics")
  })

  it('clicking another persona swaps the detail pane', async () => {
    const el = await mount()
    const debuggerRow = el.querySelector('[data-agent-row="debugger"] [data-testid="config-list-row"]')
    await act(async () => {
      debuggerRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(el.textContent).toContain('Diagnose a failing test.')
    expect(el.textContent).toContain('no open project overlays this agent')
  })

  it('has no Action section, and a save passes existing projects/action/actionLabel through untouched', async () => {
    const actionPersona: AgentPersona = { ...PERSONAS[0], projects: ['*'], action: 'Sweep it.', actionLabel: 'Sweep' }
    const { api } = installWindowApiMock([actionPersona, PERSONAS[1]])
    const el = await mount()
    expect(el.textContent).not.toContain('action — appears in')
    expect(el.textContent).not.toContain('every project')
    const tag = Array.from(el.querySelectorAll('button')).find((b) => /^#/.test(b.textContent ?? ''))!
    await act(async () => { tag.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve() })
    const save = el.querySelector('[data-testid="agent-save"]') as HTMLElement
    await act(async () => { save.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve() })
    expect(api.agents.savePersona).toHaveBeenCalledTimes(1)
    expect(api.agents.savePersona.mock.calls[0][0]).toMatchObject({ projects: ['*'], action: 'Sweep it.', actionLabel: 'Sweep' })
  })

  it('filters the list by name', async () => {
    const el = await mount()
    const input = el.querySelector('input[placeholder="Filter"]') as HTMLInputElement
    // React tracks the input's previous value internally; setting .value via
    // plain JS before dispatching 'input' doesn't register as a change
    // unless we go through the native setter React itself overrides.
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(input, 'debug')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    const rowNames = Array.from(el.querySelectorAll('[data-agent-row]')).map((r) => r.getAttribute('data-agent-row') ?? '')
    expect(rowNames.some((t) => t.includes('debugger'))).toBe(true)
    expect(rowNames.some((t) => t.startsWith('builder'))).toBe(false)
  })

  it('re-fetches personas when agents:changed fires — Tag Library edits the same file from its own side', async () => {
    const { api, emitChanged } = installWindowApiMock()
    const el = await mount()
    expect(api.agents.listPersonas).toHaveBeenCalledTimes(1)

    api.agents.listPersonas.mockResolvedValueOnce([
      { ...PERSONAS[0], tags: ['feature'] },
      PERSONAS[1],
    ])
    await act(async () => {
      emitChanged()
      await Promise.resolve()
    })
    expect(api.agents.listPersonas).toHaveBeenCalledTimes(2)
    expect(el.textContent).toContain('builder')
  })

  it('deletes a persona directly from the list row via its inline delete action', async () => {
    const { api } = installWindowApiMock()
    const el = await mount()
    const debuggerRow = el.querySelector('[data-agent-row="debugger"]')!
    const deleteBtn = Array.from(debuggerRow.querySelectorAll('button')).find((b) => b.title === 'Delete debugger')!
    await act(async () => {
      deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    const confirmBtn = Array.from(debuggerRow.querySelectorAll('button')).find((b) => b.textContent === 'confirm')!
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(api.agents.deletePersona).toHaveBeenCalledWith({ name: 'debugger' })
  })

  it('renders an out-of-list model as a selected, marked option and keeps it selected across a re-render', async () => {
    installWindowApiMock([PINNED_MODEL_PERSONA, ...PERSONAS])
    const el = await mount()

    const row = el.querySelector('[data-agent-row="pinned-model-agent"] [data-testid="config-list-row"]')!
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    const modelSelect = () => el.querySelector('[data-testid="model-select"]') as HTMLSelectElement
    const current = () => Array.from(modelSelect().options).find((o) => o.textContent === 'claude-opus-5 (current)')

    expect(current()).toBeTruthy()
    expect(modelSelect().value).toBe('claude-opus-5')

    // Force a re-render (toggling a tool) and confirm the pinned model is still
    // selected — it must never be silently swapped to one of the fixed options.
    const toolButton = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Read')!
    await act(async () => {
      toolButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(current()).toBeTruthy()
    expect(modelSelect().value).toBe('claude-opus-5')
  })

  it('editing the description of a persona with a title saves the same title', async () => {
    const titled: AgentPersona = { ...PERSONAS[0], title: 'Engineering — Software Engineer' }
    const { api } = installWindowApiMock([titled, PERSONAS[1]])
    const el = await mount()
    const field = el.querySelector('[data-testid="agent-detail-description"]') as HTMLTextAreaElement
    expect(field.value).toBe('Watch git history and drive the next publish.')
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(field, 'Edited description.')
      field.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    const save = el.querySelector('[data-testid="agent-save"]') as HTMLElement
    await act(async () => { save.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve() })
    expect(api.agents.savePersona).toHaveBeenCalledTimes(1)
    expect(api.agents.savePersona.mock.calls[0][0]).toMatchObject({ description: 'Edited description.', title: 'Engineering — Software Engineer' })
  })

  it('rows show the mono name, the model on the right and a one-line description', async () => {
    installWindowApiMock([{ ...PERSONAS[0], model: 'opus' }, PERSONAS[1]])
    const el = await mount()
    const row = el.querySelector('[data-agent-row="builder"]')!
    expect(row.querySelector('[data-testid="agent-row-model"]')!.textContent).toBe('opus')
    expect(el.querySelector('[data-agent-row="debugger"] [data-testid="agent-row-model"]')!.textContent).toBe('inherit')
    expect(row.textContent).toContain('Watch git history and drive the next publish.')
  })

  it('detail header reads AGENT · USER · <path>, with Duplicate and ⋯ (Delete agent… confirms then deletes)', async () => {
    const { api } = installWindowApiMock()
    const el = await mount()
    const header = el.querySelector('[data-testid="config-detail-header"]')!
    expect(header.textContent).toContain('AGENT · USER · ~/.claude/agents/builder.md')
    expect(header.textContent).toContain('builder')
    expect(Array.from(header.querySelectorAll('button')).some((b) => b.textContent === 'Duplicate')).toBe(true)
    expect(el.textContent).toContain('CLAUDE READS THIS TO PICK THE AGENT')
    await act(async () => { (el.querySelector('[data-testid="agent-detail-more"]') as HTMLElement).click(); await Promise.resolve() })
    await act(async () => { (el.querySelector('[data-testid="agent-detail-delete"]') as HTMLElement).click(); await Promise.resolve() })
    const confirm = el.querySelector('[data-testid="agent-detail-delete-confirm"]')!
    const del = Array.from(confirm.querySelectorAll('button')).find((b) => b.textContent === 'Delete')!
    await act(async () => { del.click(); await Promise.resolve() })
    expect(api.agents.deletePersona).toHaveBeenCalledWith({ name: 'builder' })
  })

  it('tools render allowed filled and the rest dashed', async () => {
    const el = await mount()
    const tool = (t: string) => el.querySelector(`[data-testid="agent-tools-row"] [data-tool="${t}"]`) as HTMLElement
    expect(tool('Read').getAttribute('aria-pressed')).toBe('true')
    expect(tool('Read').className).not.toContain('border-dashed')
    expect(tool('Write').getAttribute('aria-pressed')).toBe('false')
    expect(tool('Write').className).toContain('border-dashed')
  })

  it('an agent with no tools field shows every tool filled with an "All tools" note; restricting one writes the rest', async () => {
    const { api } = installWindowApiMock()
    const el = await mount()
    await act(async () => { (el.querySelector('[data-agent-row="debugger"] [data-testid="config-list-row"]') as HTMLElement).click(); await Promise.resolve() })
    const row = el.querySelector('[data-testid="agent-tools-row"]')!
    for (const b of Array.from(row.querySelectorAll('[data-tool]'))) {
      expect(b.getAttribute('aria-pressed')).toBe('true')
      expect(b.className).not.toContain('border-dashed')
    }
    expect(el.querySelector('[data-testid="agent-tools-note"]')!.textContent).toContain('All tools')
    await act(async () => { (row.querySelector('[data-tool="Bash"]') as HTMLElement).click(); await Promise.resolve() })
    expect((row.querySelector('[data-tool="Bash"]') as HTMLElement).className).toContain('border-dashed')
    await act(async () => { (el.querySelector('[data-testid="agent-save"]') as HTMLElement).click(); await Promise.resolve() })
    const sent = api.agents.savePersona.mock.calls[0][0].tools as string[]
    expect(sent).not.toContain('Bash')
    expect(sent).toContain('Read')
  })

  it('MODEL, EFFORT and RUNS ON are three compact selects in one row, help as a title', async () => {
    const el = await mount()
    const row = el.querySelector('[data-testid="agent-runtime-row"]')!
    const selects = Array.from(row.querySelectorAll('select'))
    expect(selects.map((s) => s.getAttribute('data-testid'))).toEqual(['model-select', 'effort-select', 'agent-persona-cli-select'])
    for (const s of selects) expect(s.title.length).toBeGreaterThan(0)
    expect(row.textContent).not.toContain("This persona's default model for its Epics")
    expect(row.querySelector('button')).toBeNull()
  })

  it('MODEL, EFFORT and RUNS ON are styled like the Settings row selects, each with its own chevron', async () => {
    const el = await mount()
    const row = el.querySelector('[data-testid="agent-runtime-row"]')!
    for (const id of ['model-select', 'effort-select', 'agent-persona-cli-select']) {
      const s = row.querySelector(`[data-testid="${id}"]`) as HTMLSelectElement
      const cls = s.className.split(/\s+/)
      for (const c of ['appearance-none', 'bg-bg-hi', 'border-line', 'rounded']) expect(cls).toContain(c)
      const chevron = row.querySelector(`[data-testid="${id}-chevron"]`)!
      expect(chevron.getAttribute('class')).toContain('text-fg-faint')
      expect(chevron.parentElement).toBe(s.parentElement)
    }
  })

  it('the sheet fills the pane at least, grows with its content (scrolled by the workbench), with a right column and the save bar', async () => {
    const el = await mount()
    const detail = el.querySelector('[data-testid="agent-sheet"]')!
    expect(detail.parentElement!.getAttribute('data-testid')).toBe('config-workbench-detail')
    const detailCls = detail.className.split(/\s+/)
    for (const c of ['flex', 'flex-col', 'min-h-full', 'shrink-0']) expect(detailCls).toContain(c)
    expect(detailCls).not.toContain('min-h-0')
    expect(el.querySelector('[data-testid="agent-detail-body"]')!.className).not.toContain('min-h-0')
    for (const id of ['agent-gear-slot', 'agent-constraints-slot', 'agent-applies-to', 'agent-save-bar']) expect(el.querySelector(`[data-testid="${id}"]`)).toBeTruthy()
    expect(el.querySelector('[data-testid="agent-applies-to"]')!.textContent).toContain('Changes apply to new sessions')
    // The persona body editor opens full screen from the preview, not inline.
    expect(el.querySelector('[data-testid="agent-detail-editor"]')).toBeNull()
    await act(async () => { (el.querySelector('[data-testid="agent-open-editor"]') as HTMLElement).click(); await Promise.resolve() })
    expect(el.querySelector('[data-testid="agent-detail-editor"]')!.className).toContain('fixed inset-0')
  })

  it('the ⋯ menu carries re-check and the model catalog info', async () => {
    const el = await mount()
    await act(async () => { (el.querySelector('[data-testid="agent-detail-more"]') as HTMLElement).click(); await Promise.resolve() })
    expect(el.querySelector('[data-testid="agent-detail-recheck"]')).toBeTruthy()
    expect(el.querySelector('[data-testid="agent-detail-catalog-info"]')!.textContent).toMatch(/catalog|claude/i)
  })

  it('colour and tags sit in a Details disclosure of the sheet', async () => {
    const el = await mount()
    const details = el.querySelector('[data-testid="agent-details"]')!
    expect(details.tagName).toBe('DETAILS')
    expect(details.querySelector('[data-testid="agent-detail-name"]')).toBeTruthy()
    expect(Array.from(details.querySelectorAll('button')).some((b) => /^#/.test(b.textContent ?? ''))).toBe(true)
    expect(el.querySelector('[data-testid="config-detail-header"]')!.textContent).toContain('builder')
  })

  it('the Personas | Tags switch lives in the AGENTS FOLDER card and swaps in the Tags view', async () => {
    const el = await mount()
    const card = () => el.querySelector('[data-testid="config-file-card"]')!
    const pill = card().querySelector('[data-testid="agent-view-switch"]')!
    expect(pill.getAttribute('role')).toBe('group')
    expect(pill.className).toContain('rounded')
    expect(pill.className).toContain('bg-bg-hi')
    const btn = (label: string) => Array.from(card().querySelectorAll('[data-testid="agent-view-switch"] button')).find((b) => b.textContent === label) as HTMLButtonElement
    expect(btn('Personas').getAttribute('aria-pressed')).toBe('true')
    expect(btn('Personas').className).toContain('shadow-sm')
    expect(btn('Tags').getAttribute('aria-pressed')).toBe('false')
    await act(async () => { btn('Tags').click(); await Promise.resolve() })
    expect(btn('Tags').getAttribute('aria-pressed')).toBe('true')
    expect(btn('Tags').className).toContain('shadow-sm')
    expect(btn('Personas').getAttribute('aria-pressed')).toBe('false')
    expect(el.querySelector('[data-agent-row]')).toBeNull()
    expect(el.querySelector('[data-testid="config-file-card"]')).toBeTruthy()
    expect(el.textContent).toContain('agents carrying this tag')
  })

  it('renders a project override chip for a persona with an overlay', async () => {
    installWindowApiMock([
      {
        ...PERSONAS[1],
        overridingProjects: ['Self'],
        overrideDetails: [{ project: 'Self', cwd: '/home/bilko/Self', fields: ['model', 'effort'], values: { model: 'sonnet', effort: 'medium' }, bodyOverridden: false, issue: null }],
      },
    ])
    const el = await mount()
    const chips = el.querySelectorAll('[data-testid="agent-override-chip"]')
    expect(chips).toHaveLength(1)
    expect(chips[0].textContent).toContain('Self')
    expect(chips[0].textContent).toContain('sonnet · medium')
    expect(el.querySelector('[data-testid="agent-overrides-row"]')!.textContent).toContain('a local copy in ~/Self/.claude/agents/ wins there')
    expect(el.querySelector('[data-testid="project-override-block"]')).toBeNull()
    const add = el.querySelector('[data-testid="agent-override-add"]') as HTMLElement
    expect(add.textContent).toBe('+ Add override')
    await act(async () => { add.click(); await Promise.resolve() })
    expect(el.querySelector('[data-testid="override-project-select"]')).toBeTruthy()
  })

  it('the body is edited in DocumentEditorPane (Document mode) and saved as the body, Revert discards it', async () => {
    const { api } = installWindowApiMock()
    const el = await mount()
    expect(el.querySelector('[data-testid="document-editor-pane"]')).toBeNull()
    await act(async () => { (el.querySelector('[data-testid="agent-open-editor"]') as HTMLElement).click(); await Promise.resolve() })
    const pane = el.querySelector('[data-testid="document-editor-pane"]')!
    expect(pane.getAttribute('data-mode')).toBe('document')
    const body = el.querySelector('[data-testid="document-editor-body"]') as HTMLTextAreaElement
    expect(body.value).toBe('You are the Builder agent.')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { setter.call(body, 'Edited body.'); body.dispatchEvent(new Event('input', { bubbles: true })); await Promise.resolve() })
    await act(async () => { (el.querySelector('[data-testid="agent-revert"]') as HTMLElement).click(); await Promise.resolve() })
    expect((el.querySelector('[data-testid="document-editor-body"]') as HTMLTextAreaElement).value).toBe('You are the Builder agent.')
    const body2 = el.querySelector('[data-testid="document-editor-body"]') as HTMLTextAreaElement
    await act(async () => { setter.call(body2, 'Edited body.'); body2.dispatchEvent(new Event('input', { bubbles: true })); await Promise.resolve() })
    await act(async () => { (el.querySelector('[data-testid="agent-save"]') as HTMLElement).click(); await Promise.resolve() })
    expect(api.agents.savePersona).toHaveBeenCalledTimes(1)
    expect(api.agents.savePersona.mock.calls[0][0]).toMatchObject({ name: 'builder', body: 'Edited body.', description: 'Watch git history and drive the next publish.' })
  })
})

describe('AgentLibrary config-search focus', () => {
  const selectedRow = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('[data-agent-row]')).find(
      (r) => r.querySelector('[data-testid="config-list-row"]')?.getAttribute('aria-selected') === 'true',
    )?.getAttribute('data-agent-row')
  const typeFilter = async (el: HTMLElement, v: string) => {
    const input = el.querySelector('input[placeholder="Filter"]') as HTMLInputElement
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(input, v)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
  }

  it('selects the persona a search result names, clearing a filter that hides it, then clears the request', async () => {
    const el = await mount()
    await typeFilter(el, 'build')
    expect(selectedRow(el)).toBe('builder')
    await act(async () => {
      useConfigSearchFocus.getState().set('agents', 'agents:debugger')
      await Promise.resolve()
    })
    expect(selectedRow(el)).toBe('debugger')
    expect((el.querySelector('input[placeholder="Filter"]') as HTMLInputElement).value).toBe('')
    expect(el.textContent).toContain('no open project overlays this agent')
    expect(useConfigSearchFocus.getState()).toMatchObject({ tab: null, id: null })
  })

  it('keeps the current selection for an id that matches nothing, and still clears the request', async () => {
    const el = await mount()
    await act(async () => {
      (el.querySelector('[data-agent-row="debugger"] [data-testid="config-list-row"]') as HTMLElement).click()
      await Promise.resolve()
    })
    await act(async () => {
      useConfigSearchFocus.getState().set('agents', 'agents:no-such-agent')
      await Promise.resolve()
    })
    expect(selectedRow(el)).toBe('debugger')
    expect(useConfigSearchFocus.getState()).toMatchObject({ tab: null, id: null })
  })
})
