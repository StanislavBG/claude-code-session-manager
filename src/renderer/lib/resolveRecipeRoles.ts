import type { Recipe } from '../../preload/api'
import { parseAgentFile } from './agentFrontmatter'
import type { AgentDef } from './useAgentNames'

export interface ResolvedRole {
  label: string
  prompt: string
}

export interface ResolveResult {
  roles: ResolvedRole[]
  missing: string[]
}

/**
 * Pure resolver: maps a Recipe + known agents + async body-reader → resolved roles.
 *
 * For each step, looks up the agent by name, reads its .md file, strips the
 * frontmatter, then concatenates: agentBody + step.note + recipe.brief.
 * Returns `missing` for any step whose agent file could not be read, so the
 * caller can block launch.
 *
 * Injecting `readBody` (rather than calling window.api directly) keeps this
 * function pure so the unit smoke can run without Electron.
 */
export async function resolveRecipeRoles(
  recipe: Recipe,
  agents: AgentDef[],
  readBody: (path: string) => Promise<string | null>,
): Promise<ResolveResult> {
  const byName = new Map<string, AgentDef>(agents.map((a) => [a.name, a]))
  const missing: string[] = []
  const roles: ResolvedRole[] = []

  for (const step of recipe.steps) {
    const agent = byName.get(step.agentName)
    if (!agent) {
      if (!missing.includes(step.agentName)) missing.push(step.agentName)
      continue
    }

    const text = await readBody(agent.path)
    if (text === null) {
      if (!missing.includes(step.agentName)) missing.push(step.agentName)
      continue
    }

    const agentBody = parseAgentFile(text).body

    const parts: string[] = [agentBody]
    if (step.note) parts.push(`\n\n## Task note\n${step.note}`)
    if (recipe.brief) parts.push(`\n\n## Shared brief\n${recipe.brief}`)

    roles.push({ label: step.agentName, prompt: parts.join('') })
  }

  return { roles, missing }
}
