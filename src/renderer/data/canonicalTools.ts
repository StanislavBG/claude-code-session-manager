/**
 * Canonical Claude Code tool names recognized in subagent frontmatter
 * `tools:` / `disallowedTools:` allowlists.
 *
 * Source: docs/en/tools verified 2026-05. MCP tools (`mcp__<server>__<tool>`)
 * are NOT in this list — the Subagents picker accepts free text for those and
 * flags unrecognized values with an "unrecognized" chip so users still get
 * round-trip preservation via `agentFrontmatter`'s extras band.
 */
export const CANONICAL_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoWrite',
  'ExitPlanMode',
  'EnterPlanMode',
  'KillBash',
  'BashOutput',
  'McpResources',
  'McpTools',
  'RemoteControl',
] as const

export type CanonicalTool = (typeof CANONICAL_TOOLS)[number]

const CANONICAL_SET: ReadonlySet<string> = new Set(CANONICAL_TOOLS)

export function isCanonicalTool(name: string): boolean {
  return CANONICAL_SET.has(name)
}
