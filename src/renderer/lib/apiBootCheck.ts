/**
 * apiBootCheck — runtime invariant that catches preload/renderer drift at startup.
 *
 * Why this exists: `src/preload/api.d.ts` is hand-maintained and *declares* what
 * `window.api.*` looks like. If a namespace is added to api.d.ts but never
 * exposed in `src/preload/index.cjs`, TypeScript compiles cleanly and the
 * renderer only crashes the first time the user touches that feature, with a
 * useless `Cannot read properties of undefined (reading 'X')` deep in a
 * bundled file. This module walks `window.api` at boot and surfaces missing
 * namespaces as a single, clear startup error — before any feature is used.
 *
 * Keep EXPECTED_NAMESPACES in sync with `SessionManagerAPI` in api.d.ts. The
 * cost of forgetting an entry here is one missing-namespace bug going
 * unsurfaced; the cost of inventing a wrong name is one false alarm at boot.
 */

// Source of truth: the top-level keys in `SessionManagerAPI` (preload/api.d.ts)
// and the literal in `contextBridge.exposeInMainWorld('api', {...})`
// (preload/index.cjs) must both match this list. Drift between any two of the
// three sources is exactly what this check catches.
//
// To regenerate after adding a namespace, search both files for the new key
// and add it here. The list is short (~20) by design — if it grows past 30,
// switch to a build-time manifest emitter.
const EXPECTED_NAMESPACES = [
  'app',
  'pty',
  'transcripts',
  'sessions',
  'billing',
  'logs',
  'config',
  'voice',
  'watchers',
  'otel',
  'history',
  'schedule',
  'supervisor',
  'teams',
  'plugins',
  'clipboard',
  'memory',
] as const

export type ApiBootIssue =
  | { kind: 'api-root-missing' }
  | { kind: 'namespace-missing'; name: string }
  | { kind: 'namespace-not-object'; name: string; actualType: string }

export function inspectApi(api: unknown): ApiBootIssue[] {
  if (!api || typeof api !== 'object') {
    return [{ kind: 'api-root-missing' }]
  }
  const obj = api as Record<string, unknown>
  const issues: ApiBootIssue[] = []
  for (const ns of EXPECTED_NAMESPACES) {
    const v = obj[ns]
    if (v === undefined || v === null) {
      issues.push({ kind: 'namespace-missing', name: ns })
    } else if (typeof v !== 'object') {
      issues.push({ kind: 'namespace-not-object', name: ns, actualType: typeof v })
    }
  }
  return issues
}

function formatIssue(i: ApiBootIssue): string {
  switch (i.kind) {
    case 'api-root-missing':
      return 'window.api is missing — preload did not load. Check src/preload/index.cjs and the main process console.'
    case 'namespace-missing':
      return `window.api.${i.name} is missing — declared in src/preload/api.d.ts but not exposed in src/preload/index.cjs.`
    case 'namespace-not-object':
      return `window.api.${i.name} is ${i.actualType}, expected object — preload exposure is malformed.`
  }
}

/**
 * Call once at renderer startup. Logs to console immediately (visible in
 * DevTools), and best-effort fires a toast 1s later (after the toast system
 * has mounted). Returns the issue list for tests / programmatic checks.
 */
export function runApiBootCheck(): ApiBootIssue[] {
  const issues = inspectApi((window as unknown as { api?: unknown }).api)
  if (issues.length === 0) return issues

  for (const i of issues) {
    console.error('[apiBootCheck]', formatIssue(i))
  }

  // Defer the toast: the toast store and <Toast/> mount happen after
  // main.tsx → ReactDOM.createRoot finishes. 1s is a generous cushion.
  setTimeout(() => {
    import('../state/toast')
      .then(({ toast }) => {
        const summary =
          issues.length === 1
            ? formatIssue(issues[0])
            : `Renderer is out of sync with preload (${issues.length} issues). See console for details.`
        toast.error(summary)
      })
      .catch(() => { /* toast unavailable — console error above is the surface */ })
  }, 1000)

  return issues
}
