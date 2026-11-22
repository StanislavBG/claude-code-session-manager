// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TaskDetail } from '../TaskDetail'
import { useToast } from '../../../../state/toast'
import type { TaskDetail as TaskDetailRecord } from '../../../../../preload/api'

const full: TaskDetailRecord = {
  taskId: 't1', status: 'ok', source: 'sm', agent: 'writer', model: 'sonnet', effort: 'high',
  missionId: 'm-42', exitCode: 0, durationMs: 65_000, costUsd: 0.5, slotWaitMs: 3_000,
  quota: { rateLimited: false, resetsAt: null },
  caller: { pipeline: 'burrow', runId: 'r1', step: 'draft', attempt: 2 },
  promptSha256: 'a'.repeat(64), promptBytes: 11, outputSha256: 'b'.repeat(64), outputBytes: 12,
  body: { taskId: 't1', prompt: 'PROMPT TEXT', output: 'OUTPUT TEXT', promptTruncated: false, outputTruncated: false },
}

const api = {
  tasks: { list: vi.fn(), get: vi.fn(), getSwitch: vi.fn(), setSwitch: vi.fn() },
  clipboard: { writeText: vi.fn() },
}

let host: HTMLDivElement
let root: Root
let onClose: ReturnType<typeof vi.fn<() => void>>

async function render(taskId = 't1') {
  await act(async () => {
    root.render(createElement(TaskDetail, { cwd: '/p', taskId, onClose }))
  })
  await act(async () => { await Promise.resolve() })
}

const q = (sel: string) => host.querySelector(sel)
const errors = () => useToast.getState().history.filter((t) => t.kind === 'error')

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = api
  api.tasks.get.mockReset().mockResolvedValue({ ok: true, task: full })
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
  onClose = vi.fn<() => void>()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('TaskDetail', () => {
  it('loads the Task by cwd + id and shows its facts, prompt, output and hashes', async () => {
    await render()
    expect(api.tasks.get).toHaveBeenCalledWith({ cwd: '/p', id: 't1' })
    const text = q('[data-testid="task-detail"]')!.textContent!
    for (const s of ['writer', 'sonnet', 'high', 'm-42', 'burrow', 'r1', 'draft', '$0.50', '1m 05s', '3.0s']) {
      expect(text).toContain(s)
    }
    expect(q('[data-testid="task-detail-fact-attempt"]')!.textContent).toBe('2')
    expect(q('[data-testid="task-detail-fact-exit-code"]')!.textContent).toBe('0')
    expect(q('[data-testid="task-detail-fact-status"]')!.textContent).toBe('ok')
    expect(q('[data-testid="task-detail-fact-quota"]')!.textContent).toBe('ok')
    const prompt = q('[data-testid="task-detail-prompt"]')!
    expect(prompt.querySelector('pre')!.textContent).toBe('PROMPT TEXT')
    expect(prompt.textContent).toContain('a'.repeat(64))
    expect(q('[data-testid="task-detail-output"]')!.querySelector('pre')!.textContent).toBe('OUTPUT TEXT')
    expect(q('[data-testid="task-detail-output"]')!.textContent).toContain('b'.repeat(64))
    expect(q('[data-testid="task-detail-prompt-truncated"]')).toBeNull()
    expect(q('[data-testid="task-detail-badge-direct"]')).toBeNull()
  })

  it('marks truncated prompt / output and badges direct Tasks', async () => {
    api.tasks.get.mockResolvedValue({ ok: true, task: {
      ...full, source: 'direct', quota: { rateLimited: true, resetsAt: null },
      body: { ...full.body!, promptTruncated: true, outputTruncated: true },
    } })
    await render()
    expect(q('[data-testid="task-detail-prompt-truncated"]')!.textContent).toBe('truncated')
    expect(q('[data-testid="task-detail-output-truncated"]')!.textContent).toBe('truncated')
    expect(q('[data-testid="task-detail-badge-direct"]')!.textContent).toBe('ran without SM')
    expect(q('[data-testid="task-detail-fact-quota"]')!.textContent).toBe('rate limited')
  })

  it('copies via the clipboard IPC and toasts an error when it fails', async () => {
    const writeText = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false })
    api.clipboard = { writeText }
    await render()
    await act(async () => { (q('[data-testid="task-detail-prompt-copy"]') as HTMLButtonElement).click() })
    expect(writeText).toHaveBeenCalledWith('PROMPT TEXT')
    expect(errors()).toHaveLength(0)
    expect(useToast.getState().history.some((t) => t.kind === 'info' && t.message === 'Prompt copied')).toBe(true)
    await act(async () => { (q('[data-testid="task-detail-output-copy"]') as HTMLButtonElement).click() })
    expect(writeText).toHaveBeenLastCalledWith('OUTPUT TEXT')
    expect(errors().some((t) => t.message === 'Copy output failed')).toBe(true)
  })

  it('toasts a load failure', async () => {
    api.tasks.get.mockResolvedValue({ ok: false, error: 'nope' })
    await render()
    expect(errors().some((t) => t.message.includes('nope'))).toBe(true)
  })

  it('closes on the close button and on Escape', async () => {
    await render()
    act(() => { (q('[data-testid="task-detail-close"]') as HTMLButtonElement).click() })
    expect(onClose).toHaveBeenCalledTimes(1)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(onClose).toHaveBeenCalledTimes(2)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })) })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
