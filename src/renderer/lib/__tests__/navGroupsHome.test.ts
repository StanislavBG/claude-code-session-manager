import { describe, expect, it } from 'vitest'
import { NAV_ITEMS, getNavItemsForFace } from '../navGroups'
import type { NavFace } from '../navFace'

const VALID_FACES: NavFace[] = ['home', 'project']

describe('navGroups Home swap', () => {
  it('first Workspace item is overview labeled Dashboard', () => {
    const workspace = NAV_ITEMS.filter((item) => item.group === 'Workspace')
    expect(workspace[0]?.key).toBe('overview')
    expect(workspace[0]?.label).toBe('Dashboard')
  })

  it('project-home is labeled Project Home', () => {
    const item = NAV_ITEMS.find((i) => i.key === 'project-home')
    expect(item?.label).toBe('Project Home')
  })
})

describe('getNavItemsForFace', () => {
  const HOME_ONLY = ['overview', 'browser', 'plugins', 'keybindings', 'remote', 'sm-config', 'voice', 'agent-library', 'tag-library']
  const PROJECT_ONLY = ['project-home', 'repoviz', 'search', 'memory', 'terminal']
  const BOTH = [
    'scheduler', 'history', 'system-prompt', 'skills', 'mcp', 'hooks',
    'permissions', 'settings', 'projects',
  ]

  it('home face returns home-only + both keys', () => {
    const keys = getNavItemsForFace('home').map((item) => item.key)
    expect(new Set(keys)).toEqual(new Set([...HOME_ONLY, ...BOTH]))
  })

  it('project face returns project-only + both keys', () => {
    const keys = getNavItemsForFace('project').map((item) => item.key)
    expect(new Set(keys)).toEqual(new Set([...PROJECT_ONLY, ...BOTH]))
  })

  it('preserves NAV_ITEMS group order (Workspace, Configure, Tools)', () => {
    const homeKeys = getNavItemsForFace('home').map((item) => item.key)
    const allKeysInOrder = NAV_ITEMS.map((item) => item.key)
    const expected = allKeysInOrder.filter((k) => homeKeys.includes(k))
    expect(homeKeys).toEqual(expected)
  })
})

describe('overview (Dashboard) is home-only', () => {
  it('NAV_ITEMS tags overview with faces: [home]', () => {
    const item = NAV_ITEMS.find((i) => i.key === 'overview')
    expect(item?.faces).toEqual(['home'])
  })

  it('project face excludes overview', () => {
    const keys = getNavItemsForFace('project').map((item) => item.key)
    expect(keys).not.toContain('overview')
  })

  it('home face includes overview', () => {
    const keys = getNavItemsForFace('home').map((item) => item.key)
    expect(keys).toContain('overview')
  })
})

describe('project-home is project-only', () => {
  it('NAV_ITEMS tags project-home with faces: [project]', () => {
    const item = NAV_ITEMS.find((i) => i.key === 'project-home')
    expect(item?.faces).toEqual(['project'])
  })

  it('home face excludes project-home', () => {
    const keys = getNavItemsForFace('home').map((item) => item.key)
    expect(keys).not.toContain('project-home')
  })

  it('project face includes project-home', () => {
    const keys = getNavItemsForFace('project').map((item) => item.key)
    expect(keys).toContain('project-home')
  })
})

describe('browser is home-only', () => {
  it('NAV_ITEMS tags browser with faces: [home]', () => {
    const item = NAV_ITEMS.find((i) => i.key === 'browser')
    expect(item?.faces).toEqual(['home'])
  })

  it('project face excludes browser', () => {
    const keys = getNavItemsForFace('project').map((item) => item.key)
    expect(keys).not.toContain('browser')
  })

  it('home face includes browser', () => {
    const keys = getNavItemsForFace('home').map((item) => item.key)
    expect(keys).toContain('browser')
  })
})

describe('plugins is home-only', () => {
  it('NAV_ITEMS tags plugins with faces: [home]', () => {
    const item = NAV_ITEMS.find((i) => i.key === 'plugins')
    expect(item?.faces).toEqual(['home'])
  })

  it('project face excludes plugins', () => {
    const keys = getNavItemsForFace('project').map((item) => item.key)
    expect(keys).not.toContain('plugins')
  })

  it('home face includes plugins', () => {
    const keys = getNavItemsForFace('home').map((item) => item.key)
    expect(keys).toContain('plugins')
  })
})

describe('keybindings is home-only', () => {
  it('NAV_ITEMS tags keybindings with faces: [home]', () => {
    const item = NAV_ITEMS.find((i) => i.key === 'keybindings')
    expect(item?.faces).toEqual(['home'])
  })

  it('project face excludes keybindings', () => {
    const keys = getNavItemsForFace('project').map((item) => item.key)
    expect(keys).not.toContain('keybindings')
  })

  it('home face includes keybindings', () => {
    const keys = getNavItemsForFace('home').map((item) => item.key)
    expect(keys).toContain('keybindings')
  })
})

describe('projects (File Explorer) is a BOTH-face screen', () => {
  // Reachable from both sidebars — its starting root folder differs by
  // face at render time (ProjectsWorkspace.tsx), not by hiding the row.
  it('NAV_ITEMS tags projects with faces: [home, project]', () => {
    const item = NAV_ITEMS.find((i) => i.key === 'projects')
    expect(item?.faces).toEqual(['home', 'project'])
  })

  it('home face includes projects', () => {
    const keys = getNavItemsForFace('home').map((item) => item.key)
    expect(keys).toContain('projects')
  })

  it('project face includes projects', () => {
    const keys = getNavItemsForFace('project').map((item) => item.key)
    expect(keys).toContain('projects')
  })
})

describe('terminal (Epics) is project-only', () => {
  it('NAV_ITEMS tags terminal with faces: [project]', () => {
    const item = NAV_ITEMS.find((i) => i.key === 'terminal')
    expect(item?.faces).toEqual(['project'])
  })

  it('home face excludes terminal', () => {
    const keys = getNavItemsForFace('home').map((item) => item.key)
    expect(keys).not.toContain('terminal')
  })

  it('project face includes terminal', () => {
    const keys = getNavItemsForFace('project').map((item) => item.key)
    expect(keys).toContain('terminal')
  })
})

describe('memory is project-only', () => {
  it('NAV_ITEMS tags memory with faces: [project]', () => {
    const item = NAV_ITEMS.find((i) => i.key === 'memory')
    expect(item?.faces).toEqual(['project'])
  })

  it('home face excludes memory', () => {
    const keys = getNavItemsForFace('home').map((item) => item.key)
    expect(keys).not.toContain('memory')
  })

  it('project face includes memory', () => {
    const keys = getNavItemsForFace('project').map((item) => item.key)
    expect(keys).toContain('memory')
  })
})

describe('remote is home-only', () => {
  it('NAV_ITEMS tags remote with faces: [home]', () => {
    const item = NAV_ITEMS.find((i) => i.key === 'remote')
    expect(item?.faces).toEqual(['home'])
  })

  it('project face excludes remote', () => {
    const keys = getNavItemsForFace('project').map((item) => item.key)
    expect(keys).not.toContain('remote')
  })

  it('home face includes remote', () => {
    const keys = getNavItemsForFace('home').map((item) => item.key)
    expect(keys).toContain('remote')
  })
})

describe('sm-config is home-only', () => {
  it('NAV_ITEMS tags sm-config with faces: [home]', () => {
    const item = NAV_ITEMS.find((i) => i.key === 'sm-config')
    expect(item?.faces).toEqual(['home'])
  })

  it('project face excludes sm-config', () => {
    const keys = getNavItemsForFace('project').map((item) => item.key)
    expect(keys).not.toContain('sm-config')
  })

  it('home face includes sm-config', () => {
    const keys = getNavItemsForFace('home').map((item) => item.key)
    expect(keys).toContain('sm-config')
  })
})

describe('voice is home-only', () => {
  it('NAV_ITEMS tags voice with faces: [home]', () => {
    const item = NAV_ITEMS.find((i) => i.key === 'voice')
    expect(item?.faces).toEqual(['home'])
  })

  it('project face excludes voice', () => {
    const keys = getNavItemsForFace('project').map((item) => item.key)
    expect(keys).not.toContain('voice')
  })

  it('home face includes voice', () => {
    const keys = getNavItemsForFace('home').map((item) => item.key)
    expect(keys).toContain('voice')
  })
})

describe('repoviz is project-only', () => {
  it('NAV_ITEMS tags repoviz with faces: [project]', () => {
    const item = NAV_ITEMS.find((i) => i.key === 'repoviz')
    expect(item?.faces).toEqual(['project'])
  })

  it('home face excludes repoviz', () => {
    const keys = getNavItemsForFace('home').map((item) => item.key)
    expect(keys).not.toContain('repoviz')
  })

  it('project face includes repoviz', () => {
    const keys = getNavItemsForFace('project').map((item) => item.key)
    expect(keys).toContain('repoviz')
  })
})

describe('search is project-only', () => {
  it('NAV_ITEMS tags search with faces: [project]', () => {
    const item = NAV_ITEMS.find((i) => i.key === 'search')
    expect(item?.faces).toEqual(['project'])
  })

  it('home face excludes search', () => {
    const keys = getNavItemsForFace('home').map((item) => item.key)
    expect(keys).not.toContain('search')
  })

  it('project face includes search', () => {
    const keys = getNavItemsForFace('project').map((item) => item.key)
    expect(keys).toContain('search')
  })
})

describe('NAV_ITEMS face-coverage invariant', () => {
  it('every NAV_ITEMS entry has a non-empty faces array', () => {
    for (const item of NAV_ITEMS) {
      expect(item.faces.length).toBeGreaterThan(0)
    }
  })

  it('every face value is a valid NavFace', () => {
    for (const item of NAV_ITEMS) {
      for (const face of item.faces) {
        expect(VALID_FACES).toContain(face)
      }
    }
  })

  it('home + project faces together cover every NAV_ITEMS key', () => {
    const homeKeys = getNavItemsForFace('home').map((item) => item.key)
    const projectKeys = getNavItemsForFace('project').map((item) => item.key)
    const covered = new Set([...homeKeys, ...projectKeys])
    const allKeys = NAV_ITEMS.map((item) => item.key)
    expect(covered).toEqual(new Set(allKeys))
  })
})
