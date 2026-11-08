/**
 * useFileAges — the on-disk age of each source an Extensions 3a tab edits, for
 * the tab row's "<path> · <age>" list (design-mocks/extensions-3a/DESIGN_SPEC.md
 * §1 Sources). formatSourceAge turns one age into that row's label.
 *
 * A file reads its mtime the way SourceChip does: config.readText(path, { maxBytes: 1 }).
 * A directory goes through config.exists instead and never through readText: a
 * readText on a directory path fails inside the IPC with EISDIR and comes back as
 * `exists: false`, which is why SourceChip labels an existing directory
 * "created on first save".
 *
 * Value per path in the returned record:
 *   number    — the file's mtimeMs
 *   null      — the file or directory is missing ("created on first save")
 *   'present' — the directory exists; it has no age, the row shows the path alone
 * A path with no key is still loading or could not be read (an IPC error, a
 * permission error) — the row shows the path alone, as SourceChip does while loading.
 *
 * Every source is re-read when window.api.config.onChanged reports one of the
 * source paths, or for a directory source any path inside it. Pass absolute
 * paths, the same form config:changed events carry.
 */
import { useEffect, useRef, useState } from 'react'
import { isUnder } from './pathSep'

export type FileAge = number | null | 'present'

export interface FileAgeSource {
  path: string
  kind: 'file' | 'dir'
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * Label for one source age: 'created on first save' (missing), null for an
 * existing directory (show the path alone), else 'just now' / 'Nm ago' /
 * 'Nh Mm ago' / 'Nd ago'. A clock-skewed future mtime reads 'just now'.
 */
export function formatSourceAge(v: FileAge, now: number = Date.now()): string | null {
  if (v === null) return 'created on first save'
  if (v === 'present') return null
  // A record lookup for a path that is still loading yields undefined at runtime;
  // show the path alone rather than "NaNd ago".
  if (!Number.isFinite(v)) return null
  const diff = Math.max(0, now - v)
  if (diff < MINUTE_MS) return 'just now'
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ${Math.floor((diff % HOUR_MS) / MINUTE_MS)}m ago`
  return `${Math.floor(diff / DAY_MS)}d ago`
}

/** One source's age, or undefined when it could not be determined. Never rejects. */
async function readAge(source: FileAgeSource): Promise<FileAge | undefined> {
  try {
    if (source.kind === 'dir') return (await window.api.config.exists(source.path)) ? 'present' : null
    const r = await window.api.config.readText(source.path, { maxBytes: 1 })
    if (r.exists) return Number.isFinite(r.mtimeMs) ? r.mtimeMs : undefined
    // `exists: false` with an error is a failed read (EACCES, EISDIR, a rejected
    // path), not a missing file — only ENOENT comes back with error null.
    return r.error ? undefined : null
  } catch {
    return undefined
  }
}

function sameAges(a: Record<string, FileAge>, b: Record<string, FileAge>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && Object.is(a[k], b[k]))
}

export function useFileAges(sources: ReadonlyArray<FileAgeSource>): Record<string, FileAge> {
  // Keyed by content, not array identity: callers pass an inline array literal,
  // and an identity dependency would re-read and re-render on every render.
  const key = JSON.stringify(sources.map((s) => [s.path, s.kind]))
  const [ages, setAges] = useState<Record<string, FileAge>>({})
  // Stale-response guard: each read pass takes a new id and only the newest
  // pass may write, so an older read never overwrites a newer one.
  const requestId = useRef(0)

  useEffect(() => {
    const list: FileAgeSource[] = (JSON.parse(key) as Array<[string, FileAgeSource['kind']]>).map(
      ([path, kind]) => ({ path, kind }),
    )
    const read = () => {
      const id = ++requestId.current
      void Promise.all(list.map(readAge)).then((results) => {
        if (id !== requestId.current) return
        const next: Record<string, FileAge> = {}
        list.forEach((s, i) => {
          const v = results[i]
          if (v !== undefined) next[s.path] = v
        })
        setAges((prev) => (sameAges(prev, next) ? prev : next))
      })
    }
    read()
    const off = window.api.config.onChanged((e) => {
      if (list.some((s) => e.path === s.path || (s.kind === 'dir' && isUnder(e.path, s.path)))) read()
    })
    return () => {
      requestId.current++ // a pass still in flight for this list must not land
      off()
    }
  }, [key])

  return ages
}
