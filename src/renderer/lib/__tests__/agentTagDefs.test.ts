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
