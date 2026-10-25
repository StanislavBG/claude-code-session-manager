'use strict';

/**
 * web-remote-retire-d2d.test.cjs — retired desktop-to-desktop client: pin pruning + orphan file removal.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-retire-d2d.test.cjs
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

let tmpHome
let origHome
let webRemote

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'web-remote-retire-d2d-'))
  origHome = process.env.HOME
  process.env.HOME = tmpHome
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
  for (const mod of ['../webRemote.cjs', '../config.cjs', '../logs.cjs']) {
    try { delete require.cache[require.resolve(mod)] } catch { /* not loaded */ }
  }
  webRemote = require('../webRemote.cjs')
})

afterAll(() => {
  process.env.HOME = origHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('pruneDesktopPins', () => {
  it('drops pins from desktop clients and strips clientId from the rest', () => {
    const out = webRemote.__test.pruneDesktopPins({
      devices: [{ verifiedPeerPubKeys: [{ pubKey: 'A', clientId: 'desktop-1' }, { pubKey: 'B', clientId: null }] }],
    })
    expect(out.devices[0].verifiedPeerPubKeys).toEqual([{ pubKey: 'B' }])
  })

  it('leaves devices without pins untouched', () => {
    const out = webRemote.__test.pruneDesktopPins({ devices: [{ deviceId: 'x' }] })
    expect(out.devices).toEqual([{ deviceId: 'x' }])
  })
})

describe('removeOrphanedClientFiles', () => {
  it('removes both files, keeps others, never throws on missing dir', () => {
    const dir = fs.mkdtempSync(path.join(tmpHome, 'sm-'))
    for (const n of ['remote-peers.json', 'relay-client.json', 'keep.json']) fs.writeFileSync(path.join(dir, n), '{}')
    webRemote.__test.removeOrphanedClientFiles(dir)
    expect(fs.existsSync(path.join(dir, 'remote-peers.json'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'relay-client.json'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'keep.json'))).toBe(true)
    expect(() => webRemote.__test.removeOrphanedClientFiles(path.join(dir, 'nope'))).not.toThrow()
  })
})
