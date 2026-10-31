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

const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.password-store', '.azure', '.terraform.d'])
const SECRET_BASENAMES = new Set(['.credentials.json', '.netrc', '.npmrc', '.env', '.claude.json', '.git-credentials', '.pypirc'])
const SECRET_BASENAME_RES = [/^\.env\..*/, /\.pem$/, /^id_rsa/, /^id_ed25519/, /^id_ecdsa/]
/** Multi-segment secrets: match as consecutive path segments at any depth. */
const SECRET_SEQUENCES = [
  ['.config', 'gcloud'],
  ['.claude', 'session-manager'],
  ['.config', 'gh'],
  ['.config', 'git', 'credentials'],
  ['.cargo', 'credentials'],
  ['.cargo', 'credentials.toml'],
  ['.local', 'share', 'keyrings'],
  ['Library', 'Keychains'],
  ['AppData', 'Roaming', 'Microsoft', 'Credentials'],
  ['AppData', 'Local', 'Microsoft', 'Credentials'],
]

/** True when the path has a secret segment, segment sequence or basename. */
function isSecretPath(p, platform) {
  const win = platform === 'win32'
  const norm = win ? String(p).toLowerCase() : String(p)
  const segs = norm.split(/[\\/]+/).map((x) => (win ? x.replace(/[. ]+$/, '') : x)).filter(Boolean)
  const seqs = win ? SECRET_SEQUENCES.map((q) => q.map((x) => x.toLowerCase())) : SECRET_SEQUENCES
  for (let i = 0; i < segs.length; i++) {
    if (SECRET_DIRS.has(segs[i])) return true
    for (const q of seqs) {
      if (q.every((part, k) => segs[i + k] === part)) return true
    }
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
      // A root equal to home or an ancestor of it (incl. `/` or a drive root)
      // would expose every non-secret file under home — never honour it.
      if (isContainedIn(home, realRoot, platform)) continue
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
  // Budget is the JSON-escaped size of each slice (quotes/backslashes double,
  // control bytes become \\n or \\u00XX) because the frame is re-stringified
  // and then base64url-encoded inside an e2e:box.
  const limit = Math.max(12, maxBytes - 1)
  const slices = []
  let start = 0
  while (start < buf.length) {
    let end = start
    let cost = 0
    while (end < buf.length) {
      const b = buf[end]
      const c = b === 0x22 || b === 0x5c ? 2 : b < 0x20 ? (b === 0x0a || b === 0x0d || b === 0x09 || b === 0x08 || b === 0x0c ? 2 : 6) : 1
      if (cost + c > limit) break
      cost += c
      end++
    }
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
