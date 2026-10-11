/** Last path segment of `p`, splitting on `/` and `\`; trailing separators are ignored. */
export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}
