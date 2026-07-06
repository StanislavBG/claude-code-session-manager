import type { NavKey } from '../components/LeftNav'

const SLASH_NAV_COMMANDS: Record<string, NavKey> = {
  mcp: 'mcp',
  permissions: 'permissions',
  hooks: 'hooks',
  memory: 'memory',
  agents: 'subagents',
  subagents: 'subagents',
  skills: 'skills',
  plugins: 'plugins',
  usage: 'usage',
  cost: 'usage',
  config: 'settings',
  model: 'settings',
  settings: 'settings',
  history: 'history',
  resume: 'history',
  keybindings: 'keybindings',
  scheduler: 'scheduler',
}

export function matchSlashNav(input: string): NavKey | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const command = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase()
  if (!command) return null
  return SLASH_NAV_COMMANDS[command] ?? null
}
