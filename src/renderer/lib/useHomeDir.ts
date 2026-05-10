import { useEffect, useState } from 'react'

let cached: string | null = null
const subscribers = new Set<(v: string) => void>()
let inflight: Promise<string> | null = null

function fetchHome(): Promise<string> {
  if (cached) return Promise.resolve(cached)
  if (inflight) return inflight
  inflight = window.api.app.homeDir().then((h) => {
    cached = h
    subscribers.forEach((fn) => fn(h))
    return h
  })
  return inflight
}

/** App-wide cached $HOME. Returns null until resolved, then stable for the app lifetime. */
export function useHomeDir(): string | null {
  const [home, setHome] = useState<string | null>(cached)
  useEffect(() => {
    if (cached) {
      setHome(cached)
      return
    }
    const fn = (v: string) => setHome(v)
    subscribers.add(fn)
    fetchHome()
    return () => {
      subscribers.delete(fn)
    }
  }, [])
  return home
}
