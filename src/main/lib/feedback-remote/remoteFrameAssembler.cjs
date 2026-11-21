'use strict'

// Inbound twin of remoteIpcDispatch.cjs's chunkFrames: rebuilds a browser→desktop
// message that arrived as several E2E-boxed `e2e:frame` envelopes (the bilko.run
// relay drops any socket message over 256 KB, so large uploads are split into
// ≤180 KB frames). Pure, per-client state with hard memory bounds — a buggy or
// hostile browser cannot exhaust desktop memory: bounded frames per message,
// bounded bytes per message, bounded concurrent messages per client, idle TTL.

const { joinFrames } = require('./remoteIpcDispatch.cjs')

const FRAME_LIMITS = Object.freeze({
  maxMessageBytes: 25 * 1024 * 1024,
  maxInflightPerClient: 2,
  maxFrames: 200,
  idleTtlMs: 60000,
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function createFrameAssembler({
  maxMessageBytes = FRAME_LIMITS.maxMessageBytes,
  maxInflightPerClient = FRAME_LIMITS.maxInflightPerClient,
  maxFrames = FRAME_LIMITS.maxFrames,
  idleTtlMs = FRAME_LIMITS.idleTtlMs,
  now = Date.now,
} = {}) {
  /** @type {Map<string, Map<string, { total: number, frames: Map<number, string>, bytes: number, lastAt: number }>>} */
  const clients = new Map()

  function free(clientKey, msgId) {
    const msgs = clients.get(clientKey)
    if (!msgs) return
    msgs.delete(msgId)
    if (msgs.size === 0) clients.delete(clientKey)
  }

  function refuse(clientKey, msgId, reason) {
    if (msgId !== undefined) free(clientKey, msgId)
    return { status: 'refused', reason }
  }

  function sweep() {
    const t = now()
    for (const [clientKey, msgs] of clients) {
      for (const [msgId, entry] of msgs) {
        if (t - entry.lastAt > idleTtlMs) msgs.delete(msgId)
      }
      if (msgs.size === 0) clients.delete(clientKey)
    }
  }

  function dropClient(clientKey) {
    clients.delete(clientKey)
  }

  function accept(clientKey, payload) {
    sweep()
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return refuse(clientKey, undefined, 'malformed')
    const { msgId, seq, total, data } = payload
    if (
      typeof msgId !== 'string' || !UUID_RE.test(msgId) ||
      !Number.isInteger(total) || total < 1 || total > maxFrames ||
      !Number.isInteger(seq) || seq < 0 || seq >= total ||
      typeof data !== 'string'
    ) {
      return refuse(clientKey, undefined, 'malformed')
    }

    let msgs = clients.get(clientKey)
    let entry = msgs && msgs.get(msgId)
    if (!entry) {
      if (msgs && msgs.size >= maxInflightPerClient) return refuse(clientKey, undefined, 'too_many_inflight')
      if (data.length > maxMessageBytes) return refuse(clientKey, undefined, 'too_large')
      entry = { total, frames: new Map(), bytes: 0, lastAt: now() }
      if (!msgs) {
        msgs = new Map()
        clients.set(clientKey, msgs)
      }
      msgs.set(msgId, entry)
    } else {
      if (entry.total !== total) return refuse(clientKey, msgId, 'total_mismatch')
      if (entry.frames.has(seq)) return refuse(clientKey, msgId, 'duplicate_seq')
      if (entry.bytes + data.length > maxMessageBytes) return refuse(clientKey, msgId, 'too_large')
    }

    entry.frames.set(seq, data)
    entry.bytes += data.length
    entry.lastAt = now()
    if (entry.frames.size < entry.total) return { status: 'partial' }

    free(clientKey, msgId)
    const ordered = []
    for (let i = 0; i < entry.total; i++) ordered.push({ seq: i, total: entry.total, data: entry.frames.get(i) })
    let envelope
    try {
      envelope = joinFrames(ordered)
    } catch {
      return { status: 'refused', reason: 'bad_json' }
    }
    if (
      !envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      typeof envelope.type !== 'string' || envelope.type.startsWith('e2e:')
    ) {
      return { status: 'refused', reason: 'bad_inner' }
    }
    return { status: 'complete', envelope }
  }

  return { accept, dropClient, sweep }
}

module.exports = { createFrameAssembler, FRAME_LIMITS }
