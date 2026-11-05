// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRemoteApi } from '../../web/remoteApi'

const require_ = createRequire(import.meta.url)
const ipc = require_('../../../main/promptSessionsIpc.cjs')
const { createRemoteIpcDispatcher } = require_('../../../main/lib/feedback-remote/remoteIpcDispatch.cjs')
const surface = require_('../../../preload/apiSurface.cjs')

// Web shim -> real apiSurface policy + real remote dispatcher -> real read handlers.
describe('hydrate under the web shim', () => {
  let root: string
  let listeners: Array<(e: any) => void>
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-')))
    const dir = path.join(root, 'session-manager-operations', 'prompt-sessions')
    fs.mkdirSync(dir, { recursive: true })
    const session = { id: 'ep1', cwd: root, status: 'active', title: 't', objective: 'o', createdAt: '2026-01-01T00:00:00Z' }
    fs.writeFileSync(path.join(dir, 'active-index.json'), JSON.stringify({ sessions: { ep1: session }, events: { ep1: [] } }))
    listeners = []
    const roots = { projectRoots: () => [root] }
    const handlers = new Map<string, any>([
      ['promptSessions:load-active-index', (_e: unknown, { cwd }: any) => ipc.loadActiveIndex(cwd, roots)],
      ['promptSessions:list-archived', (_e: unknown, { cwd }: any) => ipc.listArchived(cwd, roots)],
      ['promptSessions:read-archived', (_e: unknown, { cwd, epicId }: any) => ipc.readArchived(cwd, epicId, roots)],
    ])
    const dispatcher = createRemoteIpcDispatcher({
      surface,
      handlers,
      getConfig: async () => ({ remoteEnabled: true, remoteControlEnabled: false }),
      fenceCtx: { homeDir: '/nonexistent-home', realpath: (p: string) => p, projectRoots: () => [root] },
    })
    const client = { key: 'c', e2e: { state: 'authenticated' } }
    let handler: (e: MessageEvent) => void = () => {}
    const parent = {
      postMessage: async (m: any) => {
        if (m.type !== 'sm-ipc') return
        const r = await dispatcher.invoke(client, m.channel, m.args)
        handler({ data: r.ok ? { type: 'sm-ipc-result', id: m.id, result: r.result } : { type: 'sm-ipc-result', id: m.id, error: r.reason + (r.message ? `: ${r.message}` : '') } } as MessageEvent)
      },
    }
    const api: any = createRemoteApi({ parent, events: { addEventListener: (_t: string, fn: any) => { handler = fn } } })
    api.promptSessions.onEventAppended = (fn: any) => { listeners.push(fn); return () => {} }
    vi.stubGlobal('window', { api })
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('fills the store from promptSessions:load-active-index and refuses a non-project cwd', async () => {
    const { usePromptSessions } = await import('../promptSessions')
    await usePromptSessions.getState().hydrate(root)
    expect(Object.keys(usePromptSessions.getState().sessions)).toEqual(['ep1'])

    const api = (globalThis as any).window.api
    await expect(api.promptSessions.loadActiveIndex({ cwd: os.tmpdir() })).rejects.toThrow(/path_fenced/)
    await usePromptSessions.getState().hydrate(os.tmpdir())
    expect(Object.keys(usePromptSessions.getState().sessions)).toEqual(['ep1'])
  })

  it('a refresh after the index changes picks the new Epic up', async () => {
    const { usePromptSessions } = await import('../promptSessions')
    await usePromptSessions.getState().hydrate(root)
    const f = path.join(root, 'session-manager-operations', 'prompt-sessions', 'active-index.json')
    const idx = JSON.parse(fs.readFileSync(f, 'utf8'))
    idx.sessions.ep2 = { ...idx.sessions.ep1, id: 'ep2' }
    idx.events.ep2 = []
    fs.writeFileSync(f, JSON.stringify(idx))
    await usePromptSessions.getState().hydrate(root)
    expect(Object.keys(usePromptSessions.getState().sessions).sort()).toEqual(['ep1', 'ep2'])
  })
})
