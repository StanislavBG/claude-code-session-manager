import { useEffect, useRef, useState } from 'react'
import { toast } from '../../../state/toast'

/**
 * Plugins Discover — static catalog of the 23 first-party plugins shipped on
 * the official marketplace (`claude-plugins-official`). Hardcoded because the
 * renderer CSP locks `connect-src` and the marketplace catalog at
 * https://claude.com/plugins is not bundled into Claude Code installs.
 *
 * Install path: window.api.plugins.install fires a hidden pty running
 * `claude plugin install <slug>`. Output streams below the row. Exit code 0
 * marks the plugin as installed locally; non-zero raises a toast.
 *
 * Source: .research/2026-05-14-cycle2/04-anthropic-deep.md §1 + §4.
 */

export type PluginKind = 'lsp' | 'mcp'

export interface PluginDescriptor {
  slug: string
  name: string
  kind: PluginKind
  description: string
}

// 11 LSP plugins + 12 MCP integrations = 23 first-party plugins.
export const FIRST_PARTY_PLUGINS: PluginDescriptor[] = [
  // LSP plugins (language servers must be on $PATH).
  { slug: 'clangd-lsp', name: 'clangd-lsp', kind: 'lsp', description: 'C/C++ diagnostics via clangd. Requires clangd on $PATH.' },
  { slug: 'csharp-lsp', name: 'csharp-lsp', kind: 'lsp', description: 'C# diagnostics. Requires OmniSharp or Roslyn LSP on $PATH.' },
  { slug: 'gopls-lsp', name: 'gopls-lsp', kind: 'lsp', description: 'Go diagnostics via gopls. Requires gopls on $PATH.' },
  { slug: 'jdtls-lsp', name: 'jdtls-lsp', kind: 'lsp', description: 'Java diagnostics via Eclipse JDT LS. Requires jdtls on $PATH.' },
  { slug: 'kotlin-lsp', name: 'kotlin-lsp', kind: 'lsp', description: 'Kotlin diagnostics. Requires kotlin-language-server on $PATH.' },
  { slug: 'lua-lsp', name: 'lua-lsp', kind: 'lsp', description: 'Lua diagnostics. Requires lua-language-server on $PATH.' },
  { slug: 'php-lsp', name: 'php-lsp', kind: 'lsp', description: 'PHP diagnostics. Requires intelephense or phpactor on $PATH.' },
  { slug: 'pyright-lsp', name: 'pyright-lsp', kind: 'lsp', description: 'Python diagnostics via pyright. Requires pyright-langserver on $PATH.' },
  { slug: 'rust-analyzer-lsp', name: 'rust-analyzer-lsp', kind: 'lsp', description: 'Rust diagnostics via rust-analyzer. Requires rust-analyzer on $PATH.' },
  { slug: 'swift-lsp', name: 'swift-lsp', kind: 'lsp', description: 'Swift diagnostics via sourcekit-lsp. Requires sourcekit-lsp on $PATH.' },
  { slug: 'typescript-lsp', name: 'typescript-lsp', kind: 'lsp', description: 'TypeScript/JavaScript diagnostics. Requires typescript-language-server on $PATH.' },
  // External-integration MCP plugins (no extra binaries needed; auth varies).
  { slug: 'github', name: 'github', kind: 'mcp', description: 'GitHub PRs, issues, gh-style flows.' },
  { slug: 'gitlab', name: 'gitlab', kind: 'mcp', description: 'GitLab MRs, issues, pipelines.' },
  { slug: 'atlassian', name: 'atlassian', kind: 'mcp', description: 'Jira / Confluence search and updates.' },
  { slug: 'asana', name: 'asana', kind: 'mcp', description: 'Asana task and project ops.' },
  { slug: 'linear', name: 'linear', kind: 'mcp', description: 'Linear issue tracking — pairs with the Tasks tab.' },
  { slug: 'notion', name: 'notion', kind: 'mcp', description: 'Notion document lookup and edits.' },
  { slug: 'figma', name: 'figma', kind: 'mcp', description: 'Figma file inspection for UI work.' },
  { slug: 'vercel', name: 'vercel', kind: 'mcp', description: 'Vercel deploy diagnostics.' },
  { slug: 'firebase', name: 'firebase', kind: 'mcp', description: 'Firebase project + Firestore ops.' },
  { slug: 'supabase', name: 'supabase', kind: 'mcp', description: 'Supabase database operations.' },
  { slug: 'slack', name: 'slack', kind: 'mcp', description: 'Slack DM / channel posting from agents.' },
  { slug: 'sentry', name: 'sentry', kind: 'mcp', description: 'Sentry bug triage and event lookup.' },
]

interface InstallState {
  status: 'idle' | 'running' | 'success' | 'error'
  lines: string[]
  exitCode: number | null
}

const INITIAL: InstallState = { status: 'idle', lines: [], exitCode: null }

const MAX_LINES = 200

export function PluginsDiscover({
  installedSlugs,
  onInstalled,
}: {
  installedSlugs: Set<string>
  /** Called after a successful install so the parent can refresh its list. */
  onInstalled?: (slug: string) => void
}) {
  const [query, setQuery] = useState('')
  const [filterKind, setFilterKind] = useState<'all' | PluginKind>('all')
  const [installs, setInstalls] = useState<Record<string, InstallState>>({})
  const installsRef = useRef(installs)
  installsRef.current = installs

  // Subscribe once to progress events; route by slug.
  useEffect(() => {
    const off = window.api.plugins.onInstallProgress(({ slug, line }) => {
      setInstalls((prev) => {
        const cur = prev[slug] ?? INITIAL
        const nextLines = [...cur.lines, line]
        if (nextLines.length > MAX_LINES) nextLines.splice(0, nextLines.length - MAX_LINES)
        return { ...prev, [slug]: { ...cur, status: 'running', lines: nextLines } }
      })
    })
    return () => {
      off()
    }
  }, [])

  const runInstall = async (slug: string) => {
    setInstalls((prev) => ({ ...prev, [slug]: { status: 'running', lines: [], exitCode: null } }))
    try {
      const r = await window.api.plugins.install({ slug })
      setInstalls((prev) => {
        const cur = prev[slug] ?? INITIAL
        return {
          ...prev,
          [slug]: {
            status: r.ok ? 'success' : 'error',
            lines: cur.lines,
            exitCode: r.exitCode,
          },
        }
      })
      if (r.ok) {
        onInstalled?.(slug)
      } else {
        toast.error(`Install failed: ${slug} (exit ${r.exitCode})${r.error ? ` — ${r.error}` : ''}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setInstalls((prev) => ({
        ...prev,
        [slug]: { status: 'error', lines: prev[slug]?.lines ?? [], exitCode: -1 },
      }))
      toast.error(`Install error: ${slug} — ${msg}`)
    }
  }

  const filtered = FIRST_PARTY_PLUGINS.filter((p) => {
    if (filterKind !== 'all' && p.kind !== filterKind) return false
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
  })

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line text-xs">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter…"
          aria-label="Filter plugins"
          className="px-2 py-0.5 bg-bg-elev border border-line rounded text-fg w-48"
        />
        <div className="flex rounded border border-line overflow-hidden">
          {(['all', 'lsp', 'mcp'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setFilterKind(k)}
              className={`px-2 py-0.5 ${
                filterKind === k ? 'bg-bg-hi text-fg' : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
              }`}
            >
              {k}
            </button>
          ))}
        </div>
        <span className="text-fg-faint ml-2">
          {filtered.length} / {FIRST_PARTY_PLUGINS.length}
        </span>
        <div className="flex-1" />
        <span className="text-fg-faint font-mono truncate">claude-plugins-official</span>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        <ul className="divide-y divide-line">
          {filtered.map((p) => {
            const state = installs[p.slug] ?? INITIAL
            const isInstalled = installedSlugs.has(p.slug)
            const disabled = state.status === 'running' || isInstalled
            return (
              <li key={p.slug} className="px-3 py-2 text-xs">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-fg">{p.name}</span>
                      <span className="text-fg-faint font-mono">{p.kind}</span>
                      {isInstalled ? (
                        <span className="text-fg-faint">· installed</span>
                      ) : null}
                    </div>
                    <div className="text-fg-dim mt-0.5">{p.description}</div>
                  </div>
                  <button
                    onClick={() => runInstall(p.slug)}
                    disabled={disabled}
                    className={`px-2 py-0.5 rounded border border-line text-xs ${
                      disabled
                        ? 'text-fg-faint bg-bg-elev cursor-not-allowed'
                        : 'text-fg bg-bg-elev hover:bg-bg-hi'
                    }`}
                    aria-label={`Install ${p.name}`}
                  >
                    {isInstalled
                      ? 'installed'
                      : state.status === 'running'
                        ? 'installing…'
                        : state.status === 'success'
                          ? 'done'
                          : state.status === 'error'
                            ? 'retry'
                            : 'install'}
                  </button>
                </div>
                {state.lines.length > 0 ? (
                  <pre className="mt-2 max-h-40 overflow-auto bg-bg-elev border border-line rounded p-2 text-fg-faint font-mono text-[11px] whitespace-pre-wrap">
                    {state.lines.join('\n')}
                    {state.status !== 'running' && state.exitCode !== null
                      ? `\n[exit ${state.exitCode}]`
                      : ''}
                  </pre>
                ) : null}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
