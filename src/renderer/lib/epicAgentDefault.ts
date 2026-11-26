/**
 * Per-project "last picked Agent" for the New Session card. Stored in the
 * project's ui-prefs file (`lastEpicAgent`); written by NewEpicCard only.
 */
import type { AgentPersona } from '../../preload/api'
import { readUiPrefs, writeUiPrefsPatch } from './uiPrefs'

const FALLBACK_AGENT = 'architect'

/** lastAgent if it still exists in the library, else architect, else the first persona, else ''. */
export function pickDefaultEpicAgent(
  agents: AgentPersona[] | null,
  lastAgent: string | null | undefined,
): string {
  if (!agents || agents.length === 0) return ''
  if (lastAgent && agents.some((a) => a.name === lastAgent)) return lastAgent
  if (agents.some((a) => a.name === FALLBACK_AGENT)) return FALLBACK_AGENT
  return agents[0].name
}

export async function readLastEpicAgent(cwd: string): Promise<string | null> {
  if (!cwd) return null
  try {
    const v = (await readUiPrefs(cwd)).lastEpicAgent as unknown
    return typeof v === 'string' && v !== '' ? v : null
  } catch {
    return null
  }
}

export async function rememberEpicAgent(cwd: string, name: string): Promise<void> {
  if (!cwd || !name) return
  await writeUiPrefsPatch(cwd, { lastEpicAgent: name })
}
