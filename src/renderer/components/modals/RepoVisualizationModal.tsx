import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  RepoAnalyzeError,
  RepoAnalyzeResult,
} from '../../../preload/api.d'
import { useSessions } from '../../state/sessions'

/**
 * RepoVisualizationModal — port of ClaudeCodeUnleashed's RepoVisualization
 * onto our existing files/git IPC surface plus the new repo:analyze handler.
 *
 * Surfaces 3 visualizations (all plain SVG / Tailwind div — no d3 dep):
 *   1. Language breakdown — horizontal bar per language (file count + lines).
 *   2. Top-N directories — treemap-style boxes sized by sqrt(fileCount) so a
 *      monolith dir doesn't squash the rest off-screen.
 *   3. Uncommitted-file badge — count + branch label from git:status.
 *
 * Lifecycle:
 *   - Auto-analyze on open, idempotent re-run on Refresh.
 *   - Cancel-by-unmount safe: pending invoke just gets dropped when the modal
 *     closes (the main-process handler still completes, but the renderer no
 *     longer has the listener).
 *
 * Complexity: O(L + D) per render where L = languages.length, D = top dirs
 *   (≤10). Both bounded by the analyzer's caps so no batching needed.
 */

interface RepoVisualizationModalProps {
  open: boolean
  onClose: () => void
}

// Per-language colour. Stays in lockstep with LANG_LABELS in
// repoAnalyzer.cjs — keys are extension w/o leading dot.
const LANG_COLORS: Record<string, string> = {
  ts: '#3178c6',
  tsx: '#61dafb',
  js: '#f7df1e',
  jsx: '#61dafb',
  cjs: '#f7df1e',
  mjs: '#f7df1e',
  json: '#5d5d5d',
  css: '#264de4',
  scss: '#cd6799',
  less: '#1d365d',
  html: '#e34c26',
  md: '#083fa1',
  mdx: '#083fa1',
  py: '#3776ab',
  go: '#00add8',
  rs: '#dea584',
  java: '#b07219',
  kt: '#a97bff',
  c: '#555555',
  cpp: '#f34b7d',
  cc: '#f34b7d',
  h: '#555555',
  hpp: '#f34b7d',
  swift: '#fa7343',
  rb: '#cc342d',
  php: '#4f5d95',
  sql: '#e38c00',
  sh: '#89e051',
  bash: '#89e051',
  zsh: '#89e051',
  yaml: '#cb171e',
  yml: '#cb171e',
  toml: '#9c4221',
  xml: '#0060ac',
  svg: '#ff9900',
  vue: '#41b883',
  svelte: '#ff3e00',
  other: '#6b7280',
}

const LANG_DISPLAY: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TSX',
  js: 'JavaScript',
  jsx: 'JSX',
  cjs: 'CommonJS',
  mjs: 'ES Module',
  json: 'JSON',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  html: 'HTML',
  md: 'Markdown',
  mdx: 'MDX',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  c: 'C',
  cpp: 'C++',
  cc: 'C++',
  h: 'C/C++ Header',
  hpp: 'C++ Header',
  swift: 'Swift',
  rb: 'Ruby',
  php: 'PHP',
  sql: 'SQL',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  svg: 'SVG',
  vue: 'Vue',
  svelte: 'Svelte',
  other: 'Other',
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

export function RepoVisualizationModal({ open, onClose }: RepoVisualizationModalProps) {
  const activeTab = useSessions((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null)
  const cwd = activeTab?.cwd ?? null

  const [analysis, setAnalysis] = useState<RepoAnalyzeResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  const analyze = useCallback(async (target: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.repo.analyze(target)
      if (result.ok) {
        setAnalysis(result)
      } else {
        setError((result as RepoAnalyzeError).error || 'Analysis failed')
        setAnalysis(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setAnalysis(null)
    } finally {
      setLoading(false)
    }
  }, [])

  // Auto-analyze on open + when active tab cwd changes. We don't run on every
  // re-render — only on the open transition and on cwd change.
  useEffect(() => {
    if (!open) return
    if (!cwd) {
      setError('No active session — open a tab in a folder first.')
      return
    }
    analyze(cwd)
  }, [open, cwd, analyze])

  // Escape closes. Re-attached when `open` changes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    // Focus the dialog so the keyboard handler sees the event.
    dialogRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const handleRefresh = useCallback(() => {
    if (cwd) analyze(cwd)
  }, [cwd, analyze])

  // Languages sorted by file count desc, top 12.
  const topLanguages = useMemo(() => {
    if (!analysis) return [] as Array<[string, number, number]>
    const entries = Object.entries(analysis.languageBreakdown)
      .map(([k, v]) => [k, v.files, v.lines] as [string, number, number])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
    return entries
  }, [analysis])

  const maxLangFiles = useMemo(() => {
    if (topLanguages.length === 0) return 1
    return topLanguages[0][1]
  }, [topLanguages])

  // Treemap layout: each box gets a sqrt-scaled area so a single dominant
  // dir doesn't squish the rest. We use flexbox with explicit flex-basis,
  // not a pixel-precise treemap algorithm — good enough for at-a-glance.
  const treemapBoxes = useMemo(() => {
    if (!analysis) return [] as Array<{
      path: string
      fileCount: number
      totalLines: number
      basis: number
    }>
    const dirs = analysis.topDirectories
    if (dirs.length === 0) return []
    const sqrts = dirs.map((d) => Math.sqrt(Math.max(1, d.fileCount)))
    const sumSqrt = sqrts.reduce((a, b) => a + b, 0) || 1
    return dirs.map((d, i) => ({
      path: d.path,
      fileCount: d.fileCount,
      totalLines: d.totalLines,
      basis: (sqrts[i] / sumSqrt) * 100,
    }))
  }, [analysis])

  if (!open) return null

  const onBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  const folderName = cwd ? (cwd.split('/').filter(Boolean).pop() || cwd) : 'no folder'

  const node = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onBackdrop}
      data-testid="repoviz-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Repository Visualization"
        tabIndex={-1}
        className="bg-bg-elev border border-line rounded-lg shadow-xl w-[900px] max-w-[95vw] max-h-[85vh] flex flex-col outline-none"
        data-testid="repoviz-dialog"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-lg" aria-hidden>🗺</span>
            <div className="min-w-0">
              <h2 className="text-base font-medium text-fg leading-tight">Repository Visualization</h2>
              <div className="text-xs text-fg-dim truncate" title={cwd ?? ''}>
                {folderName}
                {analysis?.gitStatus.branch && (
                  <span className="ml-2 font-mono text-fg-faint">({analysis.gitStatus.branch})</span>
                )}
                {analysis?.truncated && (
                  <span className="ml-2 text-amber-400">truncated</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {analysis && analysis.gitStatus.uncommitted > 0 && (
              <span
                className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-[11px] font-mono"
                title={`${analysis.gitStatus.uncommitted} uncommitted files`}
              >
                {analysis.gitStatus.uncommitted} uncommitted
              </span>
            )}
            <button
              type="button"
              onClick={handleRefresh}
              disabled={loading || !cwd}
              className="px-2 py-1 rounded text-fg-dim hover:bg-bg-hi hover:text-fg text-xs disabled:opacity-40 disabled:cursor-not-allowed"
              title="Re-run analysis"
            >
              {loading ? '…' : '↻'} Refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-2 py-1 rounded text-fg-dim hover:bg-bg-hi hover:text-fg text-xs"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {loading && !analysis ? (
            <div className="flex flex-col items-center justify-center py-16 text-fg-dim">
              <div className="text-3xl mb-3 animate-pulse" aria-hidden>⟳</div>
              <div className="text-sm">Analyzing repository…</div>
              <div className="text-xs text-fg-faint mt-1">Walking files, counting lines, reading git status</div>
            </div>
          ) : error ? (
            <div className="py-16 text-center">
              <div className="text-3xl mb-3 text-red-400" aria-hidden>⚠</div>
              <div className="text-sm text-red-400">{error}</div>
            </div>
          ) : analysis ? (
            <>
              {/* Quick stats */}
              <div className="grid grid-cols-3 gap-3">
                <StatCard label="Files" value={formatNumber(analysis.totalFiles)} />
                <StatCard label="Lines of code" value={formatNumber(analysis.totalLines)} />
                <StatCard
                  label="Uncommitted"
                  value={String(analysis.gitStatus.uncommitted)}
                  tone={analysis.gitStatus.uncommitted > 0 ? 'warn' : 'neutral'}
                />
              </div>

              {/* Language breakdown */}
              <section>
                <h3 className="text-xs uppercase tracking-wider text-fg-faint mb-2">Languages</h3>
                {topLanguages.length === 0 ? (
                  <div className="text-xs text-fg-dim">No files detected.</div>
                ) : (
                  <div className="space-y-1.5">
                    {topLanguages.map(([key, files, lines]) => {
                      const color = LANG_COLORS[key] ?? LANG_COLORS.other
                      const label = LANG_DISPLAY[key] ?? key
                      const widthPct = (files / maxLangFiles) * 100
                      return (
                        <div key={key} className="flex items-center gap-2 text-xs">
                          <span className="w-24 text-fg-dim truncate" title={label}>{label}</span>
                          <div className="flex-1 h-4 bg-bg rounded overflow-hidden">
                            <div
                              className="h-full rounded"
                              style={{ width: `${widthPct}%`, backgroundColor: color }}
                            />
                          </div>
                          <span className="w-16 text-right text-fg-dim font-mono">{files} files</span>
                          <span className="w-20 text-right text-fg-faint font-mono">{formatNumber(lines)} L</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>

              {/* Top directories treemap */}
              <section>
                <h3 className="text-xs uppercase tracking-wider text-fg-faint mb-2">Top directories</h3>
                {treemapBoxes.length === 0 ? (
                  <div className="text-xs text-fg-dim">No directories.</div>
                ) : (
                  <div className="flex flex-wrap gap-1 min-h-[140px]">
                    {treemapBoxes.map((d) => (
                      <div
                        key={d.path}
                        className="relative rounded bg-bg-hi border border-line hover:border-accent transition-colors cursor-default flex flex-col justify-end p-2 min-w-[80px] min-h-[60px]"
                        style={{
                          flexBasis: `${Math.max(d.basis, 6)}%`,
                          flexGrow: d.basis > 15 ? 1 : 0,
                        }}
                        title={`${d.path} — ${d.fileCount} files, ${d.totalLines.toLocaleString()} lines`}
                      >
                        <div className="text-[11px] font-mono text-fg truncate">{d.path}</div>
                        <div className="text-[10px] text-fg-dim font-mono">
                          {d.fileCount} files
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Footer meta */}
              <div className="text-[10px] text-fg-faint text-right">
                Analyzed in {analysis.durationMs}ms
                {analysis.truncated && ' — stopped early (5000-file cap or 30s timeout)'}
              </div>
            </>
          ) : (
            <div className="py-16 text-center text-fg-dim text-sm">
              No analysis yet. Click Refresh.
            </div>
          )}
        </div>
      </div>
    </div>
  )

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(node, document.body)
  }
  return node
}

function StatCard({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'warn'
}) {
  const valueClass = tone === 'warn' ? 'text-amber-400' : 'text-fg'
  return (
    <div className="bg-bg-hi/40 border border-line rounded-lg p-3">
      <div className={`text-xl font-medium ${valueClass}`}>{value}</div>
      <div className="text-xs text-fg-dim mt-0.5">{label}</div>
    </div>
  )
}

export default RepoVisualizationModal
