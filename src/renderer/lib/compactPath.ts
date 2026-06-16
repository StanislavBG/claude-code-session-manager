export function compactPath(p: string): string {
  const home = '/home/'
  if (p.startsWith(home)) {
    const tail = p.slice(home.length).split('/').slice(1).join('/')
    return tail ? `~/${tail}` : '~'
  }
  return p
}
