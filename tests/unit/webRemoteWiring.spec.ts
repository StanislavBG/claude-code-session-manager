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
    // Exact set, by name: a new preload channel must be added here AND get a handler.
    expect([...invoked].sort()).toEqual(
      [
        'webRemote:audit-tail',
        'webRemote:confirm-sas',
        'webRemote:disable',
        'webRemote:disable-control',
        'webRemote:enable',
        'webRemote:enable-control',
        'webRemote:get-status',
        'webRemote:pair',
        'webRemote:relay-client-revoke',
        'webRemote:revoke-all',
        'webRemote:revoke-device',
        'webRemote:service-confirm-sas',
        'webRemote:service-pair-cancel',
        'webRemote:service-pair-start',
        'webRemote:service-revoke',
        'webRemote:service-set-start-work',
        'webRemote:services-list',
      ].sort(),
    )
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
