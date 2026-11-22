import { describe, expect, it } from 'vitest'
import {
  HOME_CLAUDE_CONFIG_TABS, NAV_GROUP_BY_KEY, NAV_ITEMS, NAV_KEY_ALIASES,
  getNavItemsForFace, isHomeOnlyNavKey, resolveNavAlias,
} from '../navGroups'
import { SCREEN_KEYS } from '../screenKeys'

const RETIRED = ['system-prompt', 'settings', 'extensions', 'agent-library'] as const

describe('Home Claude config nav entry', () => {
  it('Home face lists one Claude config row in the Claude Code group', () => {
    const item = getNavItemsForFace('home').find((i) => i.key === 'claude-config')
    expect(item).toMatchObject({
      group: 'Claude Code',
      label: 'Claude config',
      hint: 'Your ~/.claude — CLAUDE.md, settings, MCP, skills, plugins, agents',
      faces: ['home'],
    })
  })

  it.each(RETIRED)('%s is no longer a sidebar row', (key) => {
    expect(NAV_ITEMS.some((i) => i.key === key)).toBe(false)
  })

  it('claude-config is a registered screen', () => {
    expect(SCREEN_KEYS).toContain('claude-config')
  })

  it('tabs are CLAUDE.md, Settings, MCP, Skills, Plugins, Agents in order', () => {
    expect(HOME_CLAUDE_CONFIG_TABS.map((t) => t.label)).toEqual(['CLAUDE.md', 'Settings', 'MCP', 'Skills', 'Plugins', 'Agents'])
  })
})

describe('retired keys alias onto Claude config', () => {
  it('maps each retired key to its tab', () => {
    expect(NAV_KEY_ALIASES).toEqual({
      'system-prompt': 'claude-md', settings: 'settings', extensions: 'skills', 'agent-library': 'agents',
    })
  })

  it.each([
    ['system-prompt', undefined, 'claude-md'],
    ['settings', undefined, 'settings'],
    ['settings', 'hooks', 'settings:hooks'],
    ['extensions', undefined, 'skills'],
    ['extensions', 'mcp', 'mcp'],
    ['extensions', 'plugins', 'plugins'],
    ['agent-library', undefined, 'agents'],
  ] as const)('resolveNavAlias(%s, %s) opens claude-config on %s', (id, tab, want) => {
    expect(resolveNavAlias(id, tab)).toEqual({ id: 'claude-config', tab: want })
  })

  it('passes a non-alias id through unchanged', () => {
    expect(resolveNavAlias('app-settings', 'voice')).toEqual({ id: 'app-settings', tab: 'voice' })
  })

  it.each(RETIRED)('%s stays home-only and in the Claude Code group', (key) => {
    expect(isHomeOnlyNavKey(key)).toBe(true)
    expect(NAV_GROUP_BY_KEY[key]).toBe('Claude Code')
  })
})
