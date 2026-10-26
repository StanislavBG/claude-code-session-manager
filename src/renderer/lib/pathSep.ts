/** Separator-agnostic path helpers for the renderer ('/' and '\\', drive letters). */

/** Separator style of `p`: '\\' when it has a backslash and no forward slash (or a drive prefix), else '/'. */
export function sepOf(p: string): '/' | '\\' {
  if (/^[A-Za-z]:[\\/]/.test(p) && p.includes('\\')) return '\\'
  return p.includes('\\') && !p.includes('/') ? '\\' : '/'
}

/** Non-empty path segments (a drive letter like `C:` is kept as the first segment). */
export function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean)
}

export function basename(p: string): string {
  const s = segments(p)
  return s.length ? s[s.length - 1] : p
}

/** Parent directory, preserving separator style. '' when there is no parent separator. */
export function dirname(p: string): string {
  const trimmed = p.length > 1 ? p.replace(/[\\/]+$/, '') : p
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (i < 0) return ''
  if (i === 0) return trimmed.slice(0, 1) // root
  if (/^[A-Za-z]:$/.test(trimmed.slice(0, i))) return trimmed.slice(0, i + 1) // C:\
  return trimmed.slice(0, i)
}

/** Join using the first part's separator style; no doubled separators. */
export function join(...parts: string[]): string {
  const ps = parts.filter((p) => p !== '')
  if (!ps.length) return ''
  const sep = sepOf(ps[0])
  let out = ps[0]
  for (const part of ps.slice(1)) {
    out = out.replace(/[\\/]+$/, '') + sep + part.replace(/^[\\/]+/, '')
  }
  return out
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** True when `child` is strictly inside `parent` (separator-insensitive). */
export function isUnder(child: string, parent: string): boolean {
  return norm(child).startsWith(norm(parent) + '/')
}
