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
  for (const e of entries) {
    const m = /(ort-wasm[^/?#]*\.(?:wasm|mjs))(?:[?#]|$)/.exec(e.name)
    if (m) out.add(m[1])
  }
  return [...out]
}
