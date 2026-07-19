'use strict';

/**
 * web-remote-e2e-pinning.test.cjs — TOFU pinning for the web-remote E2E handshake.
 *
 * Once a browser's SPKI pubkey is manually SAS-confirmed for a paired device,
 * a later `e2e:hello` presenting the SAME pubkey for that device should
 * auto-authenticate (no `confirm-sas` needed); a DIFFERENT pubkey must still
 * fall through to the manual `pending_sas` flow.
 *
 * Runs against a tmp HOME (config.cjs / webRemote.cjs both resolve paths off
 * os.homedir()) and stubs the `electron` module in require.cache, mirroring
 * the tmp-HOME + require.cache-stub pattern used by exchanges.test.cjs.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/web-remote-e2e-pinning.test.cjs
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

/** Generate a P-256 keypair in the same encoding webRemote.cjs uses (SPKI/PKCS8, base64url). */
function genP256KeyPairB64() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  return {
    priv: privateKey.toString('base64url'),
    pub: publicKey.toString('base64url'),
  }
}

let tmpHome
let origHome
let webRemote
let configPath
let handlers // captured ipcMain.handle(name, fn) map

function freshRequire(mod) {
  delete require.cache[require.resolve(mod)]
  return require(mod)
}

async function readConfig() {
  const text = await fsp.readFile(configPath, 'utf8')
  return JSON.parse(text)
}

async function writeConfig(cfg) {
  await fsp.mkdir(path.dirname(configPath), { recursive: true })
  await fsp.writeFile(configPath, JSON.stringify(cfg, null, 2) + '\n')
}

beforeAll(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-remote-e2e-pinning-'))
  origHome = process.env.HOME
  process.env.HOME = tmpHome

  // Stub 'electron' before webRemote.cjs (and logs.cjs, transitively) require it —
  // outside a real Electron process, require('electron') just resolves to a path
  // string, so destructuring { ipcMain, app } off it would throw at module load.
  handlers = new Map()
  const electronPath = require.resolve('electron')
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      ipcMain: {
        handle: (name, fn) => handlers.set(name, fn),
        on: () => {},
      },
      app: {
        getPath: () => tmpHome,
        getVersion: () => '0.0.0-test',
      },
    },
  }

  // Clear anything already cached under the real HOME so paths re-resolve under tmpHome.
  for (const mod of ['../webRemote.cjs', '../config.cjs', '../logs.cjs', './e2eStateMachine.cjs']) {
    try { delete require.cache[require.resolve(mod)] } catch { /* not yet loaded */ }
  }

  webRemote = freshRequire('../webRemote.cjs')
  configPath = path.join(tmpHome, '.claude', 'session-manager', 'web-remote.json')

  webRemote.registerRemoteHandlers()
})

afterAll(async () => {
  process.env.HOME = origHome
  await fsp.rm(tmpHome, { recursive: true, force: true })
})

describe('web-remote E2E SAS pinning', () => {
  const deviceKeys = genP256KeyPairB64() // desktop's own E2E keypair
  const browserA = genP256KeyPairB64() // first browser's keypair
  const browserB = genP256KeyPairB64() // a different browser's keypair
  const deviceId = 'device-under-test'

  function baseDeviceRow(overrides = {}) {
    return {
      deviceId,
      deviceToken: 'tok-abc',
      e2ePrivateKey: deviceKeys.priv,
      e2ePublicKey: deviceKeys.pub,
      deviceName: 'Test Device',
      issuedAt: new Date(0).toISOString(),
      lastConnectedAt: null,
      verifiedPeerPubKey: null,
      ...overrides,
    }
  }

  it('1) first e2e:hello for a never-confirmed device lands in pending_sas', async () => {
    await writeConfig({ remoteEnabled: true, remoteControlEnabled: false, devices: [baseDeviceRow()] })

    const cfg = await readConfig()
    const device = cfg.devices[0]
    await webRemote._internal.handleMessage(
      JSON.stringify({ type: 'e2e:hello', id: 'm1', payload: { pubKey: browserA.pub } }),
      device
    )

    expect(webRemote._internal.getE2eState().state).toBe('pending_sas')
  })

  it('2) a manual confirm-sas persists the connected device\'s verifiedPeerPubKey', async () => {
    const confirmSas = handlers.get('webRemote:confirm-sas')
    expect(typeof confirmSas).toBe('function')

    const result = await confirmSas()
    expect(result.ok).toBe(true)
    expect(webRemote._internal.getE2eState().state).toBe('authenticated')

    const cfg = await readConfig()
    const persisted = cfg.devices.find((d) => d.deviceId === deviceId)
    expect(persisted.verifiedPeerPubKey).toBe(browserA.pub)
  })

  it('3) a second e2e:hello presenting the SAME browserPubKey auto-authenticates (no confirm-sas)', async () => {
    // Simulate a fresh reconnect: new WS session resets E2E state, and the device
    // row is reloaded from disk (as connect() would), now carrying the pinned key.
    webRemote._internal.resetE2e()
    expect(webRemote._internal.getE2eState().state).toBe('idle')

    const cfg = await readConfig()
    const device = cfg.devices.find((d) => d.deviceId === deviceId)
    expect(device.verifiedPeerPubKey).toBe(browserA.pub)

    await webRemote._internal.handleMessage(
      JSON.stringify({ type: 'e2e:hello', id: 'm2', payload: { pubKey: browserA.pub } }),
      device
    )

    expect(webRemote._internal.getE2eState().state).toBe('authenticated')
  })

  it('4) a e2e:hello presenting a DIFFERENT browserPubKey still lands in pending_sas', async () => {
    webRemote._internal.resetE2e()
    expect(webRemote._internal.getE2eState().state).toBe('idle')

    const cfg = await readConfig()
    const device = cfg.devices.find((d) => d.deviceId === deviceId)
    expect(device.verifiedPeerPubKey).toBe(browserA.pub) // still pinned to A, not B

    await webRemote._internal.handleMessage(
      JSON.stringify({ type: 'e2e:hello', id: 'm3', payload: { pubKey: browserB.pub } }),
      device
    )

    expect(webRemote._internal.getE2eState().state).toBe('pending_sas')
  })
})
