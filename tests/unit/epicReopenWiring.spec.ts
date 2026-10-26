/**
 * epicReopenWiring.spec.ts — static check that promptSessions:reopen is wired
 * main → preload → api.d.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8')

describe('epic reopen wiring', () => {
  it('index.cjs registers the handlers exactly once', () => {
    const main = read('src/main/index.cjs')
    const call = "require('./lib/epic/epicReopen.cjs').registerEpicReopenHandlers()"
    expect(main.split(call).length - 1).toBe(1)
  })

  it('preload promptSessions namespace invokes promptSessions:reopen', () => {
    const src = read('src/preload/index.cjs')
    const start = src.indexOf('  promptSessions: {')
    expect(start).toBeGreaterThan(-1)
    const ns = src.slice(start, src.indexOf('\n  },', start))
    expect(ns).toContain("reopen: (payload) => ipcRenderer.invoke('promptSessions:reopen', payload)")
  })

  it('epicReopen.cjs handles that channel', () => {
    expect(read('src/main/lib/epic/epicReopen.cjs')).toContain("ipcMain.handle(\n    'promptSessions:reopen'")
  })

  it('api.d.ts types it', () => {
    const d = read('src/preload/api.d.ts')
    expect(d).toContain('reopen: (payload: PromptSessionsReopenPayload) => Promise<PromptSessionsReopenResult>')
    expect(d).toContain('PromptSessionsReopenResult')
  })
})
