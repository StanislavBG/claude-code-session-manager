import { useEffect, useState } from 'react'
import { TabModal } from './TabModal'
import { VoiceButton, TTSToggle } from '../VoiceButton'
import { MicDevicePicker } from '../MicDevicePicker'
import { MicLevelMeter } from '../MicLevelMeter'
import { SubmitCountdown } from '../SubmitCountdown'
import { useVoice } from '../../state/voice'
import { log } from '../../lib/logger'
import type { VoiceHotkeyConfig } from '../../../preload/api'

/**
 * Voice / Microphone modal — replaces the MicrophoneSection that used to
 * live in LeftNav. Same widgets, just hosted in a modal instead of a fixed
 * sidebar section. The HotkeyHint and HotkeyModeToggle were inlined here
 * (they were private helpers in LeftNav.tsx).
 */
export function VoiceModal({ open, onClose, variant = 'overlay' }: { open: boolean; onClose: () => void; variant?: 'overlay' | 'page' }) {
  return (
    <TabModal open={open} onClose={onClose} title="Voice / Microphone" variant={variant}>
      <div className="p-4 space-y-4">
        <MicActivityPanel />
        <SubmitCountdown />
        <div className="flex items-center gap-3 flex-wrap">
          <VoiceButton />
          <MicDevicePicker />
          <TTSToggle />
        </div>
        <HotkeyHint />
        <div className="flex items-center gap-4 flex-wrap">
          <button
            type="button"
            onClick={() => useVoice.getState().openWizard()}
            className="text-xs text-fg-faint hover:text-fg-dim underline"
            data-testid="run-mic-check"
          >
            Run mic check
          </button>
          <HotkeyModeToggle />
        </div>
        <MicLevelMeter />
      </div>
    </TabModal>
  )
}

function HotkeyHint() {
  const isRecording = useVoice((s) => s.isRecording)
  const [cfg, setCfg] = useState<VoiceHotkeyConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.voice.getHotkeyConfig()
      .then((c) => { if (!cancelled) setCfg(c) })
      .catch(() => {})
    const off = window.api.voice.onHotkeyConfigChanged((c) => setCfg(c))
    return () => { cancelled = true; off() }
  }, [])

  if (isRecording || !cfg) return null
  const verb = cfg.mode === 'hold' ? 'Hold' : 'Press'
  const label = formatAccelerator(cfg.accelerator)
  return (
    <div className="text-[11px] text-fg-faint">
      <span>{verb} </span>
      <kbd className="px-1 py-0.5 rounded border border-line bg-bg font-mono text-fg-dim">{label}</kbd>
      <span> to record</span>
    </div>
  )
}

function formatAccelerator(accel: string): string {
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
  return accel
    .replace(/CommandOrControl/g, isMac ? '⌘' : 'Ctrl')
    .replace(/CmdOrCtrl/g, isMac ? '⌘' : 'Ctrl')
    .replace(/Command/g, '⌘')
    .replace(/Control/g, 'Ctrl')
    .replace(/Option/g, isMac ? '⌥' : 'Alt')
    .replace(/Shift/g, isMac ? '⇧' : 'Shift')
}

function HotkeyModeToggle() {
  const [cfg, setCfg] = useState<VoiceHotkeyConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.voice.getHotkeyConfig()
      .then((c) => { if (!cancelled) setCfg(c) })
      .catch((e) => log.warn('voice-hotkey', 'getHotkeyConfig (toggle) failed', { error: String(e) }))
    const off = window.api.voice.onHotkeyConfigChanged((c) => { setCfg(c) })
    return () => { cancelled = true; off() }
  }, [])

  if (!cfg) return null

  const onChange = async (mode: 'hold' | 'toggle') => {
    if (cfg.mode === mode) return
    const next: VoiceHotkeyConfig = { ...cfg, mode }
    setCfg(next)
    try {
      await window.api.voice.setHotkeyConfig(next)
    } catch (e: unknown) {
      log.warn('voice-hotkey', 'setHotkeyConfig (toggle) failed', { error: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div
      className="flex items-center gap-3 text-[11px] text-fg-faint select-none"
      title="Mic hotkey behavior. Tap on/off: press once to start, again to stop. Hold to talk: record only while held (push-to-talk)."
    >
      <label className="flex items-center gap-1 cursor-pointer hover:text-fg-dim">
        <input
          type="radio"
          name="hotkey-mode"
          checked={cfg.mode === 'toggle'}
          onChange={() => onChange('toggle')}
          className="cursor-pointer"
          data-testid="hotkey-mode-toggle"
        />
        <span>Tap on/off</span>
      </label>
      <label className="flex items-center gap-1 cursor-pointer hover:text-fg-dim">
        <input
          type="radio"
          name="hotkey-mode"
          checked={cfg.mode === 'hold'}
          onChange={() => onChange('hold')}
          className="cursor-pointer"
          data-testid="hotkey-mode-hold"
        />
        <span>Hold to talk</span>
      </label>
    </div>
  )
}

function MicActivityPanel() {
  const isRecording = useVoice((s) => s.isRecording)
  const lastTranscript = useVoice((s) => s.lastTranscript)
  const error = useVoice((s) => s.error)
  const modelStatus = useVoice((s) => s.modelStatus)
  const loadingProgress = useVoice((s) => s.loadingProgress)

  if (error) {
    return (
      <div className="text-[11px] text-red-400" title={error}>
        ⚠ {error}
      </div>
    )
  }
  if (!isRecording) {
    if (modelStatus === 'loading') {
      return (
        <div className="text-[11px] text-fg-faint">
          <div className="flex items-center justify-between mb-1">
            <span>Loading speech model</span>
            <span className="font-mono">{loadingProgress}%</span>
          </div>
          <div className="h-1 rounded bg-bg overflow-hidden">
            <div
              className="h-full bg-accent transition-[width] duration-200"
              style={{ width: `${loadingProgress}%` }}
            />
          </div>
        </div>
      )
    }
    return null
  }
  return (
    <div className="flex items-center gap-2 text-[11px] text-fg-dim border border-line rounded px-2 py-1.5">
      <span className="inline-block w-2 h-2 rounded-full bg-red-400 animate-pulse shrink-0" />
      <span className="truncate" title={lastTranscript}>
        {lastTranscript || 'Listening…'}
      </span>
    </div>
  )
}
