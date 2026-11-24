/**
 * MediaPane — in-place video/audio player for the Editor scene.
 *
 * Streams over smfile:// (same URL builder ImagePane and HtmlPreview use), so
 * the renderer never reads media bytes into memory. A load error keeps the
 * pane populated with an inline message (plus an error toast) — never blank.
 */

import { useEffect, useState } from 'react'
import { extOf, smfileUrl } from '../../../state/editor'
import { formatBytes } from '../../../lib/formatBytes'
import { useToast } from '../../../state/toast'

export const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v'])
export const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'opus'])

export type MediaKind = 'video' | 'audio'

export function mediaKindOf(p: string): MediaKind | null {
  const ext = extOf(p)
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  return null
}

export function isPlayableMedia(p: string): boolean {
  return mediaKindOf(p) !== null
}

interface Props {
  path: string
  name: string
  /** Bytes on disk, when known (from the editor's read probe). */
  size?: number
}

export function MediaPane({ path, name, size }: Props) {
  const kind = mediaKindOf(path) ?? 'video'
  const showToast = useToast((s) => s.show)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { setError(null) }, [path])

  const onError = () => {
    const msg = `Couldn't play ${name} — the format may be unsupported or the file unreadable.`
    setError(msg)
    showToast('error', msg)
  }

  const src = smfileUrl(path)
  const meta = size != null ? `${kind} · ${formatBytes(size)}` : kind

  return (
    <div data-testid="media-pane" className="h-full overflow-auto p-6 flex flex-col items-center justify-center gap-3 bg-bg">
      {error ? (
        <div data-testid="media-pane-error" className="max-w-sm text-center text-xs text-red-400">
          {error}
          <div className="mt-3 flex items-center justify-center gap-2">
            <button
              onClick={() => window.api.shell.open({ as: 'openPath', path })}
              className="px-3 py-1 text-xs text-fg rounded bg-bg-hi border border-line hover:bg-bg-elev"
            >
              Open in default app
            </button>
          </div>
        </div>
      ) : kind === 'video' ? (
        <video key={path} src={src} controls preload="metadata" onError={onError} className="max-w-full max-h-[80%] rounded border border-line bg-black" />
      ) : (
        <audio key={path} src={src} controls preload="metadata" onError={onError} className="w-full max-w-lg" />
      )}
      <div className="text-center">
        <div className="text-sm font-medium text-fg truncate">{name}</div>
        <div className="mt-1 text-[11px] text-fg-faint">{meta}</div>
      </div>
    </div>
  )
}
