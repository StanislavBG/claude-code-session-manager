import { useEffect, useState } from 'react'
import type { LoginItemStatus } from '../../../preload/api'
import { toast } from '../../state/toast'
import { Toggle } from '../ui/Toggle'

function describe(status: LoginItemStatus | null): string {
  if (!status) return 'Checking…'
  if (!status.supported) return status.reason ?? 'Start at login is not available here.'
  if (status.starts === 'npx') {
    return 'Runs npx claude-code-session-manager@latest at login, so it starts the newest release.'
  }
  if (status.starts === 'app') return 'Starts the installed app at login.'
  return status.reason ?? ''
}

/**
 * "Start at login" — reads and writes the OS login item through window.api.loginItem.
 * No preference file: the system's own login item is the only state, re-read on every mount.
 */
export function SettingsStartAtLogin() {
  const [status, setStatus] = useState<LoginItemStatus | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let alive = true
    window.api.loginItem
      .status()
      .then((s) => { if (alive) setStatus(s) })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))
    return () => { alive = false }
  }, [])

  const change = async (value: boolean) => {
    setPending(true)
    try {
      const res = await window.api.loginItem.setEnabled(value)
      if (res.ok) setStatus(res.status)
      else toast.error(res.error)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  const supported = status?.supported === true
  return (
    <section data-testid="settings-start-at-login" className="space-y-1">
      <Toggle
        checked={status?.enabled === true}
        onChange={(v) => void change(v)}
        disabled={!supported || pending}
        label="Start at login"
      />
      <p data-testid="start-at-login-desc" className="text-fg-faint text-[11px]">
        {describe(status)}
      </p>
    </section>
  )
}
