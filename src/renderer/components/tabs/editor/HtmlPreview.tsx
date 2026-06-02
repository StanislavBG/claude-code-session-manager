/**
 * HtmlPreview — the visualization layer. Renders an HTML file in a sandboxed
 * iframe that loads it over the smfile:// scheme, so the page's own scripts
 * (D3, Chart.js, interactive project-structure views) run and its relative
 * assets (./chart.js, ./data.json) resolve.
 *
 * Isolation: sandbox grants allow-scripts but NOT allow-same-origin, so the
 * document has an opaque origin — it cannot reach window.parent, the app's IPC
 * bridge, localStorage, or the user's files via same-origin. See PRD 03 +
 * the smfile:// handler in src/main/index.cjs.
 *
 * The iframe reflects the file ON DISK. While there are unsaved edits, a hint
 * offers to save-to-refresh; `reloadToken` (bumped on save) forces a reload.
 */

import { smfileUrl } from '../../../state/editor'

interface Props {
  path: string
  dirty: boolean
  /** Bumped by EditorView on save to force the iframe to reload from disk. */
  reloadToken: number
}

export function HtmlPreview({ path, dirty, reloadToken }: Props) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 h-7 shrink-0 border-b border-line bg-bg-elev text-[10px] text-fg-faint">
        <ShieldIcon />
        <span>Sandboxed preview — scripts run in an isolated origin.</span>
        {dirty && (
          <span className="ml-auto text-amber-400">Unsaved edits — save to refresh the preview.</span>
        )}
      </div>
      <iframe
        key={`${path}#${reloadToken}`}
        title={path}
        src={smfileUrl(path)}
        // No allow-same-origin → opaque origin, walled off from the host app.
        sandbox="allow-scripts allow-popups allow-forms allow-modals"
        className="flex-1 w-full bg-white border-0"
      />
    </div>
  )
}

function ShieldIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}
