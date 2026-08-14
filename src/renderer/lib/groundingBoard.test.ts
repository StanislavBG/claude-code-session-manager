// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computeGroundingBoard } from './groundingBoard'

function installApi(overrides: {
  readText?: Record<string, { exists: boolean; text: string }>
  listDir?: Record<string, { ok: boolean; entries: Array<{ name: string }> }>
  readJson?: Record<string, unknown>
  exists?: Record<string, boolean>
  branch?: string | null
  worktreeDisabled?: boolean
  omitPromptSessions?: boolean
} = {}) {
  const readText = vi.fn(async (path: string) => {
    const hit = overrides.readText?.[path]
    return { exists: Boolean(hit?.exists), text: hit?.text ?? '', mtimeMs: 0, error: null }
  })
  const listDir = vi.fn(async (path: string) => {
    const hit = overrides.listDir?.[path]
    return { ok: hit ? hit.ok : true, entries: hit?.entries ?? [], error: null }
  })
  const readJson = vi.fn(async (path: string) => ({
    exists: true, raw: '', data: overrides.readJson?.[path] ?? null, parseError: null, mtimeMs: 0, error: null,
  }))
  const exists = vi.fn(async (path: string) => overrides.exists?.[path] ?? false)
  ;(window as unknown as { api: unknown }).api = {
    config: { readText, listDir, readJson, exists },
    app: { gitBranch: vi.fn(async () => overrides.branch ?? null) },
    ...(overrides.omitPromptSessions
      ? {}
      : {
          promptSessions: {
            getWorktreeDisabled: vi.fn(async () => ({ disabled: overrides.worktreeDisabled ?? false })),
          },
        }),
  }
}

beforeEach(() => {
  installApi()
})

describe('computeGroundingBoard', () => {
  it('returns system/project/local groups in order', async () => {
    const groups = await computeGroundingBoard({
      home: '/home/bilko',
      cwd: '/home/bilko/Projects/alpha',
      agentPersonaPath: null,
      agentPersonaName: null,
      openTerminalTabsInProject: 0,
      otherEpicsInProject: 0,
    })
    expect(groups.map((g) => g.key)).toEqual(['system', 'project', 'local'])
  })

  it('marks a present CLAUDE.md with real line count and an absent one as not present', async () => {
    installApi({
      readText: {
        '/home/bilko/.claude/CLAUDE.md': { exists: true, text: `${'x'.repeat(2000)}\nline2\nline3` },
      },
    })
    const groups = await computeGroundingBoard({
      home: '/home/bilko',
      cwd: '/home/bilko/Projects/alpha',
      agentPersonaPath: null,
      agentPersonaName: null,
      openTerminalTabsInProject: 0,
      otherEpicsInProject: 0,
    })
    const system = groups.find((g) => g.key === 'system')!
    const claudeMd = system.items.find((i) => i.name === 'CLAUDE.md')!
    expect(claudeMd.present).toBe(true)
    expect(claudeMd.detail).toContain('3 lines')
    expect(claudeMd.tokK).toBeGreaterThan(0)

    const project = groups.find((g) => g.key === 'project')!
    const projClaudeMd = project.items.find((i) => i.name === 'CLAUDE.md')!
    expect(projClaudeMd.present).toBe(false)
  })

  it('marks the selected persona file as locked and required', async () => {
    installApi({
      readText: { '/home/bilko/.claude/agents/builder.md': { exists: true, text: 'You are the builder.' } },
    })
    const groups = await computeGroundingBoard({
      home: '/home/bilko',
      cwd: '/home/bilko/Projects/alpha',
      agentPersonaPath: '/home/bilko/.claude/agents/builder.md',
      agentPersonaName: 'builder',
      openTerminalTabsInProject: 0,
      otherEpicsInProject: 0,
    })
    const system = groups.find((g) => g.key === 'system')!
    const personaRow = system.items.find((i) => i.name === 'agents/builder.md')!
    expect(personaRow.locked).toBe(true)
    expect(personaRow.present).toBe(true)
  })

  it('reports real open-tab and other-epic counts passed in, never fabricated', async () => {
    const groups = await computeGroundingBoard({
      home: '/home/bilko',
      cwd: '/home/bilko/Projects/alpha',
      agentPersonaPath: null,
      agentPersonaName: null,
      openTerminalTabsInProject: 2,
      otherEpicsInProject: 3,
    })
    const local = groups.find((g) => g.key === 'local')!
    expect(local.items.find((i) => i.name.startsWith('open Terminal tabs'))?.name).toBe('open Terminal tabs · 2')
    expect(local.items.find((i) => i.name.startsWith('other Epics'))?.name).toBe('other Epics · 3')
  })

  it('reports Epic isolation as present when the project is a git repo and the toggle is off', async () => {
    installApi({ branch: 'main', worktreeDisabled: false })
    const groups = await computeGroundingBoard({
      home: '/home/bilko',
      cwd: '/home/bilko/Projects/alpha',
      agentPersonaPath: null,
      agentPersonaName: null,
      openTerminalTabsInProject: 0,
      otherEpicsInProject: 0,
    })
    const local = groups.find((g) => g.key === 'local')!
    const item = local.items.find((i) => i.name === 'Epic isolation')!
    expect(item.present).toBe(true)
    expect(item.detail).toContain('sm-epic')
  })

  it('reports Epic isolation as not present when the per-project toggle disables it', async () => {
    installApi({ branch: 'main', worktreeDisabled: true })
    const groups = await computeGroundingBoard({
      home: '/home/bilko',
      cwd: '/home/bilko/Projects/alpha',
      agentPersonaPath: null,
      agentPersonaName: null,
      openTerminalTabsInProject: 0,
      otherEpicsInProject: 0,
    })
    const local = groups.find((g) => g.key === 'local')!
    const item = local.items.find((i) => i.name === 'Epic isolation')!
    expect(item.present).toBe(false)
    expect(item.detail).toBe('disabled for this project')
  })

  it('reports Epic isolation as not present when the project is not a git repo', async () => {
    installApi({ branch: null })
    const groups = await computeGroundingBoard({
      home: '/home/bilko',
      cwd: '/home/bilko/Projects/alpha',
      agentPersonaPath: null,
      agentPersonaName: null,
      openTerminalTabsInProject: 0,
      otherEpicsInProject: 0,
    })
    const local = groups.find((g) => g.key === 'local')!
    const item = local.items.find((i) => i.name === 'Epic isolation')!
    expect(item.present).toBe(false)
    expect(item.detail).toContain('not a git repo')
  })

  it('degrades to "enabled" without throwing when window.api has no promptSessions surface at all', async () => {
    installApi({ branch: 'main', omitPromptSessions: true })
    const groups = await computeGroundingBoard({
      home: '/home/bilko',
      cwd: '/home/bilko/Projects/alpha',
      agentPersonaPath: null,
      agentPersonaName: null,
      openTerminalTabsInProject: 0,
      otherEpicsInProject: 0,
    })
    const local = groups.find((g) => g.key === 'local')!
    expect(local.items.find((i) => i.name === 'Epic isolation')?.present).toBe(true)
  })
})
