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
 * into the project's prompt-sessions/attachments dir via files.saveBinary
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
      const res = await window.api.files.saveBinary(destPath, base64, 'epics')
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

/** Attach entry point — a small icon-only button plus its hidden file input.
 *
 *  This is the ONLY attach control either prompt surface renders. The old
 *  full-width dashed "Paste a screenshot (⌘V) or drop files here · Attach"
 *  row is gone: it cost a whole row of vertical space to advertise two
 *  affordances that already work anywhere in the prompt (⌘V is handled by the
 *  textareas via attachPastedFiles, drag-drop by the surrounding container),
 *  and its "Attach" button duplicated this button. The paste/drop hint now
 *  lives inside the prompt itself — the textarea placeholder — rather than
 *  occupying a row of its own.
 *
 *  `testId` also names the hidden input as `<testId>-input`, so callers can
 *  drive a file selection in tests without reaching through the chips tray. */
export function AttachButton({
  att,
  testId,
  className = '',
  size = 17,
}: {
  att: AttachmentsState
  testId?: string
  className?: string
  size?: number
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const label = 'Attach files — or paste a screenshot (⌘V) or drop files onto the prompt'
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        onClick={() => inputRef.current?.click()}
        aria-label={label}
        title={label}
        className={className}
      >
        <AlmanacIcon name="paperclip" size={size} />
      </button>
      <input
        ref={inputRef}
        data-testid={testId ? `${testId}-input` : undefined}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) att.add(e.target.files)
          e.target.value = ''
        }}
      />
    </>
  )
}

/** Chips for the currently-attached references — a thumbnail (images) or file
 *  icon, name, size, and a remove button. Renders nothing at all when there is
 *  nothing attached, so an empty prompt costs zero vertical space; the attach
 *  affordances themselves live in AttachButton + the prompt's own
 *  paste/drop handlers. */
export function AttachTray({ att, testId }: { att: AttachmentsState; testId?: string }) {
  if (att.items.length === 0) return null
  return (
    <div data-testid={testId} className="mt-2 flex flex-wrap gap-2">
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
  )
}
