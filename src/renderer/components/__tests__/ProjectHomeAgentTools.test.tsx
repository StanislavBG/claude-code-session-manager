// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { PhAgentTools } from '../tabs/projecthome/PhAgentTools'
import { useToast } from '../../state/toast'

let container: HTMLDivElement | null = null
let root: Root | null = null

const CATALOG = {
  ok: true,
  tools: [
    {
      name: 'scheduler_create_prd',
      group: 'scheduler' as const,
      purpose: 'Write a new PRD file.',
      whenToUse: 'Use to queue work.',
      whenNotToUse: 'Do not hand-write a PRD when this tool is registered.',
      exampleArgs: { title: 'Example', cwd: '/tmp/project' },
      notes: null,
    },
    {
      name: 'chat_send_prompt',
      group: 'chat' as const,
      purpose: 'Push a prompt into an open tab.',
      whenToUse: 'Use to continue a conversation.',
      whenNotToUse: 'Do not use to start new work.',
      exampleArgs: { tabId: 'abc', prompt: 'hi' },
      notes: null,
    },
  ],
  recipes: [],
}

const READY_CHECKS = [
  { id: 'scheduler-mcp', label: 'Scheduler MCP server registered', ok: true, detail: 'ok', fix: null, fixAction: null },
  { id: 'dev-plugin', label: 'session-manager-dev plugin enabled', ok: true, detail: 'ok', fix: null, fixAction: null },
]

const RED_CHECKS = [
  {
    id: 'scheduler-mcp',
    label: 'Scheduler MCP server registered',
    ok: false,
    detail: 'no entry found',
    fix: 'claude mcp add session-manager-scheduler --scope user -- node scheduler-mcp-server.cjs',
    fixAction: null,
  },
]

function setApi({ catalog, checks }: { catalog: unknown; checks: unknown[] }) {
  ;(globalThis as any).window.api = {
    mcp: { catalog: vi.fn().mockResolvedValue(catalog) },
    app: { delegationReadiness: vi.fn().mockResolvedValue({ ok: checks.every((c: any) => c.ok), checks }) },
    clipboard: { writeText: vi.fn().mockResolvedValue({ ok: true }) },
  }
}

beforeEach(() => {
  useToast.setState({ toasts: [], history: [] } as any)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.restoreAllMocks()
})

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('PhAgentTools', () => {
  it('renders every catalog tool grouped by group', async () => {
    setApi({ catalog: CATALOG, checks: READY_CHECKS })
    const el = mount(<PhAgentTools cwd="/tmp/project" />)
    await flush()
    expect(el.querySelector('[data-testid="agent-tool-scheduler_create_prd"]')).toBeTruthy()
    expect(el.querySelector('[data-testid="agent-tool-chat_send_prompt"]')).toBeTruthy()
    expect(el.textContent).toContain('Scheduler')
    expect(el.textContent).toContain('Chat')
  })

  it('shows an inline error state and a toast when the catalog is empty', async () => {
    setApi({ catalog: { ok: true, tools: [], recipes: [] }, checks: READY_CHECKS })
    const el = mount(<PhAgentTools cwd="/tmp/project" />)
    await flush()
    expect(el.querySelector('[data-testid="agent-tools-error"]')).toBeTruthy()
    expect(useToast.getState().toasts.some((t) => t.kind === 'error')).toBe(true)
  })

  it('shows an inline error state when the catalog IPC rejects', async () => {
    ;(globalThis as any).window.api = {
      mcp: { catalog: vi.fn().mockRejectedValue(new Error('boom')) },
      app: { delegationReadiness: vi.fn().mockResolvedValue({ ok: true, checks: READY_CHECKS }) },
      clipboard: { writeText: vi.fn() },
    }
    const el = mount(<PhAgentTools cwd="/tmp/project" />)
    await flush()
    expect(el.querySelector('[data-testid="agent-tools-error"]')).toBeTruthy()
    expect(useToast.getState().toasts.some((t) => t.kind === 'error')).toBe(true)
  })

  it('surfaces a red readiness check\'s fix string', async () => {
    setApi({ catalog: CATALOG, checks: RED_CHECKS })
    const el = mount(<PhAgentTools cwd="/tmp/project" />)
    await flush()
    const row = el.querySelector('[data-testid="agent-tools-readiness-scheduler-mcp"]')
    expect(row).toBeTruthy()
    expect(row?.textContent).toContain('claude mcp add session-manager-scheduler')
  })
})
