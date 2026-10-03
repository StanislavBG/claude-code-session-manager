import { describe, expect, it } from 'vitest'
import { AGENT_TAG_DEFS } from '../agentTagDefs'

describe('AGENT_TAG_DEFS feature/bug templates', () => {
  it('point at /develop and never instruct inline end-to-end implementation', () => {
    for (const tag of ['feature', 'bug'] as const) {
      const template = AGENT_TAG_DEFS[tag].initialPromptTemplate
      if (!template.includes('/develop') || template.includes('implement it end-to-end')) {
        throw new Error(
          `AGENT_TAG_DEFS.${tag}.initialPromptTemplate must reference /develop and must not ` +
            `contain "implement it end-to-end"`,
        )
      }
    }
  })
})

// Regression guard: this template must work on a machine that only has the
// npm package installed (no session-manager source repo on disk) — it must
// drive the MCP contract, never a repo-relative path, and must never fall
// back to hand-rolling the pipeline via /develop.
const FORBIDDEN_REPO_PATH_SUBSTRINGS = [
  'session-manager-operations/architecture/',
  '.claude/agents/',
  'session-manager-operations/design-mocks/',
  'scripts/',
  'npm run build:project-pages',
]

describe('AGENT_TAG_DEFS project-home-builder template', () => {
  it('no repo-relative paths, never falls back to /develop, and defers the artifact and write tool to the persona', () => {
    const template = AGENT_TAG_DEFS['project-home-builder'].initialPromptTemplate
    for (const forbidden of FORBIDDEN_REPO_PATH_SUBSTRINGS) {
      expect(template).not.toContain(forbidden)
    }
    expect(template).not.toContain('/develop')
  })

  it('is artifact-agnostic: defers the exact artifact and write tool to the Actor persona', () => {
    const template = AGENT_TAG_DEFS['project-home-builder'].initialPromptTemplate
    expect(template).not.toContain('project_home_write')
    expect(template).not.toContain('home.html')
    expect(template).toContain('persona')
  })
})
