/**
 * webRemoteWiring.spec.ts — static check that the webRemote bridge is wired:
 * every channel the preload namespace invokes has an ipcMain.handle in
 * webRemote.cjs, and index.cjs registers/attaches/inits/destroys the module.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8')

const preload = read('src/preload/index.cjs')
const main = read('src/main/index.cjs')
const bridge = read('src/main/webRemote.cjs')

function webRemoteNamespace(src: string): string {
  const start = src.indexOf('  webRemote: {')
  expect(start).toBeGreaterThan(-1)
  const end = src.indexOf('\n  },', start)
  return src.slice(start, end)
}

describe('webRemote wiring', () => {
  it('every channel invoked by the preload namespace has an ipcMain.handle', () => {
    const ns = webRemoteNamespace(preload)
    const invoked = [...ns.matchAll(/invoke\('(webRemote:[^']+)'/g)].map((m) => m[1])
    expect(invoked.length).toBe(10)
    for (const ch of invoked) {
      expect(bridge).toContain(`ipcMain.handle('${ch}'`)
    }
  })

  it('preload exposes the push listeners', () => {
    const ns = webRemoteNamespace(preload)
    for (const fn of ['onStatus', 'onTokenRevoked', 'onRevokedAll']) expect(ns).toContain(`${fn}:`)
  })

  it('index.cjs requires, registers, inits, destroys and attaches the module', () => {
    expect(main).toContain("require('./webRemote.cjs')")
    expect(main).toContain('webRemote.registerRemoteHandlers()')
    expect(main).toContain('webRemote.init()')
    expect(main).toContain('webRemote.destroy()')
    expect(main.match(/webRemote\.attachWindow\(mainWindow\)/g)?.length).toBe(2)
  })
})
