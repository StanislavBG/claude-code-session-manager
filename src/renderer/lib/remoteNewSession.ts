/**
 * Renderer listener for phone-initiated "start a Session" requests. Main has
 * already validated the payload; this just runs it through launchSession, the
 * same path a desktop macro press takes. Separate from state/chat.ts because
 * launchSession imports useChat (registering there would be an import cycle).
 */
import { launchSession } from './launchSession'
import { toast } from '../state/toast'
import type { ChatExternalNewSessionResult } from '../../preload/api'

/** Answer main's awaited request; a failed report is logged, never thrown into the handler. */
function report(result: ChatExternalNewSessionResult): void {
  Promise.resolve()
    .then(() => window.api.chat.reportExternalNewSessionResult(result))
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      window.api?.logs?.write('webRemote', 'warn', `external new-session result report failed for ${result.requestId}: ${msg}`)
    })
}

export function registerRemoteNewSession(): () => void {
  return window.api.chat.onExternalNewSession(async ({ cwd, agentName, tag, title, prompt, macroId, externalRef, requestId, via, startedBy, effort, reviewStage }) => {
    const isScript = via === 'script'
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
      // Only a scripted job press may ask for a review cut; the phone path never forwards it.
      const forwardReview = reviewStage === true && isScript && isJob
      const { epicId, entryId, slug, stage } = await launchSession({
        cwd, agentName, tag, title, goal: prompt, agentDescription,
        source: isScript ? `Script ${agentName}` : 'WebRemote ' + agentName,
        // A script-typed prompt must never enter humanPromptLedger as a verified human quote.
        ...(isScript ? { origin: 'external' as const } : {}),
        ...(macroId ? { macroId } : {}),
        ...(typeof externalRef === 'string' && externalRef ? { externalRef } : {}),
        ...(isJob ? { run: 'job' as const } : {}),
        ...(extra ? { extraInstructions: extra } : {}),
        ...(typeof effort === 'string' && effort ? { effort } : {}),
        ...(isScript && startedBy && typeof startedBy === 'object' ? { startedBy } : {}),
        ...(forwardReview ? { reviewStage: true } : {}),
      })
      if (requestId) {
        report({
          requestId, ok: true, epicId,
          ...(entryId ? { entryId } : {}),
          ...(slug ? { slug } : {}),
          ...(stage !== undefined ? { stage } : {}),
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // main's chatExternalNewSessionResult caps error at 500; an over-long report is rejected and the caller times out.
      if (requestId) report({ requestId, ok: false, error: msg.slice(0, 500) })
      const label = isScript ? 'Script' : 'Phone'
      toast.error(`${label} session start failed: ${msg}`)
      window.api?.logs?.write('webRemote', 'warn', `${label.toLowerCase()} session start failed for ${agentName} in ${cwd}: ${msg}`)
    }
  })
}
