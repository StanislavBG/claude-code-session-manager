'use strict';

/**
 * web-remote-session-transcript.test.cjs — cmd:session:transcript serves the real
 * conversation (exchanges history + live transcript tail), paged by a `before` cursor,
 * and resolves the Main row by the tab's id OR sessionId.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-session-transcript.test.cjs
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

let tmpHome
let origHome
let cwd
let dispatch
let opsPath
let encodeCwd

const T0 = Date.parse('2026-01-01T00:00:00Z')
const iso = (n) => new Date(T0 + n * 60000).toISOString()

async function writeJsonl(file, rows) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

const exchange = (sessionId, n) => ({
  ts: iso(n), sessionId, cwd, prompt: `q${sessionId}-${n}`, result: `a${sessionId}-${n}`, summary: '', model: 'm',
})

const call = (sessionKey, extra = {}) => dispatch({ cwd, sessionKey, ...extra })

beforeAll(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-remote-session-transcript-'))
  origHome = process.env.HOME
  process.env.HOME = tmpHome
  cwd = path.join(tmpHome, 'proj')
  await fsp.mkdir(cwd, { recursive: true })

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

  const storePath = require.resolve('../sessionsStore.cjs')
  require.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: {
      load: async () => ({ tabs: [{ id: 'tab-1', sessionId: 'sess-1', cwd }], activeTabId: 'tab-1' }),
    },
  }

  for (const mod of ['../webRemote.cjs', '../config.cjs', '../logs.cjs', '../exchanges.cjs', '../transcripts.cjs', '../lib/opsOwnership.cjs']) {
    try { delete require.cache[require.resolve(mod)] } catch { /* not yet loaded */ }
  }
  ;({ opsPath } = require('../lib/opsOwnership.cjs'))
  ;({ encodeCwd } = require('../lib/util/encodeCwd.cjs'))
  const webRemote = require('../webRemote.cjs')
  dispatch = webRemote.__test.getDispatchMap()['cmd:session:transcript']

  // Exchanges: 12 for sess-1 (minutes 0..11), 2 for sess-2 (Epic), interleaved noise.
  const rows = []
  for (let i = 0; i < 12; i++) rows.push(exchange('sess-1', i))
  rows.push(exchange('sess-2', 100), exchange('sess-2', 101))
  await writeJsonl(opsPath(cwd, 'prompt-sessions', 'exchanges.jsonl'), rows)

  // Live transcript for sess-1: one old line (already an exchange) + two newer ones.
  const projDir = path.join(tmpHome, '.claude', 'projects', encodeCwd(cwd))
  const line = (type, text, n) => ({ type, uuid: `u${n}`, timestamp: iso(n), message: { content: text } })
  await writeJsonl(path.join(projDir, 'sess-1.jsonl'), [
    line('user', 'old', 5),
    line('user', 'live question', 50),
    line('assistant', 'live answer', 51),
  ])
  await writeJsonl(path.join(projDir, 'sess-2.jsonl'), [line('user', 'epic live', 200)])

  await fsp.mkdir(path.dirname(opsPath(cwd, 'prompt-sessions', 'active-index.json')), { recursive: true })
  await fsp.writeFile(
    opsPath(cwd, 'prompt-sessions', 'active-index.json'),
    JSON.stringify({ sessions: { 'epic-1': { id: 'epic-1', status: 'active', claudeSessionId: 'sess-2', cwd } } }),
  )
})

afterAll(async () => {
  process.env.HOME = origHome
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

describe('cmd:session:transcript', () => {
  it('Main by tab id reads tab.sessionId exchanges (and by sessionId too)', async () => {
    const a = await call('tab-1')
    const b = await call('sess-1')
    expect(a.messages.some((m) => m.text === 'qsess-1-11')).toBe(true)
    expect(a.messages.some((m) => m.text.includes('sess-2'))).toBe(false)
    expect(b.messages).toEqual(a.messages)
  })

  it('Epic via epicId reads the epic claudeSessionId exchanges', async () => {
    const r = await call('epic-1')
    expect(r.messages.map((m) => m.text)).toEqual(['qsess-2-100', 'asess-2-100', 'qsess-2-101', 'asess-2-101', 'epic live'])
    expect(r.hasMore).toBe(false)
    expect(r.nextBefore).toBeNull()
  })

  it('limit + hasMore/nextBefore', async () => {
    const r = await call('tab-1', { limit: 3 })
    expect(r.hasMore).toBe(true)
    expect(r.nextBefore).toBe(3)
    const history = r.messages.filter((m) => !m.live)
    expect(history.map((m) => m.text)).toEqual([
      'qsess-1-9', 'asess-1-9', 'qsess-1-10', 'asess-1-10', 'qsess-1-11', 'asess-1-11',
    ])
  })

  it('before pages older exchanges with no live tail', async () => {
    const r = await call('tab-1', { limit: 3, before: 3 })
    expect(r.messages.some((m) => m.live)).toBe(false)
    expect(r.messages.map((m) => m.text)).toEqual([
      'qsess-1-6', 'asess-1-6', 'qsess-1-7', 'asess-1-7', 'qsess-1-8', 'asess-1-8',
    ])
    expect(r.hasMore).toBe(true)
    expect(r.nextBefore).toBe(6)
  })

  it('live tail lines newer than the newest exchange are appended', async () => {
    const r = await call('tab-1', { limit: 2 })
    const live = r.messages.filter((m) => m.live)
    expect(live.map((m) => m.text)).toEqual(['live question', 'live answer'])
    expect(r.messages.slice(-2).every((m) => m.live)).toBe(true)
  })

  it('unresolvable session returns an empty page', async () => {
    expect(await call('nope')).toEqual({ messages: [], hasMore: false, nextBefore: null })
  })
})
