/**
 * Detect / fill literal `<token>` placeholders in an MCP server config.
 *
 * Catalog entries ship placeholders like `--db-path <path>`; writing one
 * verbatim makes every Claude CLI start launch the server with the literal
 * string (sqlite then creates a 0-byte file named `<path>` in the cwd).
 */

export interface McpConfigLike {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
}

export interface Placeholder {
  /** The token including angle brackets, e.g. `<path>`. */
  token: string
  /** Where it sits, for form labels: `--db-path <path>`, `env KEY`, `url`, `command`. */
  label: string
}

const TOKEN_RE = /<[A-Za-z][A-Za-z0-9_-]*>/g
const HAS_TOKEN_RE = /<[A-Za-z][A-Za-z0-9_-]*>/

function tokensIn(s: string): string[] {
  return s.match(TOKEN_RE) ?? []
}

/** Every placeholder occurrence (repeats included). O(total config length). */
export function findPlaceholders(config: McpConfigLike): Placeholder[] {
  const out: Placeholder[] = []
  const add = (s: string | undefined, label: string) => {
    if (typeof s !== 'string') return
    for (const token of tokensIn(s)) out.push({ token, label })
  }
  add(config.command, 'command')
  const args = Array.isArray(config.args) ? config.args : []
  args.forEach((a, i) => {
    if (typeof a !== 'string') return
    const prev = args[i - 1]
    // A bare-token arg after a flag reads best as `--flag <token>`.
    const label = i > 0 && typeof prev === 'string' && prev.startsWith('-') && !HAS_TOKEN_RE.test(prev) ? `${prev} ${a}` : a
    add(a, label)
  })
  for (const [k, v] of Object.entries(config.env ?? {})) add(v, `env ${k}`)
  add(config.url, 'url')
  return out
}

/** Distinct tokens, first-seen order, with the label of the first occurrence. */
export function distinctPlaceholders(config: McpConfigLike): Placeholder[] {
  const seen = new Map<string, Placeholder>()
  for (const p of findPlaceholders(config)) if (!seen.has(p.token)) seen.set(p.token, p)
  return [...seen.values()]
}

/** New config with each token replaced by `values[token]` (unknown tokens left as-is). */
export function fillPlaceholders<T extends McpConfigLike>(config: T, values: Record<string, string>): T {
  const sub = (s: string) => s.replace(TOKEN_RE, (t) => (Object.prototype.hasOwnProperty.call(values, t) ? values[t] : t))
  const next: T = { ...config }
  if (typeof next.command === 'string') next.command = sub(next.command)
  if (Array.isArray(next.args)) next.args = next.args.map((a) => (typeof a === 'string' ? sub(a) : a))
  if (next.env) next.env = Object.fromEntries(Object.entries(next.env).map(([k, v]) => [k, typeof v === 'string' ? sub(v) : v]))
  if (typeof next.url === 'string') next.url = sub(next.url)
  return next
}
