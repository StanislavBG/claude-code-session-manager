import rows from '../../preload/apiSurface.json'

type Row = { ns: string; method: string; channel: string; kind: 'invoke' | 'send' | 'on' | 'on-dynamic'; remote: 'read' | 'mutate' | 'deny' }

export const DENY_MESSAGE = 'Not available in the web version'

/** Per-renderer persistence rows: a browser must never overwrite the Electron renderer's state. */
export const PERSISTENCE_CHANNELS: ReadonlySet<string> = new Set([
  'sessions:save',
  'promptSessions:merge-active-index',
  'layout:save',
])

type ParentLike = { postMessage: (msg: unknown, targetOrigin: string) => void }
type Listener = (...args: unknown[]) => void

export interface RemoteApiOptions {
  parent?: ParentLike
  /** Where `message` events from the parent arrive. Defaults to `window`. */
  events?: { addEventListener: (t: 'message', fn: (e: MessageEvent) => void) => void }
  targetOrigin?: string
}

export function createRemoteApi(opts: RemoteApiOptions = {}): Record<string, Record<string, unknown>> & { __remote: true } {
  const parent: ParentLike = opts.parent ?? (window.parent as unknown as ParentLike)
  const events = opts.events ?? (window as unknown as NonNullable<RemoteApiOptions['events']>)
  const targetOrigin = opts.targetOrigin ?? '*'
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const subs = new Map<string, Set<Listener>>()

  events.addEventListener('message', (e: MessageEvent) => {
    const m = e.data
    if (!m || typeof m !== 'object') return
    if (m.type === 'sm-ipc-result') {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.error) p.reject(new Error(typeof m.error === 'string' ? m.error : String(m.error?.message ?? m.error)))
      else p.resolve(m.result)
    } else if (m.type === 'sm-ipc-event') {
      const set = subs.get(m.channel)
      if (set) for (const fn of [...set]) fn(...(Array.isArray(m.args) ? m.args : []))
    }
  })

  const api: Record<string, Record<string, unknown>> = {}
  for (const r of rows as Row[]) {
    const ns = (api[r.ns] ??= {})
    if (r.remote === 'deny') {
      if (r.kind === 'on' || r.kind === 'on-dynamic') ns[r.method] = () => () => {}
      else if (r.kind === 'send') ns[r.method] = () => {}
      else ns[r.method] = () => Promise.reject(new Error(DENY_MESSAGE))
    } else if (PERSISTENCE_CHANNELS.has(r.channel)) {
      ns[r.method] = () => Promise.resolve({ ok: true })
    } else if (r.kind === 'invoke') {
      ns[r.method] = (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          const id = nextId++
          pending.set(id, { resolve, reject })
          parent.postMessage({ type: 'sm-ipc', id, channel: r.channel, args }, targetOrigin)
        })
    } else if (r.kind === 'send') {
      ns[r.method] = (...args: unknown[]) => {
        parent.postMessage({ type: 'sm-ipc', id: nextId++, channel: r.channel, args }, targetOrigin)
      }
    } else {
      const dynamic = r.kind === 'on-dynamic'
      ns[r.method] = (...a: unknown[]) => {
        const cb = (dynamic ? a[1] : a[0]) as Listener
        const channel = dynamic ? r.channel.replace(/\*$/, String(a[0])) : r.channel
        let set = subs.get(channel)
        if (!set) subs.set(channel, (set = new Set()))
        set.add(cb)
        parent.postMessage({ type: 'sm-ipc-subscribe', channel }, targetOrigin)
        return () => {
          set!.delete(cb)
          if (set!.size === 0) {
            subs.delete(channel)
            parent.postMessage({ type: 'sm-ipc-unsubscribe', channel }, targetOrigin)
          }
        }
      }
    }
  }
  return Object.assign(api, { __remote: true as const })
}

export function installRemoteApi(opts?: RemoteApiOptions): void {
  ;(window as unknown as { api: unknown }).api = createRemoteApi(opts)
}
