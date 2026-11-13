/**
 * Cross-boundary parity: the renderer's agent-CLI display labels
 * (src/renderer/lib/agentCliCatalog.ts) must equal the `label` fields of main's
 * AGENT_CLI_CATALOG (src/main/lib/agent-cli/agentCliRegistry.cjs). Imports both
 * modules directly — no source-text reading.
 *
 * Run: timeout 300 npx vitest run tests/unit/agentCliCatalog-crossBoundary.spec.ts
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { AGENT_CLI_LABELS, agentCliLabel } from '../../src/renderer/lib/agentCliCatalog'

const require = createRequire(import.meta.url)
const { AGENT_CLI_CATALOG } = require('../../src/main/lib/agent-cli/agentCliRegistry.cjs') as {
  AGENT_CLI_CATALOG: Record<string, { label: string }>
}

describe('agentCliCatalog renderer ↔ main parity', () => {
  it('AGENT_CLI_LABELS equals the main catalog id → label map', () => {
    const expected = Object.fromEntries(Object.entries(AGENT_CLI_CATALOG).map(([id, e]) => [id, e.label]))
    expect(AGENT_CLI_LABELS).toEqual(expected)
  })

  it('agentCliLabel is null for absent or claude, and labels a known id', () => {
    expect(agentCliLabel(undefined)).toBeNull()
    expect(agentCliLabel('claude')).toBeNull()
    expect(agentCliLabel('codex')).toBe('Codex')
  })
})
