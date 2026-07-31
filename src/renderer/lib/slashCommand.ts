import type { NavKey } from '../components/LeftNav'

const SLASH_NAV_COMMANDS: Record<string, NavKey> = {
  mcp: 'mcp',
  permissions: 'permissions',
  hooks: 'hooks',
  memory: 'memory',
  skills: 'skills',
  plugins: 'plugins',
  usage: 'overview',
  cost: 'overview',
  config: 'settings',
  model: 'settings',
  settings: 'settings',
  history: 'history',
  resume: 'history',
  keybindings: 'keybindings',
  scheduler: 'scheduler',
  remote: 'remote',
  projects: 'projects',
  voice: 'voice',
  repoviz: 'repoviz',
  repo: 'repoviz',
  search: 'search',
  system: 'system-prompt',
}

export function matchSlashNav(input: string): NavKey | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const command = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase()
  if (!command) return null
  return SLASH_NAV_COMMANDS[command] ?? null
}

// True when `input` is a slash command that isn't one of our local nav
// shortcuts, meaning submit() will forward it verbatim to the headless
// `claude -p` chat runner. chatRunner spawns with stdin closed (by design —
// PRD 319), so any slash command whose flow needs real interactive input
// (an approval/consent prompt, a TUI selector) can't be answered there —
// only a real Terminal tab (pty.cjs) has a live TTY for that. Used to warn
// the user before sending, not to block the send (most slash commands still
// resolve fine as a single non-interactive turn).
export function isUnroutedSlashCommand(input: string): boolean {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return false
  const command = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase()
  if (!command) return false
  return matchSlashNav(input) === null
}

// The single decision point TerminalChat's submit() delegates to: whether an
// input navigates locally, warns-and-still-sends, or sends to the headless
// runner. Keeping this out of the component makes the branch unit-testable
// without a DOM (this repo has no jsdom) — the component just switches on it.
export type SubmitAction = { type: 'nav'; key: NavKey } | { type: 'warn-unrouted' } | { type: 'send' }

export function decideSubmitAction(input: string): SubmitAction {
  const navKey = matchSlashNav(input)
  if (navKey) return { type: 'nav', key: navKey }
  if (isUnroutedSlashCommand(input)) return { type: 'warn-unrouted' }
  return { type: 'send' }
}
