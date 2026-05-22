const EXT_TO_LANG: Record<string, string> = {
  json: 'json', ts: 'typescript', tsx: 'typescript', js: 'javascript',
  jsx: 'javascript', cjs: 'javascript', mjs: 'javascript', py: 'python',
  sh: 'shell', bash: 'shell', yaml: 'yaml', yml: 'yaml', toml: 'ini',
  css: 'css', html: 'html', xml: 'xml', sql: 'sql', rs: 'rust', go: 'go',
  md: 'markdown', markdown: 'markdown',
}

const BASENAME_TO_LANG: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
}

export function getLanguageForPath(path: string): string | null {
  const base = path.split('/').pop() ?? path
  if (BASENAME_TO_LANG[base]) return BASENAME_TO_LANG[base]
  const dot = base.lastIndexOf('.')
  if (dot === -1) return null
  const ext = base.slice(dot + 1)
  return EXT_TO_LANG[ext] ?? null
}
