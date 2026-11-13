/**
 * Display labels for the non-Claude agent CLIs an Epic may run under
 * (PromptSession.agentCli). Mirrors the `label` fields of AGENT_CLI_CATALOG in
 * src/main/lib/agent-cli/agentCliRegistry.cjs — kept in step by
 * tests/unit/agentCliCatalog-crossBoundary.spec.ts.
 */
export type AgentCliId = 'codex' | 'gemini' | 'antigravity' | 'cursor' | 'opencode'

export const AGENT_CLI_LABELS: Record<AgentCliId, string> = {
  codex: 'Codex',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity CLI',
  cursor: 'Cursor Agent',
  opencode: 'OpenCode',
}

/** Label for an Epic's agentCli: null when absent or 'claude' (Claude Code);
 *  the raw id for an unknown value (a row written by a newer build). */
export function agentCliLabel(id?: string): string | null {
  if (!id || id === 'claude') return null
  return Object.prototype.hasOwnProperty.call(AGENT_CLI_LABELS, id) ? AGENT_CLI_LABELS[id as AgentCliId] : id
}
