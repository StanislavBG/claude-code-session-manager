/**
 * Real (never fabricated) context inventory for the New Epic "advanced"
 * grounding board — every row is backed by an actual file/dir read or a
 * value already tracked by an existing store, grouped the same way Claude
 * Code itself layers config: System (`~/.claude/`) < Project (`<cwd>/`,
 * checked in) < Local (`<cwd>/`, gitignored/per-machine). Read-only: the app
 * has no mechanism to make the `claude` CLI skip a file it would otherwise
 * discover, so this board is an inspector, not a control — see
 * NewEpicCard.tsx's grounding board for the UI that renders it.
 */

import { CLAUDE_MD_SCOPES, SETTINGS_SCOPES } from './scopes'

export interface GroundingItem {
  name: string
  detail: string
  /** Rough token estimate (chars/4), in thousands, 1 decimal. 0 when absent. */
  tokK: number
  present: boolean
  locked?: boolean
}

export interface GroundingGroup {
  key: 'system' | 'project' | 'local'
  label: string
  path: string
  items: GroundingItem[]
}

function estTokK(text: string): number {
  return Math.round((text.length / 4 / 1000) * 10) / 10
}

async function fileItem(path: string, name: string, presentDetail: (lines: number) => string): Promise<GroundingItem> {
  const res = await window.api.config.readText(path)
  if (!res.exists) return { name, detail: 'not present', tokK: 0, present: false }
  const lines = res.text ? res.text.split('\n').length : 0
  return { name, detail: presentDetail(lines), tokK: estTokK(res.text), present: true }
}

async function dirCountItem(path: string, name: string, noun: string): Promise<GroundingItem> {
  const res = await window.api.config.listDir(path, { dirsOnly: true })
  const count = res.ok ? res.entries.length : 0
  if (!res.ok || count === 0) return { name, detail: `no ${noun} installed`, tokK: 0, present: false }
  return { name, detail: `${count} installed`, tokK: estTokK(res.entries.map((e) => e.name).join(' ')) + 0.1 * count, present: true }
}

function countHookRules(rawText: string): number {
  try {
    const parsed = JSON.parse(rawText) as { hooks?: Record<string, unknown> }
    const hooks = parsed.hooks ?? {}
    return Object.values(hooks).reduce((n: number, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0)
  } catch {
    return 0
  }
}

export interface GroundingBoardInput {
  home: string
  cwd: string
  /** Absolute path to the selected Agent Library persona's .md file, if any. */
  agentPersonaPath: string | null
  agentPersonaName: string | null
  /** Real counts already available client-side — no extra IPC needed. */
  openTerminalTabsInProject: number
  otherEpicsInProject: number
}

export async function computeGroundingBoard(input: GroundingBoardInput): Promise<GroundingGroup[]> {
  const { home, cwd, agentPersonaPath, agentPersonaName, openTerminalTabsInProject, otherEpicsInProject } = input
  const userClaudeMdPath = CLAUDE_MD_SCOPES.resolve('user', home, null)!
  const userSettingsPath = SETTINGS_SCOPES.resolve('user', home, null)!
  const projectClaudeMdPath = CLAUDE_MD_SCOPES.resolve('project', home, cwd)!
  const localClaudeMdPath = CLAUDE_MD_SCOPES.resolve('local', home, cwd)!
  const projectSettingsPath = SETTINGS_SCOPES.resolve('project', home, cwd)!

  const [
    userClaudeMd,
    userSettingsText,
    userSkills,
    personaFile,
    projectClaudeMd,
    projectSkills,
    userClaudeJson,
    projectSettingsText,
    briefPresent,
    localClaudeMd,
    branch,
  ] = await Promise.all([
    fileItem(userClaudeMdPath, 'CLAUDE.md', (n) => `global preferences · ${n} lines`),
    window.api.config.readText(userSettingsPath),
    dirCountItem(`${home}/.claude/skills`, 'skills/', 'skills'),
    agentPersonaPath ? window.api.config.readText(agentPersonaPath) : Promise.resolve(null),
    fileItem(projectClaudeMdPath, 'CLAUDE.md', (n) => `${n} lines`),
    dirCountItem(`${cwd}/.claude/skills`, '.claude/skills/', 'skills'),
    window.api.config.readJson(`${home}/.claude.json`),
    window.api.config.readText(projectSettingsPath),
    window.api.config.exists(`${cwd}/session-manager-operations/project-brief/brief.json`),
    fileItem(localClaudeMdPath, 'CLAUDE.local.md', (n) => `personal notes · ${n} lines`),
    window.api.app.gitBranch(cwd),
  ])

  const mcpServers = (userClaudeJson.data as { mcpServers?: Record<string, unknown> } | null)?.mcpServers ?? {}
  const mcpCount = Object.keys(mcpServers).length
  const hookCount = countHookRules(projectSettingsText.text)

  const system: GroundingGroup = {
    key: 'system',
    label: 'System',
    path: '~/.claude/',
    items: [
      userClaudeMd,
      { name: 'settings.json', detail: userSettingsText.exists ? 'model, permissions, output style' : 'not present', tokK: userSettingsText.exists ? estTokK(userSettingsText.text) : 0, present: userSettingsText.exists },
      userSkills,
      personaFile
        ? { name: `agents/${agentPersonaName}.md`, detail: 'system prompt for the selected role · required', tokK: estTokK(personaFile.text), present: personaFile.exists, locked: true }
        : { name: 'agents/*.md', detail: 'no agent selected — default persona', tokK: 0, present: false },
    ],
  }

  const project: GroundingGroup = {
    key: 'project',
    label: 'Project',
    path: `${cwd}/`,
    items: [
      projectClaudeMd,
      projectSkills,
      mcpCount > 0
        ? { name: `mcp servers · ${mcpCount}`, detail: Object.keys(mcpServers).slice(0, 3).join(', '), tokK: 0.2 * mcpCount, present: true }
        : { name: 'mcp servers', detail: 'none configured', tokK: 0, present: false },
      hookCount > 0
        ? { name: `hooks · ${hookCount}`, detail: 'from .claude/settings.json', tokK: 0.1 * hookCount, present: true }
        : { name: 'hooks', detail: 'none configured', tokK: 0, present: false },
      { name: 'Project brief', detail: briefPresent ? 'LLM-maintained scope + conventions' : 'not generated yet', tokK: briefPresent ? 2.0 : 0, present: briefPresent },
    ],
  }

  const local: GroundingGroup = {
    key: 'local',
    label: 'Local',
    path: `${cwd}/ · this machine only`,
    items: [
      localClaudeMd,
      { name: 'working tree', detail: branch ? `⎇ ${branch}` : 'not a git repo', tokK: 0, present: Boolean(branch) },
      openTerminalTabsInProject > 0
        ? { name: `open Terminal tabs · ${openTerminalTabsInProject}`, detail: 'other tabs on this project', tokK: 0, present: true }
        : { name: 'open Terminal tabs', detail: 'none open right now', tokK: 0, present: false },
      otherEpicsInProject > 0
        ? { name: `other Epics · ${otherEpicsInProject}`, detail: 'proposed/active in this project', tokK: 0, present: true }
        : { name: 'other Epics', detail: 'none yet in this project', tokK: 0, present: false },
    ],
  }

  return [system, project, local]
}
