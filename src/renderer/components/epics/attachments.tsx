import { useRef, useState } from 'react'
import { toast } from '../../state/toast'
import { AlmanacIcon } from '../layout/AlmanacIcon'

export interface AttachmentItem {
  id: string
  name: string
  size: string
  url: string | null
  /** Filesystem path Electron attaches to dropped/picked File objects
   *  (falls back to `name` when unavailable, e.g. a pasted clipboard image). */
  path: string
  /** True when `path` is a real absolute filesystem path (drag-drop / file
   *  picker) rather than the `name` fallback — callers that need to persist
   *  a pasted-clipboard image (no real path) use this to decide whether to
   *  read `file`'s bytes and save them first. */
  hasRealPath: boolean
  /** The original File object, kept so a pasted image without a real path
   *  can still be read and saved by a caller (e.g. EpicComposer). */
  file: File
}

export interface AttachmentsState {
  items: AttachmentItem[]
  add: (files: FileList | File[]) => void
  remove: (id: string) => void
  clear: () => void
}

function formatSize(bytes: number): string {
  if (!bytes) return '—'
  return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Shared attach-tray state — paste/drop/file-picker references for the New
 *  Epic card and (per PRD 828/827) the Epic-scoped composer. */
export function useAttachments(): AttachmentsState {
  const [items, setItems] = useState<AttachmentItem[]>([])
  const add = (files: FileList | File[]) => {
    const list = Array.from(files)
    if (!list.length) return
    const next = list.map((f) => {
      const realPath = (f as unknown as { path?: string }).path || ''
      return {
        id: Math.random().toString(36).slice(2),
        name: f.name || 'pasted-image.png',
        size: formatSize(f.size),
        url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
        path: realPath || f.name || 'pasted-image.png',
        hasRealPath: Boolean(realPath),
        file: f,
      }
    })
    setItems((prev) => [...prev, ...next])
  }
  const remove = (id: string) => setItems((prev) => prev.filter((i) => i.id !== id))
  const clear = () => setItems([])
  return { items, add, remove, clear }
}

/**
 * Shared ⌘V handler. Attach this to every element a user could plausibly be
 * focused in when they paste — in practice that means the COMPOSER TEXTAREA,
 * not just the tray: the tray owned the only onPaste for a while, so pasting
 * a screenshot while typing (the normal case, and the one the composer
 * placeholder advertises) silently did nothing. Returns true when files were
 * consumed, so a caller can skip its own paste handling.
 */
export function attachPastedFiles(e: React.ClipboardEvent, att: AttachmentsState): boolean {
  const files = e.clipboardData?.files
  if (!files || files.length === 0) return false
  e.preventDefault()
  att.add(files)
  return true
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/**
 * Resolves each attachment to an absolute path — real drag-drop/file-picker
 * paths pass through, pasted-clipboard images (no real path) are saved first
 * into the project's prompt-sessions/attachments dir via browser.saveBinary
 * (declared writer 'epics' under the single-writer law).
 *
 * Shared by BOTH the Epic composer and the New Epic card: the card used to
 * inline `item.path`, which for a pasted image is just "pasted-image.png" —
 * a reference line pointing at a file that does not exist anywhere.
 */
export async function resolveAttachmentPaths(items: AttachmentItem[], cwd: string): Promise<string[]> {
  const paths: string[] = []
  for (const item of items) {
    if (item.hasRealPath) {
      paths.push(item.path)
      continue
    }
    try {
      const destPath = `${cwd}/session-manager-operations/prompt-sessions/attachments/${item.id}-${item.name}`
      const base64 = await fileToBase64(item.file)
      const res = await window.api.browser.saveBinary(destPath, base64, 'epics')
      if (res.ok) {
        paths.push(destPath)
      } else {
        toast.error(`Failed to save attachment "${item.name}": ${res.error ?? 'unknown error'}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to save attachment "${item.name}": ${msg}`)
    }
  }
  return paths
}

/** Paste (⌘V) / drag-drop / file-picker tray for reference attachments.
 *  Chips show a thumbnail (images) or file icon, name, size, and a remove
 *  button. Matches the design mock's AttachTray. */
export function AttachTray({ att, tall, testId }: { att: AttachmentsState; tall?: boolean; testId?: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  const onPaste = (e: React.ClipboardEvent) => { attachPastedFiles(e, att) }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setOver(false)
    if (e.dataTransfer.files.length) att.add(e.dataTransfer.files)
  }

  return (
    <div data-testid={testId}>
      <div
        onPaste={onPaste}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        tabIndex={0}
        className={`flex items-center gap-2.5 rounded-[10px] border border-dashed outline-none ${
          tall ? 'p-3.5' : 'px-3 py-2.5'
        } ${over ? 'border-accent bg-accent/10' : 'border-rule'}`}
      >
        <span className={over ? 'text-accent' : 'text-fg-faint'} aria-hidden="true">
          <AlmanacIcon name="paperclip" size={14} />
        </span>
        <span className="text-[12.5px] leading-snug text-fg-faint">
          Paste a screenshot (⌘V) or drop files here
        </span>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="ml-auto shrink-0 rounded-lg border border-line bg-bg-hi px-2.5 py-1 text-xs font-semibold text-fg-dim hover:bg-bg-hi/80"
        >
          Attach
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) att.add(e.target.files)
            e.target.value = ''
          }}
        />
      </div>
      {att.items.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {att.items.map((i) => (
            <span
              key={i.id}
              className="inline-flex max-w-[240px] items-center gap-2 rounded-[9px] border border-line bg-bg-hi py-1 pl-2 pr-2.5"
            >
              {i.url ? (
                <img src={i.url} alt="" className="h-6 w-[30px] rounded object-cover border border-rule" />
              ) : (
                <span className="text-accent" aria-hidden="true">
                  <AlmanacIcon name="file" size={14} />
                </span>
              )}
              <span className="truncate font-mono text-[11px] text-fg-dim">{i.name}</span>
              <span className="shrink-0 font-mono text-[10px] text-fg-faint">{i.size}</span>
              <button
                type="button"
                onClick={() => att.remove(i.id)}
                title="Remove"
                className="shrink-0 text-fg-faint hover:text-fg"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
