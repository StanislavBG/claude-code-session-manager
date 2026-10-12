import { useEffect, useState } from 'react'
import { Z } from '../lib/zLayers'
import { toast } from '../state/toast'
import type { TelemetryConfig, TelemetryStatus } from '../../preload/api'

const CHANGED_EVENT = 'sm:telemetry-config-changed'

interface NoticeProps {
  cfg: TelemetryConfig
  /** Called with the persisted config/status after a successful ack. */
  onSaved?: (config: TelemetryConfig, status: TelemetryStatus) => void
}

/** First-run telemetry notice. Renders nothing once `noticeAckedAt` is set. */
export function TelemetryNotice({ cfg, onSaved }: NoticeProps) {
  if (cfg.noticeAckedAt) return null

  const ack = async (turnOff: boolean) => {
    try {
      const res = await window.api.telemetry.setConfig({
        ...cfg,
        enabled: turnOff ? false : cfg.enabled,
        noticeAckedAt: new Date().toISOString(),
      })
      onSaved?.(res.config, res.status)
      window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: res.config }))
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section
      data-testid="telemetry-first-run-notice"
      className="border border-accent rounded p-3 space-y-2 text-xs bg-bg-elev"
    >
      <div className="text-fg font-medium">This app sends anonymous product telemetry</div>
      <p className="text-fg-dim leading-relaxed">
        Collected: a coarse machine profile (OS/arch/app version, no hardware id), error and
        warning counts, and session counts — sent on start-up, after an update, and once a day.
      </p>
      <p className="text-fg-dim leading-relaxed">
        Never collected: prompts, transcripts, file paths, project names, email, or username.
      </p>
      <div className="flex items-center gap-2 pt-1">
        <button onClick={() => void ack(false)} className="px-3 py-1 rounded bg-accent text-bg">
          OK
        </button>
        <button
          onClick={() => void ack(true)}
          className="px-3 py-1 rounded border border-line text-fg-dim hover:text-fg"
        >
          Turn off
        </button>
      </div>
    </section>
  )
}

/** App-wide, non-blocking banner: mounted once in App; hidden until config loads. */
export function TelemetryNoticeBanner() {
  const [cfg, setCfg] = useState<TelemetryConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.telemetry.getConfig().then((c) => {
      if (!cancelled) setCfg(c)
    }).catch((e) => {
      console.warn('[product-telemetry] notice load failed:', e?.message)
    })
    const onChanged = (e: Event) => setCfg((e as CustomEvent<TelemetryConfig>).detail)
    window.addEventListener(CHANGED_EVENT, onChanged)
    return () => {
      cancelled = true
      window.removeEventListener(CHANGED_EVENT, onChanged)
    }
  }, [])

  if (!cfg || cfg.noticeAckedAt) return null
  return (
    <div className={`fixed bottom-4 right-4 w-96 max-w-[90vw] shadow-lg ${Z.dialog}`}>
      <TelemetryNotice cfg={cfg} onSaved={setCfg} />
    </div>
  )
}
