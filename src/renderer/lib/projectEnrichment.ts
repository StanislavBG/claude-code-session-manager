export interface ProjectDetails {
  name?: string
  gitRemote?: string
  lastBranch?: string
  claudemdPreview?: string
}

export async function enrichProject(cwd: string): Promise<ProjectDetails> {
  const out: ProjectDetails = {}

  // package.json → name
  try {
    const r = await window.api.config.readJson(`${cwd}/package.json`)
    if (r.exists && r.data) {
      const name = (r.data as Record<string, unknown>).name
      if (typeof name === 'string') out.name = name
    }
  } catch {}

  // .git/config → remote origin URL
  try {
    const r = await window.api.config.readText(`${cwd}/.git/config`)
    if (r.exists && r.text) {
      const m = r.text.match(/\[remote "origin"\][^\[]*url\s*=\s*([^\n]+)/)
      if (m) {
        let url = m[1].trim()
        // Normalize ssh and https forms to host/path
        url = url
          .replace(/^git@([^:]+):/, '$1/')
          .replace(/\.git$/, '')
          .replace(/^https?:\/\//, '')
        out.gitRemote = url
      }
    }
  } catch {}

  // .git/HEAD → current branch name
  try {
    const r = await window.api.config.readText(`${cwd}/.git/HEAD`)
    if (r.exists && r.text) {
      const m = r.text.match(/ref: refs\/heads\/(.+)/)
      if (m) out.lastBranch = m[1].trim()
    }
  } catch {}

  // CLAUDE.md → first 200 chars preview
  try {
    const r = await window.api.config.readText(`${cwd}/CLAUDE.md`)
    if (r.exists && r.text) out.claudemdPreview = r.text.slice(0, 200)
  } catch {}

  // Name fallback: last path segment
  if (!out.name) {
    const parts = cwd.split('/')
    out.name = parts[parts.length - 1] || cwd
  }

  return out
}
