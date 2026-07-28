import { useState } from 'react'
import { smfileUrl } from '../state/editor'

interface Props {
  path: string
  onDismiss: () => void
}

// Small inline preview shown after an image paste (Terminal.tsx / TerminalChat.tsx),
// so the user can confirm what was pasted without opening the tmp file. Presentation
// only — the @path reference typed into the input/PTY is unaffected. Reuses the
// smfile:// protocol already allowed by CSP img-src (see ImagePane.tsx).
export function PasteThumbnail({ path, onDismiss }: Props) {
  const [failed, setFailed] = useState(false)
  if (failed) return null

  return (
    <div className="mb-2 inline-flex max-w-[160px] items-start gap-1.5 rounded-md border border-line bg-elev p-1.5">
      <img
        src={smfileUrl(path)}
        alt="Pasted clipboard image"
        className="max-h-[120px] max-w-[120px] rounded object-contain"
        draggable={false}
        onError={() => setFailed(true)}
      />
      <button
        type="button"
        onClick={onDismiss}
        title="Dismiss preview"
        className="shrink-0 rounded text-fg-faint hover:bg-hi hover:text-fg"
      >
        ✕
      </button>
    </div>
  )
}
