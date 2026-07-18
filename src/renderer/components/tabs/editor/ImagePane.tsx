/**
 * ImagePane — non-editable image viewer for the Editor scene.
 *
 * Raster (png/jpg/gif/webp/ico) loads over smfile:// (allowed by img-src in the
 * renderer CSP, works in dev and prod alike). SVG is read as text and rendered
 * inline.
 */

import { useEffect, useState } from 'react'
import DOMPurify from 'dompurify'
import { extOf, smfileUrl } from '../../../state/editor'

interface Props {
  path: string
  name: string
}

export function ImagePane({ path, name }: Props) {
  const isSvg = extOf(path) === 'svg'
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isSvg) return
    let cancelled = false
    setSvg(null)
    setError(null)
    window.api.files.read(path).then((r) => {
      if (cancelled) return
      if (!r.ok) setError(r.error ?? 'failed to read')
      else setSvg(r.text)
    })
    return () => { cancelled = true }
  }, [path, isSvg])

  if (error) return <div className="p-6 text-xs text-red-400">{error}</div>

  return (
    <div className="h-full overflow-auto p-6 flex items-center justify-center bg-bg">
      {isSvg ? (
        svg != null && <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(svg) }} />
      ) : (
        <img src={smfileUrl(path)} alt={name} className="max-w-full max-h-full object-contain" draggable={false} />
      )}
    </div>
  )
}
