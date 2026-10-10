import { useAutoUpdater } from '../../lib/useAutoUpdater'
import { useToast } from '../../state/toast'
import { Toggle } from '../ui/Toggle'

const BTN = 'px-2 py-1 rounded border border-line text-xs text-fg hover:bg-bg-hi disabled:opacity-50'

/** Updates section of Settings → Session Manager; consumes window.api.updater via useAutoUpdater(). */
export function SettingsUpdates() {
  const status = useAutoUpdater()
  const show = useToast((s) => s.show)

  const run = async (fn: () => Promise<unknown>) => {
    try {
      const res = await fn()
      const r = res as { ok?: boolean; error?: string } | null
      if (r && r.ok === false) show('error', r.error ?? 'Update action failed')
    } catch (e) {
      show('error', e instanceof Error ? e.message : String(e))
    }
  }

  if (!status) return null
  const { state } = status
  const unsupported = state === 'unsupported'
  const latest = status.latest ? `v${status.latest}` : '—'

  const installNow = () => {
    const ok = window.confirm(
      'Installing now will stop all running jobs and terminals. Continue?',
    )
    if (ok) void run(() => window.api.updater.install(true))
  }

  return (
    <section data-testid="settings-updates" className="border border-line rounded p-3 space-y-3">
      <div className="space-y-1">
        <span className="text-fg text-xs font-medium">Updates</span>
        <div className="text-fg-dim text-xs flex gap-4">
          <span>Current v{status.current}</span>
          <span>Latest {latest}</span>
        </div>
      </div>

      {unsupported ? (
        <p className="text-fg-faint text-[11px]">
          Auto-update runs only in the installed Windows app or the Linux AppImage. npx builds
          update via npx.
        </p>
      ) : (
        <div className="flex items-center gap-3">
          <Toggle
            checked={status.enabled}
            onChange={(v) => void run(() => window.api.updater.setEnabled(v))}
            label="Update automatically"
          />
          <button
            type="button"
            data-testid="updates-check"
            className={BTN}
            disabled={state === 'checking' || state === 'downloading'}
            onClick={() => void run(() => window.api.updater.check())}
          >
            Check for updates
          </button>
        </div>
      )}

      {state === 'checking' && <p className="text-fg-dim text-xs">Checking…</p>}
      {state === 'downloading' && (
        <p className="text-fg-dim text-xs">
          Downloading… {status.progress != null ? `${Math.round(status.progress)}%` : ''}
        </p>
      )}
      {state === 'ready' && (
        <button
          type="button"
          data-testid="updates-install"
          className={BTN}
          onClick={() => void run(() => window.api.updater.install(false))}
        >
          Restart to install v{status.latest}
        </button>
      )}
      {state === 'deferred' && (
        <div className="space-y-2">
          <p className="text-fg-dim text-xs">Waiting for {status.busyReason ?? 'work'} to finish</p>
          <div className="flex gap-2">
            <button type="button" className={BTN} onClick={installNow}>
              Install now
            </button>
            <button
              type="button"
              className={BTN}
              onClick={() => void run(() => window.api.updater.cancelDeferred())}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {state === 'error' && <p className="text-red-400 text-xs">{status.error}</p>}
    </section>
  )
}
