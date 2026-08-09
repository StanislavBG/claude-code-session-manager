import { describe, it, expect } from 'vitest'
import {
  BUILD_RELEASE_GOAL_TEXT,
  BUILD_SETUP_GOAL_TEXT,
  buildActionDisabled,
  buildActionLabel,
  buildActionMode,
  buildActionTooltip,
  type BuildActionMode,
} from '../buildAction'

const base = { cwd: '/home/bilko/Projects/alpha', resolving: false, target: null, inFlight: null, creating: false }

describe('buildActionMode', () => {
  it('is unavailable with no active project tab', () => {
    expect(buildActionMode({ ...base, cwd: null })).toBe('unavailable')
  })

  it('is resolving until the target lookup answers — never a premature "setup"', () => {
    expect(buildActionMode({ ...base, resolving: true })).toBe('resolving')
  })

  it('is resolving while an Epic mint from a previous press is in flight', () => {
    expect(buildActionMode({ ...base, creating: true })).toBe('resolving')
  })

  it('is run when a target resolved', () => {
    expect(buildActionMode({ ...base, target: { packageName: 'foo' } })).toBe('run')
  })

  it('is setup — not disabled — when the lookup answered "no target"', () => {
    expect(buildActionMode(base)).toBe('setup')
  })

  it('an in-flight build Epic outranks every other state, target or not', () => {
    expect(buildActionMode({ ...base, inFlight: { id: 'e1' } })).toBe('open')
    expect(buildActionMode({ ...base, inFlight: { id: 'e1' }, target: { packageName: 'foo' } })).toBe('open')
    expect(buildActionMode({ ...base, inFlight: { id: 'e1' }, resolving: true })).toBe('open')
  })
})

describe('buildActionDisabled', () => {
  it('only blocks when there is genuinely nothing to act on', () => {
    expect(buildActionDisabled('unavailable')).toBe(true)
    expect(buildActionDisabled('resolving')).toBe(true)
  })

  it('never disables the unconfigured case — that is the bootstrap affordance', () => {
    expect(buildActionDisabled('setup')).toBe(false)
    expect(buildActionDisabled('run')).toBe(false)
    expect(buildActionDisabled('open')).toBe(false)
  })
})

describe('buildActionLabel / buildActionTooltip', () => {
  it('labels each face distinctly', () => {
    expect(buildActionLabel('setup')).toBe('Set Up Build')
    expect(buildActionLabel('run')).toBe('Run Build')
    expect(buildActionLabel('open')).toBe('Open Build')
    expect(buildActionLabel('resolving')).toBe('Run Build')
    expect(buildActionLabel('unavailable')).toBe('Run Build')
  })

  it('every mode has a non-empty tooltip', () => {
    const modes: BuildActionMode[] = ['unavailable', 'resolving', 'open', 'run', 'setup']
    for (const m of modes) expect(buildActionTooltip(m).length).toBeGreaterThan(0)
  })

  it("the setup tooltip names the config file, so the mechanism isn't invisible", () => {
    expect(buildActionTooltip('setup')).toContain('session-manager-operations/architecture/build-target.json')
    expect(buildActionTooltip('setup')).toContain('.claude/agents/builder.md')
  })
})

describe('goal texts', () => {
  it('the release goal invokes the /builder release protocol', () => {
    expect(BUILD_RELEASE_GOAL_TEXT.startsWith('/builder')).toBe(true)
  })

  it('the bootstrap goal never invokes /builder — that would be the accidental publish', () => {
    expect(BUILD_SETUP_GOAL_TEXT).not.toContain('/builder\n')
    expect(BUILD_SETUP_GOAL_TEXT.startsWith('/')).toBe(false)
  })

  it('the bootstrap goal names both output files', () => {
    expect(BUILD_SETUP_GOAL_TEXT).toContain('session-manager-operations/architecture/build-target.json')
    expect(BUILD_SETUP_GOAL_TEXT).toContain('.claude/agents/builder.md')
  })

  it('the bootstrap probe covers every ecosystem marker plus the git history reads', () => {
    for (const probe of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Dockerfile', 'VERSION', 'CHANGELOG.md', 'git tag', 'git log', 'Makefile', '.github/workflows/']) {
      expect(BUILD_SETUP_GOAL_TEXT).toContain(probe)
    }
  })

  it('the bootstrap goal handles the zero-tags case the npm path has no analogue for', () => {
    expect(BUILD_SETUP_GOAL_TEXT).toContain('Zero tags')
    expect(BUILD_SETUP_GOAL_TEXT).toContain('<last-release-tag>..HEAD')
  })

  it('the bootstrap goal lets the overlay override inherited instructions by name', () => {
    expect(BUILD_SETUP_GOAL_TEXT).toContain('OVERRIDE')
    expect(BUILD_SETUP_GOAL_TEXT).toContain('worktree')
  })

  it('the bootstrap goal ends at a mandatory human gate — propose, never publish', () => {
    expect(BUILD_SETUP_GOAL_TEXT).toContain('do not publish')
    expect(BUILD_SETUP_GOAL_TEXT).toContain('human gate')
  })
})
