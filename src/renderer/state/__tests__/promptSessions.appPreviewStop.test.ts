/**
 * promptSessions.appPreviewStop.test.ts — an Epic's dev-server preview is
 * stopped whenever the Epic closes: markCompleted stops it before the
 * merge-to-main step tears down the worktree, deleteEpic stops it after its
 * refusal guards, and both are best effort (absent API or rejected stop never
 * blocks the close).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PromptSession } from '../promptSessions'
import { fakePromptSessionsCreate } from '../../testUtils/fakePromptSessionsCreate'

function installWindowApiMock(order: string[], opts: { appPreview?: 'ok' | 'reject' | 'absent' } = {}) {
  const mode = opts.appPreview ?? 'ok'
  const api: any = {
    pty: { kill: vi.fn(() => { order.push('pty.kill') }) },
    watchers: { killTab: vi.fn().mockResolvedValue(undefined) },
    transcripts: {
      closeTab: vi.fn().mockResolvedValue(undefined),
      pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl'),
      exists: vi.fn().mockResolvedValue(false),
    },
    sessions: {
      load: vi.fn().mockResolvedValue({ tabs: [], activeTabId: null, freshStart: false }),
      save: vi.fn().mockResolvedValue(undefined),
    },
    chat: {
      cancel: vi.fn(async () => { order.push('chat.cancel') }),
      run: vi.fn().mockResolvedValue({ ok: true }),
      onQueued: vi.fn(),
      onRunStarted: vi.fn(),
      onOutput: vi.fn(),
      onToolUse: vi.fn(),
      onComplete: vi.fn(),
      onNeedsInput: vi.fn(),
      onError: vi.fn(),
      onNotice: vi.fn(),
      onExternalSend: vi.fn(),
    },
    config: {
      readText: vi.fn().mockResolvedValue({ exists: true, text: 'transcript body', mtimeMs: 0, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      readJson: vi.fn().mockResolvedValue({ exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: 'not found' }),
      listDir: vi.fn().mockResolvedValue({ ok: true, entries: [], error: null }),
    },
    promptSessionTranscript: {
      append: vi.fn().mockResolvedValue({ ok: true }),
      read: vi.fn().mockResolvedValue({ turns: [] }),
    },
    promptSessions: {
      onEventAppended: vi.fn(),
      loadActiveIndex: vi.fn().mockResolvedValue({ exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: 'not found' }),
      listArchived: vi.fn().mockResolvedValue({ ok: true, ids: [] }),
      readArchived: vi.fn().mockResolvedValue({ exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: 'not found' }),
      readSessionTranscript: vi.fn().mockResolvedValue({ exists: true, text: 'transcript body' }),
      archiveTranscript: vi.fn().mockResolvedValue({ path: '/p/e.jsonl.gz', bytes: 15, gzBytes: 10, sha256: 'abc' }),
      mergeActiveIndex: vi.fn().mockResolvedValue({ sessions: {}, events: {} }),
      writeArchive: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      create: fakePromptSessionsCreate(),
      createWorktree: vi.fn().mockResolvedValue(null),
      mergeToMain: vi.fn(async () => {
        order.push('mergeToMain')
        return { ok: true, status: 'merged', integrated: true }
      }),
    },
    auditLog: {
      append: vi.fn().mockResolvedValue({ ok: true }),
    },
  }
  if (mode !== 'absent') {
    api.appPreview = {
      stop: vi.fn(async () => {
        order.push('appPreview.stop')
        if (mode === 'reject') throw new Error('preview stop failed')
        return { ok: true }
      }),
    }
  }
  vi.stubGlobal('window', { api })
  return api
}

async function activeEpicWithWorktree() {
  const { usePromptSessions } = await import('../promptSessions')
  const store = usePromptSessions.getState()
  const proposed = await store.createPromptSession('/proj', 'Ship the feature')
  const approved = usePromptSessions.getState().approveProposed(proposed.id)!
  const withWorktree: PromptSession = {
    ...approved,
    worktree: { status: 'active', branch: `sm-epic/${approved.id}`, dir: `/tmp/wt/${approved.id}` } as PromptSession['worktree'],
  }
  usePromptSessions.setState({ sessions: { ...usePromptSessions.getState().sessions, [approved.id]: withWorktree } })
  return { usePromptSessions, session: withWorktree }
}

describe('promptSessions — app preview stop on Epic close', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('markCompleted stops the preview after the chat cancel + pty kill and before mergeToMain', async () => {
    const order: string[] = []
    const api = installWindowApiMock(order)
    const { usePromptSessions, session } = await activeEpicWithWorktree()

    await usePromptSessions.getState().markCompleted(session.id)

    expect(api.appPreview.stop).toHaveBeenCalledWith({ epicId: session.id })
    expect(order).toEqual(['chat.cancel', 'pty.kill', 'appPreview.stop', 'mergeToMain'])
    expect(usePromptSessions.getState().sessions[session.id].status).toBe('completed')
  })

  it('markCompleted still completes (and merges) when appPreview is absent', async () => {
    const order: string[] = []
    const api = installWindowApiMock(order, { appPreview: 'absent' })
    const { toast } = await import('../toast')
    const toastErrorSpy = vi.spyOn(toast, 'error')
    const { usePromptSessions, session } = await activeEpicWithWorktree()

    await usePromptSessions.getState().markCompleted(session.id)

    expect(api.promptSessions.mergeToMain).toHaveBeenCalledTimes(1)
    expect(usePromptSessions.getState().sessions[session.id].status).toBe('completed')
    expect(toastErrorSpy).not.toHaveBeenCalled()
  })

  it('markCompleted still completes (and merges) when the preview stop rejects', async () => {
    const order: string[] = []
    const api = installWindowApiMock(order, { appPreview: 'reject' })
    const { toast } = await import('../toast')
    const toastErrorSpy = vi.spyOn(toast, 'error')
    const { usePromptSessions, session } = await activeEpicWithWorktree()

    await usePromptSessions.getState().markCompleted(session.id)

    expect(order).toEqual(['chat.cancel', 'pty.kill', 'appPreview.stop', 'mergeToMain'])
    expect(api.promptSessions.mergeToMain).toHaveBeenCalledTimes(1)
    expect(usePromptSessions.getState().sessions[session.id].status).toBe('completed')
    expect(toastErrorSpy).not.toHaveBeenCalled()
  })

  it('deleteEpic stops the preview and removes the Epic', async () => {
    const order: string[] = []
    const api = installWindowApiMock(order)
    const { usePromptSessions } = await import('../promptSessions')
    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Throwaway')

    await usePromptSessions.getState().deleteEpic(session.id)

    expect(api.appPreview.stop).toHaveBeenCalledWith({ epicId: session.id })
    expect(usePromptSessions.getState().sessions[session.id]).toBeUndefined()
  })

  it('deleteEpic still removes the Epic when appPreview is absent or stop rejects', async () => {
    for (const mode of ['absent', 'reject'] as const) {
      vi.resetModules()
      vi.unstubAllGlobals()
      installWindowApiMock([], { appPreview: mode })
      const { usePromptSessions } = await import('../promptSessions')
      const session = await usePromptSessions.getState().createPromptSession('/proj', 'Throwaway')

      await usePromptSessions.getState().deleteEpic(session.id)

      expect(usePromptSessions.getState().sessions[session.id]).toBeUndefined()
    }
  })
})
