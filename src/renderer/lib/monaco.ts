import { loader } from '@monaco-editor/react'

// Memoized promise — ensures loader.config({ monaco }) is called exactly once
// before any @monaco-editor/react Editor component calls loader.init().
let _promise: Promise<typeof import('monaco-editor')> | null = null

export function ensureMonaco(): Promise<typeof import('monaco-editor')> {
  if (!_promise) {
    _promise = import('monaco-editor').then((m) => {
      // Pin @monaco-editor/react to the bundled package so it never attempts
      // to fetch from cdn.jsdelivr.net (blocked by our CSP: script-src 'self').
      loader.config({ monaco: m })
      return m
    })
  }
  return _promise
}
