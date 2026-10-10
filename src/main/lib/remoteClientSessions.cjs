'use strict'

/**
 * Per-client E2E session registry for the web-remote agent.
 * Pure — no Electron, no I/O — importable in unit tests.
 *
 * One record per connected client, keyed by the relay's `fromConn`. Envelopes
 * without a usable `fromConn` (relay not yet stamping) key to LEGACY_CLIENT_KEY,
 * which preserves single-client behaviour.
 */

const { makeState } = require('./e2eStateMachine.cjs')

const LEGACY_CLIENT_KEY = 'legacy'
const MAX_KEY_LEN = 64

/**
 * @param {{ fromConn?: unknown } | null | undefined} envelope
 * @returns {string}
 */
function clientKeyOf(envelope) {
  const k = envelope && envelope.fromConn
  if (typeof k === 'string' && k.length > 0 && k.length <= MAX_KEY_LEN) return k
  return LEGACY_CLIENT_KEY
}

function makeRecord(key, clientId) {
  return {
    key,
    clientId: typeof clientId === 'string' ? clientId : null,
    e2e: makeState(),
    peerPubKey: null,
    deviceId: null,
    ptyStreams: new Map(),
    subscriptions: new Set(),
    lastSessionListJson: null,
  }
}

function createClientSessions() {
  const records = new Map()

  function teardown(key) {
    const rec = records.get(key)
    if (!rec) return null
    for (const unsub of rec.ptyStreams.values()) {
      try { if (typeof unsub === 'function') unsub() } catch { /* swallow */ }
    }
    rec.ptyStreams.clear()
    rec.subscriptions.clear()
    records.delete(key)
    return rec
  }

  return {
    clientKeyOf,
    get: (key) => records.get(key) || null,
    getOrCreate(key, { clientId = null } = {}) {
      let rec = records.get(key)
      if (!rec) {
        rec = makeRecord(key, clientId)
        records.set(key, rec)
      } else if (rec.clientId === null && typeof clientId === 'string') {
        rec.clientId = clientId
      }
      return rec
    },
    delete: (key) => records.delete(key),
    keys: () => [...records.keys()],
    values: () => [...records.values()],
    authenticated: () => [...records.values()].filter((r) => r.e2e.state === 'authenticated'),
    teardown,
    teardownAll() {
      let n = 0
      for (const key of [...records.keys()]) {
        if (teardown(key)) n++
      }
      return n
    },
    size: () => records.size,
  }
}

module.exports = { createClientSessions, clientKeyOf, LEGACY_CLIENT_KEY }
