/** Shorten `p` to `~/…` when it is the home dir or inside it; otherwise return it unchanged. */
export function compactPath(p: string, home: string | null): string {
  if (!home) return p
  const base = home.length > 1 ? home.replace(/\/+$/, '') : home
  if (p === base) return '~'
  const prefix = base.endsWith('/') ? base : `${base}/`
  return p.startsWith(prefix) ? `~/${p.slice(prefix.length)}` : p
}
