import ReactDOM from 'react-dom/client'
import { App } from './App'
import { runApiBootCheck } from './lib/apiBootCheck'
import './styles.css'

// Surface otherwise-silent async failures as [renderer] lines instead of the
// default "Uncaught (in promise)" dev-console spam with no file context. Both
// handlers prevent the default so HMR/devtools don't freeze when a tab throws.
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason instanceof Error ? e.reason.stack ?? e.reason.message : String(e.reason)
  console.error('[renderer] unhandled rejection:', reason)
})
window.addEventListener('error', (e) => {
  // Resource-load errors (img/script) show up here with no `error` payload —
  // ignore those and only log real exceptions.
  if (!e.error) return
  console.error('[renderer] uncaught error:', e.error.stack ?? e.error.message ?? e.error)
})

// Fail loudly and early if the preload bridge never attached — without this
// every tab throws a cryptic "Cannot read properties of undefined (reading
// 'config')" on mount and the user has to dig through stack traces.
if (typeof (window as unknown as { api?: unknown }).api === 'undefined') {
  console.error(
    '[renderer] window.api is undefined — preload script failed to load. ' +
      'Check main/index.cjs BrowserWindow webPreferences.preload path.',
  )
}

// Catch the more common drift case: preload partially loaded but a namespace
// declared in api.d.ts isn't actually exposed in preload/index.cjs. Without
// this, the bug only surfaces the first time a user touches the affected
// feature, with a useless `Cannot read properties of undefined` deep in the
// bundle (real example: Doc Editor crashed because docEditor namespace was in
// api.d.ts but missing from preload/index.cjs).
runApiBootCheck()

// NOTE: StrictMode is intentionally disabled. The Terminal component owns an
// xterm instance tied to a PTY process in the main process; StrictMode's
// double-invocation of effects disposes the xterm after the PTY has already
// spawned, leaving a live PTY with no terminal to display it or receive input.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
