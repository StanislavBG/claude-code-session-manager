'use strict';

/**
 * web-remote-project-video.test.cjs — the phone remote neither lists nor starts a
 * 'project-video' macro (a desktop-only Project Home ▸ Video background job).
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-project-video.test.cjs
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

let cwd
let dispatch
const requestNew = vi.fn()

const MACROS = () => [
  { id: 'sess-macro', label: 'S', surface: 'sessions', projects: ['*'], inputs: [] },
  { id: 'home-macro', label: 'H', surface: 'project-home', projects: ['*'], inputs: [] },
  { id: 'builtin-macro', label: 'B', surface: 'sessions', builtin: true, projects: ['*'], inputs: [] },
  { id: 'video-macro', label: 'V', surface: 'project-video', projects: [cwd], inputs: [], job: { kind: 'x' } },
]

beforeAll(() => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'web-remote-project-video-'))
  process.env.HOME = tmpHome
  cwd = path.join(tmpHome, 'proj')
  fs.mkdirSync(cwd, { recursive: true })

  const stub = (rel, exports) => {
    const p = require.resolve(rel)
    require.cache[p] = { id: p, filename: p, loaded: true, exports }
  }
  const electronPath = require.resolve('electron')
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      ipcMain: { handle: () => {}, on: () => {} },
      app: { getPath: () => tmpHome, getVersion: () => '0.0.0-test' },
    },
  }
  stub('../sessionsStore.cjs', { load: async () => ({ tabs: [{ id: 'tab-1', sessionId: 'sess-1', cwd, label: 'proj' }] }) })
  stub('../chatRunner.cjs', { requestExternalNewSession: (...a) => requestNew(...a) })
  stub('../agentLibrary.cjs', { listPersonas: async () => [{ name: 'dev-lead', description: 'd' }] })
  const realMacroLibrary = require('../lib/persona-macro/macroLibrary.cjs')
  stub('../lib/persona-macro/macroLibrary.cjs', { ...realMacroLibrary, listMacros: async () => MACROS() })

  for (const mod of ['../webRemote.cjs', '../config.cjs', '../logs.cjs']) {
    try { delete require.cache[require.resolve(mod)] } catch { /* not yet loaded */ }
  }
  dispatch = require('../webRemote.cjs').__test.getDispatchMap()
})

beforeEach(() => requestNew.mockReset())

const create = (macroId) => dispatch['cmd:session:create']({
  cwd, agentName: 'dev-lead', tag: 'feature', title: 't', prompt: 'go', macroId,
})

describe('remote bootstrap macros', () => {
  it('lists every macro except project-video ones', async () => {
    const { macros } = await dispatch['cmd:session:options']()
    expect(macros.map((m) => m.id)).toEqual(['sess-macro', 'home-macro', 'builtin-macro'])
  })
})

describe('remote cmd:session:create', () => {
  it('refuses a project-video macro with "unknown macro" and mints nothing', async () => {
    await expect(create('video-macro')).rejects.toThrow('unknown macro')
    expect(requestNew).not.toHaveBeenCalled()
  })

  it.each(['sess-macro', 'home-macro', 'builtin-macro'])('starts %s as before', async (id) => {
    expect(await create(id)).toEqual({ ok: true })
    expect(requestNew).toHaveBeenCalledWith(expect.objectContaining({ cwd, macroId: id, prompt: 'go' }))
  })

  it('still refuses an id that does not exist', async () => {
    await expect(create('nope-macro')).rejects.toThrow('unknown macro')
  })
})
