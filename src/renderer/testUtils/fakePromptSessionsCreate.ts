import { vi } from 'vitest'
import type { PromptSession } from '../state/promptSessions'

/** Mirrors main's ensureEpic()/epicMint.cjs id-minting shape (`<slug>-<uuid8>`)
 *  closely enough for tests to assert against — the real mint is a main-
 *  process fs write component/store tests never exercise. */
function slugifyForTest(text: string): string {
  return (
    String(text || 'epic')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'epic'
  )
}

/** Shared window.api.promptSessions.create mock for every test that mints an
 *  Epic through createPromptSession (PRD 954/the async conversion) — returns
 *  a schema-shaped { epicId, session } response without a real main process. */
export function fakePromptSessionsCreate() {
  return vi.fn(
    async ({
      cwd,
      goalText,
      tag,
      agentType,
    }: {
      cwd: string
      goalText: string
      tag?: PromptSession['tag']
      agentType?: string
    }) => {
      const epicId = `${slugifyForTest(goalText)}-${crypto.randomUUID().slice(0, 8)}`
      const now = new Date().toISOString()
      const session: PromptSession = {
        id: epicId,
        cwd,
        goalText,
        claudeSessionId: crypto.randomUUID(),
        status: 'proposed',
        createdAt: now,
        completedAt: null,
        ...(tag ? { tag } : {}),
        ...(agentType ? { agentType } : {}),
      }
      return { epicId, session }
    },
  )
}
