/**
 * Renderer listener for phone-initiated "start a Session" requests. Main has
 * already validated the payload; this just runs it through launchSession, the
 * same path a desktop macro press takes. Separate from state/chat.ts because
 * launchSession imports useChat (registering there would be an import cycle).
 */
import { launchSession } from './launchSession'
import { toast } from '../state/toast'

export function registerRemoteNewSession(): () => void {
  return window.api.chat.onExternalNewSession(async ({ cwd, agentName, tag, title, prompt, macroId }) => {
    try {
      let agentDescription: string | undefined
      try {
        const personas = await window.api.agents.listPersonas()
        agentDescription = personas.find((p) => p.name === agentName)?.description ?? undefined
      } catch {
        // persona lookup is best-effort; a thinner opening prompt beats no session
      }
      let isJob = false
      if (macroId) {
        try {
          isJob = !!(await window.api.macros.list()).find((m) => m.id === macroId)?.job
        } catch {
          // macro lookup is best-effort; fall back to the chat path
        }
      }
      const marker = '\n\nAdditional instructions: '
      const at = prompt.indexOf(marker)
      const extra = isJob && at >= 0 ? prompt.slice(at + marker.length) : ''
      await launchSession({
        cwd, agentName, tag, title, goal: prompt, agentDescription, source: 'WebRemote ' + agentName,
        ...(macroId ? { macroId } : {}),
        ...(isJob ? { run: 'job' as const } : {}),
        ...(extra ? { extraInstructions: extra } : {}),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Phone session start failed: ${msg}`)
      window.api?.logs?.write('webRemote', 'warn', `phone session start failed for ${agentName} in ${cwd}: ${msg}`)
    }
  })
}
