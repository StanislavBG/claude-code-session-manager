import { sepOf } from './pathSep'

/** Shorten `p` to `~/…` (or `~\…` on Windows) when it is the home dir or inside it; otherwise return it unchanged. */
export function compactPath(p: string, home: string | null): string {
  if (!home) return p
  const sep = sepOf(home)
  const base = home.length > 1 ? home.replace(/[\\/]+$/, '') : home
  if (p === base) return '~'
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  return p.startsWith(prefix) ? `~${sep}${p.slice(prefix.length)}` : p
}
