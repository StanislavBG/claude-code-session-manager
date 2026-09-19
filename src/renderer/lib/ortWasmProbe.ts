/**
 * Names the ONNX Runtime wasm/loader FILES this context actually requested.
 * ORT resolves its variant (plain / jsep / jspi / asyncify) internally from
 * runtime feature detection, so the base URL alone never says which binary
 * loaded — the browser's resource timing log does.
 * Complexity: O(r) over resource entries, r small.
 */
export function ortWasmFilesLoaded(
  entries: ReadonlyArray<{ name: string }> = typeof performance !== 'undefined' ? performance.getEntriesByType('resource') : [],
): string[] {
  const out = new Set<string>()
  // Resource Timing records nothing for file:// (the packaged app), so the
  // wasm fetches ORT makes on the main thread are also captured by a fetch tap.
  for (const e of [...entries, ...fetched]) {
    const m = /(ort-wasm[^/?#]*\.(?:wasm|mjs))(?:[?#]|$)/.exec(e.name)
    if (m) out.add(m[1])
  }
  return [...out]
}

const fetched: { name: string }[] = []

/** Idempotent tap on window.fetch that remembers ort-wasm URLs (file:// has no Resource Timing). */
export function installOrtFetchTap(): void {
  if (typeof window === 'undefined' || (window as unknown as { __ortTap?: boolean }).__ortTap) return
  ;(window as unknown as { __ortTap?: boolean }).__ortTap = true
  const orig = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('ort-wasm')) fetched.push({ name: url })
    return orig(input, init)
  }
}
