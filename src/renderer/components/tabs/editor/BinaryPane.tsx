/**
 * BinaryPane — fallback for files that aren't editable text (NUL-byte sniff in
 * files.cjs, or > 5 MB). Shows type + size and routes to the OS app instead of
 * garbling bytes into Monaco. Office docs land here too (open externally).
 */

interface Props {
  path: string
  name: string
  size: number
  mime: string
  reason: string
}

function humanSize(bytes: number): string {
  if (!bytes) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`
}

export function BinaryPane({ path, name, size, mime, reason }: Props) {
  return (
    <div className="h-full flex items-center justify-center bg-bg">
      <div className="text-center max-w-sm px-6">
        <div className="mx-auto mb-4 w-12 h-12 rounded-lg border border-line flex items-center justify-center text-fg-faint">
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
          </svg>
        </div>
        <div className="text-sm font-medium text-fg truncate">{name}</div>
        <div className="mt-1 text-[11px] text-fg-faint">{reason} · {mime} · {humanSize(size)}</div>
        <div className="mt-5 flex items-center justify-center gap-2">
          <button
            onClick={() => window.api.files.openExternal(path)}
            className="px-3 py-1 text-xs text-fg rounded bg-bg-hi border border-line hover:bg-bg-elev"
          >
            Open in default app
          </button>
          <button
            onClick={() => window.api.files.showInFinder(path)}
            className="px-3 py-1 text-xs text-fg-dim hover:text-fg border border-line rounded"
          >
            Reveal
          </button>
        </div>
      </div>
    </div>
  )
}
