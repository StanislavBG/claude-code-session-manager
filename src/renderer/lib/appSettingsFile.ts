/**
 * One serialized read → patch → write primitive for the renderer-owned JSON
 * files under `~/.claude/session-manager/`. Instances are cached per path so
 * every caller of one file shares a single write queue: overlapping patches
 * never interleave, so a stale read can't drop a sibling key's change.
 * Writes go through `window.api.config.writeJson`.
 */
export interface AppSettingsFile<T extends object> {
  read: () => Promise<T>
  patch: (partial: Partial<T>) => Promise<void>
  /** Fires when the file changes on disk (any writer). Returns an unsubscribe. */
  subscribe: (cb: () => void) => () => void
}

const instances = new Map<string, AppSettingsFile<any>>() // lint-allow-any: heterogeneous registry keyed by file id

function samePath(eventPath: string, filePath: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/')
  const tail = norm(filePath).replace(/^~/, '')
  return norm(eventPath) === norm(filePath) || norm(eventPath).endsWith(tail)
}

export function appSettingsFile<T extends object = Record<string, unknown>>(path: string): AppSettingsFile<T> {
  const cached = instances.get(path)
  if (cached) return cached as AppSettingsFile<T>

  async function read(): Promise<T> {
    if (typeof window === 'undefined' || !window.api?.config?.readJson) return {} as T
    try {
      const r = await window.api.config.readJson(path)
      if (r?.exists && r.data && typeof r.data === 'object') return r.data as T
    } catch { /* diagnostic surface only */ }
    return {} as T
  }

  let queue: Promise<void> = Promise.resolve()

  function patch(partial: Partial<T>): Promise<void> {
    const run = queue.then(async () => {
      if (typeof window === 'undefined' || !window.api?.config?.writeJson) return
      const current = await read()
      await window.api.config.writeJson(path, { ...current, ...partial })
    })
    // Swallowed copy so one rejection never stalls the next caller's turn.
    queue = run.catch(() => {})
    return run
  }

  function subscribe(cb: () => void): () => void {
    const cfg = typeof window === 'undefined' ? undefined : window.api?.config
    if (!cfg?.onChanged) return () => {}
    try { cfg.watch?.([path]) } catch { /* watch is best-effort */ }
    const off = cfg.onChanged((info) => { if (samePath(info.path, path)) cb() })
    return () => {
      off()
      try { cfg.unwatch?.([path]) } catch { /* best-effort */ }
    }
  }

  const file: AppSettingsFile<T> = { read, patch, subscribe }
  instances.set(path, file)
  return file
}
