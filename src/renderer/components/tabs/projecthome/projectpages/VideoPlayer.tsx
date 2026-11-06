/**
 * One saved video in the same sandboxed iframe DemoVideoFrame uses
 * (allow-scripts only, smfile:// src), driven through the player bridge
 * protocol (src/main/lib/project-pages/playerBridge.cjs): we post
 * {smPlayer:1, cmd} to the frame and accept {smPlayer:1, type:'state'}
 * replies only from that frame's own contentWindow.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { smfileUrl } from '../../../../state/editor'

interface Props {
  path: string
  mtimeMs: number
}

interface Scene {
  t: number
  label: string
}

interface PlayerState {
  duration: number
  t: number
  playing: boolean
  muted: boolean
  scenes: Scene[]
}

const INITIAL: PlayerState = { duration: 0, t: 0, playing: false, muted: true, scenes: [] }

function parseState(data: unknown): PlayerState | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.smPlayer !== 1 || d.type !== 'state') return null
  const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0)
  const scenes = Array.isArray(d.scenes)
    ? d.scenes
        .filter((s): s is { t: number; label?: unknown } => !!s && typeof (s as { t?: unknown }).t === 'number')
        .map((s) => ({ t: s.t, label: s.label == null ? '' : String(s.label) }))
    : []
  return { duration: num(d.duration), t: num(d.t), playing: d.playing === true, muted: d.muted !== false, scenes }
}

export function VideoPlayer({ path, mtimeMs }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [state, setState] = useState<PlayerState>(INITIAL)

  const send = useCallback((msg: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage({ smPlayer: 1, ...msg }, '*')
  }, [])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const win = frameRef.current?.contentWindow
      if (!win || event.source !== win) return
      const next = parseState(event.data)
      if (next) setState(next)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // A new file/mtime remounts the iframe; reset to the muted starting state.
  useEffect(() => {
    setState(INITIAL)
  }, [path, mtimeMs])

  const max = state.duration > 0 ? state.duration : 1
  const btn = 'px-2 py-1 rounded bg-bg-hi text-fg text-xs hover:bg-accent/20'

  return (
    <div className="w-full">
      <div className="aspect-video w-full bg-black">
        <iframe
          ref={frameRef}
          key={`${path}#${mtimeMs}`}
          title="Video"
          data-testid="video-player-frame"
          src={smfileUrl(path)}
          sandbox="allow-scripts"
          onLoad={() => send({ cmd: 'hello' })}
          className="w-full h-full border-0"
        />
      </div>
      <div className="flex items-center gap-2 p-2 bg-bg-hi text-fg">
        <button
          type="button"
          data-testid="video-play"
          className={btn}
          onClick={() => send({ cmd: state.playing ? 'pause' : 'play' })}
        >
          {state.playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" data-testid="video-restart" className={btn} onClick={() => send({ cmd: 'restart' })}>
          Restart
        </button>
        <div className="relative flex-1">
          <input
            type="range"
            data-testid="video-seek"
            aria-label="Seek"
            className="w-full accent-accent"
            min={0}
            max={max}
            step={0.1}
            value={Math.min(state.t, max)}
            onChange={(e) => {
              const t = Number(e.target.value)
              setState((s) => ({ ...s, t }))
              send({ cmd: 'seek', t })
            }}
          />
          {state.duration > 0 &&
            state.scenes.map((s, i) => (
              <span
                key={`${i}-${s.t}`}
                data-testid="video-scene-marker"
                title={s.label}
                className="absolute top-0 h-full w-0.5 bg-accent pointer-events-none"
                style={{ left: `${Math.min(100, (s.t / state.duration) * 100)}%` }}
              />
            ))}
        </div>
        <button
          type="button"
          data-testid="video-mute"
          className={btn}
          onClick={() => send({ cmd: state.muted ? 'unmute' : 'mute' })}
        >
          {state.muted ? 'Tap for sound' : 'Mute'}
        </button>
      </div>
    </div>
  )
}
