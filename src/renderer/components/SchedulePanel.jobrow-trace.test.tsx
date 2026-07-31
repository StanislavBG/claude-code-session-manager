// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { JobRow } from './SchedulePanel'
import { usePromptSessions } from '../state/promptSessions'
import { takePendingPromptSessionId } from '../lib/promptSessionDeepLink'
import type { ScheduleJob } from '../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  usePromptSessions.setState({ sessions: {} })
  takePendingPromptSessionId()
})

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

function job(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    slug: '807-thing',
    title: 'The thing',
    cwd: '/proj',
    parallelGroup: 807,
    estimateMinutes: null,
    bodyPreview: '',
    status: 'pending',
    runId: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
    ...overrides,
  } as ScheduleJob
}

describe('JobRow prompt-session trace chip', () => {
  it('renders a clickable chip with the goal text when the session resolves, and navigates without expanding the row', () => {
    usePromptSessions.setState({
      sessions: {
        'tab-1': { id: 'tab-1', cwd: '/proj', goalText: 'fix the scheduler display referential integrity' } as any,
      },
    })
    const j = job({ sourceTabId: 'tab-1' })
    const el = mount(
      <JobRow job={j} eta={null} now={Date.now()} avgDurationMs={60_000} listIndex={0} onFocused={vi.fn()} />,
    )

    const chip = el.querySelector('[data-testid="job-row-prompt-session-chip"]') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.getAttribute('role')).toBe('button')
    expect(chip.textContent).toContain('fix the scheduler display')

    const rowButton = el.querySelector('[data-job-row]') as HTMLElement
    expect(rowButton.getAttribute('aria-expanded')).toBe('false')

    act(() => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(rowButton.getAttribute('aria-expanded')).toBe('false')
    expect(takePendingPromptSessionId()).toBe('tab-1')
  })

  it('renders a muted, non-clickable chip with the short id when the source is set but unresolved', () => {
    const j = job({ sourceTabId: 'tab-missing-1234', sourcePromptId: null })
    const el = mount(
      <JobRow job={j} eta={null} now={Date.now()} avgDurationMs={60_000} listIndex={0} onFocused={vi.fn()} />,
    )

    const chip = el.querySelector('[data-testid="job-row-prompt-session-chip"]') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.getAttribute('role')).not.toBe('button')
    expect(chip.textContent).toBe('tab-miss')
  })

  it('renders no chip when neither sourcePromptId nor sourceTabId is set', () => {
    const j = job({ sourceTabId: null, sourcePromptId: null })
    const el = mount(
      <JobRow job={j} eta={null} now={Date.now()} avgDurationMs={60_000} listIndex={0} onFocused={vi.fn()} />,
    )

    expect(el.querySelector('[data-testid="job-row-prompt-session-chip"]')).toBeNull()
  })
})
