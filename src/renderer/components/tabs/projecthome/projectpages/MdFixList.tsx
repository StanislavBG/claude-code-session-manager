/**
 * Review MD network's FIX LIST card: one ranked list of what to fix, built from the one
 * `window.api.projectPages.mdNetwork` scan. Duplicated text comes first (the scan's
 * `duplicates`, most shared first), then broken or local-only links, then orphan groups (the
 * scan's `findings`, in its order). Each row says where the text should live.
 *
 * A duplicate's keeper is a map (census role `map`) always — it keeps its one-line rule and the
 * other doc links to it; else the topic doc (role `doc`) over a scoped or agent doc; ties go to
 * the doc more docs link to, then to the pair's first doc. Purely presentational:
 * hovering a row reports its index so the link map can light its nodes.
 */
import { toast } from '../../../../state/toast'
import type { MdDoc, MdDuplicatePair, MdNetwork, MdNetworkFinding } from '../../../../../preload/api'

export type MdFixKind = 'duplicate' | 'broken-link' | 'orphan'

/** One fix-list row. */
export interface MdFixRow {
  kind: MdFixKind
  key: string
  /** The headline: the duplicate pair, the broken link's `where`, or the orphan folder. */
  where: string
  /** What to do, or why it matters. */
  detail: string
  /** The repo-relative path Open reveals. */
  open: string
  /** The row's index in the scan's `findings`; null for a duplicate. */
  findingIndex: number | null
  /** Doc paths the row is about (a duplicate's pair), for lighting map nodes. */
  docs: string[]
}

const KIND_RANK: Record<MdFixKind, number> = { duplicate: 0, 'broken-link': 1, orphan: 2 }

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** The doc of a duplicate pair the text should live in, and the one that should link to it. */
export function chooseKeeper(pair: MdDuplicatePair, docs: readonly MdDoc[]): { keeper: string; other: string } {
  const of = (path: string) => docs.find((d) => d.path === path)
  const a = of(pair.a)
  const b = of(pair.b)
  const rank = (d: MdDoc | undefined) => (d?.role === 'map' ? 2 : d?.role === 'doc' ? 1 : 0)
  const linked = (d: MdDoc | undefined) => d?.linkedFrom ?? 0
  const bWins = rank(b) > rank(a) || (rank(b) === rank(a) && linked(b) > linked(a))
  return bWins ? { keeper: pair.b, other: pair.a } : { keeper: pair.a, other: pair.b }
}

function findingRow(f: MdNetworkFinding, i: number): MdFixRow {
  if (f.type === 'broken-link') {
    return {
      kind: 'broken-link',
      key: `broken-link ${f.where}`,
      where: f.where,
      detail: f.localOnly ? `Works only on this machine: ${f.target} is not tracked in git.` : f.detail,
      open: f.file,
      findingIndex: i,
      docs: [f.file],
    }
  }
  return { kind: 'orphan', key: `orphan ${f.where}`, where: f.where, detail: f.detail, open: f.where, findingIndex: i, docs: [] }
}

/** The ranked rows: duplicates, then broken links, then orphans; each kind keeps the scan's order. */
export function buildFixList(net: MdNetwork): MdFixRow[] {
  const docs = net.census?.docs ?? []
  const dupes = (net.duplicates ?? []).map((pair): MdFixRow => {
    const { keeper, other } = chooseKeeper(pair, docs)
    const keeperIsMap = docs.find((d) => d.path === keeper)?.role === 'map'
    const action = keeperIsMap
      ? `Keep the rule in ${keeper}; replace the copy in ${other} with a link to it`
      : `Keep it in ${keeper}; link to it from ${other}`
    return {
      kind: 'duplicate',
      key: `duplicate ${pair.a}\0${pair.b}`,
      where: `Same text in ${pair.a} and ${pair.b} (${plural(pair.sharedRuns, 'shared run')})`,
      detail: pair.copy ? `Full copy: keep one. ${action}` : action,
      open: other,
      findingIndex: null,
      docs: [pair.a, pair.b],
    }
  })
  const rows = [...dupes, ...net.findings.map(findingRow)]
  return rows
    .map((r, i) => ({ r, i }))
    .sort((x, y) => KIND_RANK[x.r.kind] - KIND_RANK[y.r.kind] || x.i - y.i)
    .map(({ r }) => r)
}

/** How many rows the fix list shows for a scan. */
export function fixListCount(net: MdNetwork): number {
  return (net.duplicates?.length ?? 0) + net.findings.length
}

/**
 * The Open button's label: a duplicate row names the doc it opens (the one to edit) as
 * `<parent>/<file>` when it sits in a folder, so `src/CLAUDE.md` never reads as the root file.
 */
function openLabel(r: MdFixRow): string {
  if (r.kind !== 'duplicate') return 'Open'
  const parts = r.open.replace(/^\.\//, '').replace(/\/+$/, '').split('/').filter(Boolean)
  const name = parts.slice(-2).join('/') || r.open
  return `Open ${name}`
}

function absolutePath(cwd: string, rel: string): string {
  const base = cwd.replace(/[\\/]+$/, '')
  const tail = rel === '.' || rel === './' ? '' : rel.replace(/^\.\//, '').replace(/\/+$/, '')
  return tail === '' ? base : `${base}/${tail}`
}

function openRow(cwd: string, rel: string): void {
  const fail = (why: string) => toast.error(`Could not open ${rel}: ${why}`)
  window.api.shell.open({ as: 'revealPath', path: absolutePath(cwd, rel) }).then(
    (res) => {
      if (!res.ok) fail(res.error ?? 'unknown error')
    },
    (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
  )
}

const TAG_CLASS: Record<MdFixKind, string> = {
  duplicate: 'bg-honey text-bg-hi',
  'broken-link': 'bg-accent text-bg-hi',
  orphan: 'bg-rule-inner text-fg-dim',
}

/** The FIX LIST card: one row per fix, ranked; hovering a row reports its index. */
export function MdFixList({
  cwd,
  rows,
  hovered,
  onHover,
}: {
  cwd?: string | null
  rows: readonly MdFixRow[]
  hovered: number | null
  onHover: (index: number | null) => void
}) {
  return (
    <section
      data-testid="md-fix-list"
      aria-label="Fix list"
      className="w-full min-w-0 overflow-hidden rounded-xl border border-rule-structural bg-bg-hi"
    >
      <div className="flex justify-between px-4 py-3 font-mono text-[10.5px] text-fg-faint">
        <span className="tracking-[.1em]">FIX LIST</span>
        <span data-testid="md-fix-count">{rows.length}</span>
      </div>
      {rows.length === 0 && (
        <p data-testid="md-fix-empty" className="m-0 border-t border-bg-elev px-4 py-3 text-[12.5px] text-fg-faint">
          No duplicated text, broken links or orphan docs.
        </p>
      )}
      {rows.map((r, i) => (
        <div
          key={r.key}
          data-testid="md-fix-row"
          data-type={r.kind}
          onMouseEnter={() => onHover(i)}
          onMouseLeave={() => onHover(null)}
          className={`flex flex-col gap-1.5 border-t border-bg-elev px-4 py-3 ${hovered === i ? 'bg-bg-elev' : ''}`}
        >
          <div className="flex items-center gap-2">
            <span
              data-testid="md-fix-type"
              className={`rounded px-[7px] py-[3px] font-mono text-[10px] font-bold tracking-[.04em] ${TAG_CLASS[r.kind]}`}
            >
              {r.kind}
            </span>
            <span className="min-w-0 flex-1" />
            <button
              type="button"
              data-testid="md-fix-open"
              disabled={!cwd}
              onClick={() => {
                if (cwd) openRow(cwd, r.open)
              }}
              className="min-w-0 text-right text-[12px] font-semibold text-accent-dark [overflow-wrap:anywhere] cursor-pointer hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {openLabel(r)}
            </button>
          </div>
          <span data-testid="md-fix-where" className="font-mono [overflow-wrap:anywhere] text-[11.5px] text-fg">
            {r.where}
          </span>
          <span data-testid="md-fix-detail" className="text-[12.5px] leading-[1.45] text-fg-dim">
            {r.detail}
          </span>
        </div>
      ))}
    </section>
  )
}
