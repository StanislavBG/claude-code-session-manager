/**
 * MdDocPreview — one doc in the full-screen MD network explorer's inspector.
 *
 * Reads the doc through `window.api.files.read`, renders it through the
 * Editor's sanitized MarkdownPreview (marked → DOMPurify), and lays out how
 * agents meet it, when it last changed, its in/out links, the code files that
 * name it, and what it names that changed since or no longer exists. Links
 * clicked inside the preview move the explorer (onNavigate) — the app window
 * never navigates. Curation controls render only when the parent passes all
 * three callbacks; persisting them is the parent's job.
 */
import { useEffect, useMemo, useState } from 'react'
import { MarkdownPreview } from '../../editor/MarkdownPreview'
import { toast } from '../../../../state/toast'
import { useEditor } from '../../../../state/editor'
import { docFlags, relativeAge, usageLine, type MdVerdict } from '../../../../lib/mdCurate'
import type { MdDocRole, MdNetwork } from '../../../../../preload/api'

export const MAX_PREVIEW_CHARS = 200_000
const MAX_NOTE = 280
const VERDICTS: { v: MdVerdict; label: string }[] = [
  { v: 'keep', label: 'Keep' },
  { v: 'update', label: 'Update' },
  { v: 'merge', label: 'Merge' },
  { v: 'delete', label: 'Delete' },
]

const ROLE_LABEL: Record<MdDocRole, string> = {
  map: 'map',
  scoped: 'scoped',
  agent: 'agent',
  record: 'record',
  doc: 'doc',
}

export interface MdDocPreviewProps {
  cwd: string | null | undefined
  path: string
  network: MdNetwork
  nowMs?: number
  verdict?: MdVerdict | null
  note?: string
  reviewedAtMs?: number | null
  onNavigate: (path: string) => void
  onVerdict?: (v: MdVerdict | null) => void
  onNote?: (text: string) => void
  onMarkReviewed?: () => void
}

export function absolutePath(cwd: string, rel: string): string {
  const base = cwd.replace(/[\\/]+$/, '')
  const tail = rel === '.' || rel === './' ? '' : rel.replace(/^\.\//, '').replace(/\/+$/, '')
  return tail === '' ? base : `${base}/${tail}`
}

/** Resolve a relative href against `docPath`'s folder; null when it climbs out of the project. */
export function resolveRelative(docPath: string, href: string): string | null {
  let target = href.replace(/[#?].*$/, '')
  try { target = decodeURIComponent(target) } catch { /* keep as written */ }
  if (!target) return null
  const parts: string[] = []
  if (!target.startsWith('/')) {
    const i = docPath.lastIndexOf('/')
    if (i > 0) parts.push(...docPath.slice(0, i).split('/'))
  }
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else parts.push(seg)
  }
  return parts.length ? parts.join('/') : null
}

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs))
}

function DocList({ name, title, items }: { name: string; title: string; items: { key: string; node: React.ReactNode }[] }) {
  return (
    <section data-testid={`md-doc-preview-${name}`} className="min-w-0">
      <div className="mb-1 flex items-center gap-2 font-mono text-[10.5px] tracking-[.1em] text-fg-faint">
        <span>{title}</span>
        <span data-testid={`md-doc-preview-${name}-count`}>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="text-[11.5px] text-fg-faint">none</div>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {items.map((it) => (
            <li key={it.key} className="min-w-0 break-all font-mono text-[11.5px] text-fg">{it.node}</li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function MdDocPreview({
  cwd, path, network, nowMs, verdict, note, reviewedAtMs,
  onNavigate, onVerdict, onNote, onMarkReviewed,
}: MdDocPreviewProps) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState(note ?? '')

  useEffect(() => { setDraft(note ?? '') }, [note, path])

  useEffect(() => {
    let live = true
    setText(null)
    setError(null)
    if (!cwd) return () => { live = false }
    const fail = (why: string) => {
      if (!live) return
      setError(why)
      toast.error(`Could not read ${path}: ${why}`)
    }
    window.api.files.read(absolutePath(cwd, path)).then(
      (res) => {
        if (!live) return
        if (res.ok) setText(res.text)
        else fail(res.error ?? 'unknown error')
      },
      (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
    )
    return () => { live = false }
  }, [cwd, path])

  const now = nowMs ?? Date.now()
  const census = network.census
  const doc = census?.docs.find((d) => d.path === path)
  const known = useMemo(() => {
    const s = new Set<string>()
    for (const d of census?.docs ?? []) s.add(d.path)
    return s
  }, [census])

  const linkedFrom = useMemo(
    () => uniq(network.edges.filter((e) => !e.broken && e.to === path).map((e) => e.from)),
    [network.edges, path],
  )
  const linksTo = useMemo(
    () => uniq(network.edges.filter((e) => !e.broken && e.from === path).map((e) => e.to)),
    [network.edges, path],
  )

  const truncated = text != null && text.length > MAX_PREVIEW_CHARS
  const shown = text == null ? '' : truncated ? text.slice(0, MAX_PREVIEW_CHARS) : text
  const absPath = cwd ? absolutePath(cwd, path) : null

  const onPreviewClickCapture = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement | null)?.closest?.('a')
    if (!a) return
    const href = (a.getAttribute('href') || '').trim()
    if (href.startsWith('#')) return
    e.preventDefault()
    e.stopPropagation()
    if (/^https?:\/\//i.test(href)) {
      window.api.shell.open({ as: 'external', url: href }).catch(() => { /* OS browser unavailable */ })
      return
    }
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return
    const resolved = resolveRelative(path, href)
    if (resolved && /\.md$/i.test(resolved) && known.has(resolved)) onNavigate(resolved)
  }

  const openInEditor = () => {
    if (!absPath) return
    useEditor.getState().openFile(absPath)
    window.dispatchEvent(new CustomEvent('sm:open-editor'))
  }

  const reveal = () => {
    if (!absPath) return
    const fail = (why: string) => toast.error(`Could not reveal ${path}: ${why}`)
    window.api.shell.open({ as: 'revealPath', path: absPath }).then(
      (res) => { if (!res.ok) fail(res.error ?? 'unknown error') },
      (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
    )
  }

  const navItem = (p: string) => ({
    key: p,
    node: (
      <button type="button" onClick={() => onNavigate(p)} className="text-left text-accent hover:underline">
        {p}
      </button>
    ),
  })

  const curation = !!(onVerdict && onNote && onMarkReviewed)

  return (
    <div data-testid="md-doc-preview" className="flex h-full min-h-0 flex-col gap-3 overflow-auto">
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="md-doc-preview-path" className="min-w-0 break-all font-mono text-[12.5px] text-fg">{path}</span>
          {doc && (
            <span data-testid="md-doc-preview-role" className="rounded-full border border-rule-inner px-2 py-px font-mono text-[10.5px] text-fg-faint">
              {ROLE_LABEL[doc.role]}
            </span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            data-testid="md-doc-preview-open"
            disabled={!absPath}
            onClick={openInEditor}
            className="rounded border border-rule-inner px-2 py-0.5 text-[11.5px] text-fg hover:bg-bg disabled:opacity-50"
          >
            Open in editor
          </button>
          <button
            type="button"
            data-testid="md-doc-preview-reveal"
            disabled={!absPath}
            onClick={reveal}
            className="rounded border border-rule-inner px-2 py-0.5 text-[11.5px] text-fg hover:bg-bg disabled:opacity-50"
          >
            Reveal in folder
          </button>
        </div>
        {doc && (
          <>
            <div data-testid="md-doc-preview-usage" className="text-[12px] text-fg">{usageLine(doc)}</div>
            <div data-testid="md-doc-preview-stats" className="flex flex-wrap gap-3 font-mono text-[11px] text-fg-faint">
              <span>changed {relativeAge(doc.lastCommitMs, now)}</span>
              <span>{doc.commits} {doc.commits === 1 ? 'commit' : 'commits'}</span>
              {doc.lines != null && <span>{doc.lines} lines</span>}
              {doc.bytes != null && <span>{(doc.bytes / 1024).toFixed(1)} KB</span>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {docFlags(doc, reviewedAtMs ?? null, now).map((f) => (
                <span
                  key={f.flag}
                  data-testid={`md-doc-preview-flag-${f.flag}`}
                  className="rounded-full border border-honey px-2 py-px text-[10.5px] text-honey-dark"
                >
                  {f.label}
                </span>
              ))}
            </div>
          </>
        )}
      </header>

      {curation && (
        <section data-testid="md-doc-preview-curation" className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Verdict" className="flex overflow-hidden rounded border border-rule-inner">
            {VERDICTS.map(({ v, label }) => (
              <button
                key={v}
                type="button"
                data-testid={`md-doc-preview-verdict-${v}`}
                aria-pressed={verdict === v}
                onClick={() => onVerdict!(verdict === v ? null : v)}
                className={verdict === v ? 'bg-accent px-2 py-0.5 text-[11.5px] text-bg' : 'px-2 py-0.5 text-[11.5px] text-fg hover:bg-bg'}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            type="text"
            data-testid="md-doc-preview-note"
            aria-label="Note"
            placeholder="Note"
            maxLength={MAX_NOTE}
            value={draft}
            onChange={(e) => {
              const v = e.target.value.slice(0, MAX_NOTE)
              setDraft(v)
              onNote!(v)
            }}
            className="min-w-0 flex-1 rounded border border-rule-inner bg-bg px-2 py-0.5 text-[11.5px] text-fg"
          />
          <button
            type="button"
            data-testid="md-doc-preview-mark-reviewed"
            onClick={() => onMarkReviewed!()}
            className="rounded border border-rule-inner px-2 py-0.5 text-[11.5px] text-fg hover:bg-bg"
          >
            {reviewedAtMs != null ? `Reviewed ${relativeAge(reviewedAtMs, now)}` : 'Mark reviewed'}
          </button>
        </section>
      )}

      <div className="grid grid-cols-2 gap-3">
        <DocList name="linked-from" title="LINKED FROM" items={linkedFrom.map(navItem)} />
        <DocList name="links-to" title="LINKS TO" items={linksTo.map(navItem)} />
        {doc && (
          <>
            <DocList name="named-by-code" title="NAMED BY CODE" items={doc.codeRefFiles.map((p) => ({ key: p, node: p }))} />
            <DocList
              name="changed-since"
              title="CHANGED SINCE"
              items={doc.changedSince.map((c) => ({ key: c.path, node: <>{c.path} <span className="text-fg-faint">{relativeAge(c.ms, now)}</span></> }))}
            />
            <DocList name="missing-paths" title="MISSING PATHS" items={doc.deadRefs.map((p) => ({ key: p, node: p }))} />
          </>
        )}
      </div>

      <div data-testid="md-doc-preview-body" className="min-h-[200px] flex-1 rounded border border-rule-inner" onClickCapture={onPreviewClickCapture}>
        {error != null ? (
          <div data-testid="md-doc-preview-error" className="px-4 py-3 text-[12px] text-delta-bad">Could not read {path}: {error}</div>
        ) : text == null ? (
          <div data-testid="md-doc-preview-loading" className="px-4 py-3 text-[12px] text-fg-faint">{cwd ? 'Loading…' : 'No project folder'}</div>
        ) : (
          <>
            {truncated && (
              <div data-testid="md-doc-preview-truncated" className="px-4 pt-2 text-[11px] text-fg-faint">
                Showing the first {MAX_PREVIEW_CHARS.toLocaleString()} of {text.length.toLocaleString()} characters.
              </div>
            )}
            <MarkdownPreview text={shown} flush />
          </>
        )}
      </div>
    </div>
  )
}
