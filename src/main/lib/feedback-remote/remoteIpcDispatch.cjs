'use strict'

/**
 * remoteIpcDispatch.cjs — run a remote call through the SAME ipcMain handler the
 * renderer uses (no re-implementation), gated by the apiSurface remote policy and
 * the web-remote tiers; plus a chunker keeping relay frames under the 256 KB cap.
 *
 * Pure — no Electron import. Lives in feedback-remote/ beside the other web-remote
 * conduit modules (remoteClientSessions.cjs); no other lib domain fits.
 * Gate order mirrors webRemote.dispatchEnvelope: kill switch → surface/allowlist →
 * MUTATE tier → E2E auth.
 */

const MAX_VALUE_BYTES = 50 * 1024 * 1024
const DEFAULT_FRAME_BYTES = 180000

/**
 * Wrap ipcMain.handle so every registration is also stored channel -> handler.
 * Original behavior is unchanged.
 * @param {{ handle: (channel: string, fn: Function) => any }} ipcMain
 * @returns {Map<string, Function>}
 */
function captureIpcHandlers(ipcMain) {
  const handlers = new Map()
  const original = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, fn) => {
    handlers.set(channel, fn)
    return original(channel, fn)
  }
  return handlers
}


const { isContainedIn } = require('../insideHome.cjs')

/**
 * Path-taking remote-readable channels. mode 'root': realpath must sit inside a
 * registered project root. mode 'secret': only the secret refusal applies (the
 * handler enforces its own root, e.g. the transcripts dir). `field` is the key
 * of the payload object (args[0]) that carries the filesystem path.
 */
const PATH_FENCED_CHANNELS = Object.freeze({
  'files:read': { field: 'path', mode: 'root' },
  'files:list': { field: 'path', mode: 'root', allowHomeListing: true },
  'transcript:readRef': { field: 'filePath', mode: 'secret' },
  'transcript:path': { field: 'cwd', mode: 'secret' },
  'memory:read': { field: 'cwd', mode: 'secret' },
})

const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker'])
const SECRET_BASENAMES = new Set(['.credentials.json', '.netrc', '.npmrc', '.env'])
const SECRET_BASENAME_RES = [/^\.env\..*/, /\.pem$/, /^id_rsa/, /^id_ed25519/, /^id_ecdsa/]

/** True when the path has a secret segment or basename. */
function isSecretPath(p, platform) {
  const norm = platform === 'win32' ? String(p).toLowerCase() : String(p)
  const segs = norm.split(/[\\/]+/).filter(Boolean)
  for (let i = 0; i < segs.length; i++) {
    if (SECRET_DIRS.has(segs[i])) return true
    if (segs[i] === '.config' && segs[i + 1] === 'gcloud') return true
  }
  const base = segs[segs.length - 1] || ''
  return SECRET_BASENAMES.has(base) || SECRET_BASENAME_RES.some((re) => re.test(base))
}

/**
 * Remote-only argument fence. Returns { ok: true } or { ok: false, reason: 'path_fenced' }.
 * @param {string} channel
 * @param {any[]} args
 * @param {{ homeDir: string, projectRoots: () => string[], realpath: (p:string)=>string, platform?: string }} ctx
 */
function remoteArgFence(channel, args, ctx) {
  const spec = Object.prototype.hasOwnProperty.call(PATH_FENCED_CHANNELS, channel) ? PATH_FENCED_CHANNELS[channel] : null
  if (!spec) return { ok: true }
  const refuse = { ok: false, reason: 'path_fenced' }
  const platform = (ctx && ctx.platform) || process.platform
  try {
    const a0 = Array.isArray(args) ? args[0] : undefined
    const raw = a0 && typeof a0 === 'object' ? a0[spec.field] : a0
    if (typeof raw !== 'string' || !raw) return refuse
    const real = ctx.realpath(raw)
    if (isSecretPath(raw, platform) || isSecretPath(real, platform)) return refuse
    if (spec.mode === 'secret') return { ok: true }
    const home = ctx.realpath(ctx.homeDir)
    if (spec.allowHomeListing && isContainedIn(real, home, platform) && isContainedIn(home, real, platform)) {
      return { ok: true }
    }
    for (const root of ctx.projectRoots() || []) {
      if (typeof root !== 'string' || !root) continue
      let realRoot
      try { realRoot = ctx.realpath(root) } catch { realRoot = root }
      if (isContainedIn(real, realRoot, platform)) return { ok: true }
    }
    return refuse
  } catch {
    return refuse
  }
}

const STRICTNESS = { read: 0, mutate: 1, deny: 2 }

/** Strictest remote policy among the invokable (invoke|send) rows for a channel, or null. */
function policyFor(surface, channel) {
  let policy = null
  for (const row of surface) {
    if (row.channel !== channel) continue
    if (row.kind !== 'invoke' && row.kind !== 'send') continue
    const p = STRICTNESS[row.remote] === undefined ? 'deny' : row.remote
    if (policy === null || STRICTNESS[p] > STRICTNESS[policy]) policy = p
  }
  return policy
}

/**
 * @param {{ surface: ReadonlyArray<{channel:string,kind:string,remote:string}>,
 *           handlers: Map<string, Function> | Record<string, Function>,
 *           getConfig: () => ({remoteEnabled?:boolean, remoteControlEnabled?:boolean} | Promise<any>),
 *           fenceCtx?: Parameters<typeof remoteArgFence>[2] }} deps
 */
function createRemoteIpcDispatcher({ surface, handlers, getConfig, fenceCtx }) {
  const lookup = (channel) =>
    handlers instanceof Map ? handlers.get(channel) : handlers && Object.prototype.hasOwnProperty.call(handlers, channel) ? handlers[channel] : undefined

  async function invoke(client, channel, args) {
    const cfg = (await getConfig()) || {}
    if (!cfg.remoteEnabled) return { ok: false, reason: 'disabled' }

    const policy = typeof channel === 'string' ? policyFor(surface, channel) : null
    if (policy === null) return { ok: false, reason: 'not_in_surface' }
    if (policy === 'deny') return { ok: false, reason: 'denied' }

    if (!client || !client.e2e || client.e2e.state !== 'authenticated') {
      return { ok: false, reason: 'e2e_not_authenticated' }
    }
    if (policy === 'mutate' && !(cfg.remoteEnabled === true && cfg.remoteControlEnabled === true)) {
      return { ok: false, reason: 'mutate_not_allowed' }
    }

    const handler = lookup(channel)
    if (typeof handler !== 'function') return { ok: false, reason: 'no_handler' }

    // Remote-only fence: fail closed when path-taking channels have no ctx.
    const fence = fenceCtx || !Object.prototype.hasOwnProperty.call(PATH_FENCED_CHANNELS, channel)
      ? remoteArgFence(channel, args, fenceCtx)
      : { ok: false, reason: 'path_fenced' }
    if (!fence.ok) return { ok: false, reason: 'path_fenced' }

    try {
      const event = { sender: null, remoteClientId: client.key }
      const result = await handler(event, ...(Array.isArray(args) ? args : []))
      return { ok: true, result }
    } catch (e) {
      return { ok: false, reason: 'handler_error', message: e && e.message ? String(e.message) : String(e) }
    }
  }

  return { invoke }
}

/**
 * Serialize once and split into ordered frames, each strictly under maxBytes (UTF-8).
 * @returns {{ ok: true, frames: Array<{seq:number,total:number,data:string}> } | { ok: false, reason: string }}
 */
function chunkFrames(value, maxBytes = DEFAULT_FRAME_BYTES) {
  const json = JSON.stringify(value === undefined ? null : value)
  const buf = Buffer.from(json, 'utf8')
  if (buf.length > MAX_VALUE_BYTES) return { ok: false, reason: 'too_large' }
  const limit = Math.max(4, maxBytes - 1)
  const slices = []
  let start = 0
  while (start < buf.length) {
    let end = Math.min(start + limit, buf.length)
    if (end < buf.length) {
      while (end > start && (buf[end] & 0xc0) === 0x80) end--
    }
    slices.push(buf.subarray(start, end).toString('utf8'))
    start = end
  }
  if (slices.length === 0) slices.push('')
  const total = slices.length
  return { ok: true, frames: slices.map((data, seq) => ({ seq, total, data })) }
}

/** Reverse chunkFrames. Throws on missing/duplicate frames. */
function joinFrames(frames) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('no frames')
  const sorted = [...frames].sort((a, b) => a.seq - b.seq)
  const total = sorted[0].total
  if (sorted.length !== total) throw new Error('incomplete frames')
  sorted.forEach((f, i) => {
    if (f.seq !== i || f.total !== total) throw new Error('bad frame sequence')
  })
  return JSON.parse(sorted.map((f) => f.data).join(''))
}

module.exports = { remoteArgFence, PATH_FENCED_CHANNELS, captureIpcHandlers, createRemoteIpcDispatcher, chunkFrames, joinFrames, MAX_VALUE_BYTES }
