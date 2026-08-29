/**
 * Context Injections — Session-Manager-authored prompt content, distinct
 * from the AIM framework's "Input" axis (groundingBoard.ts): Input is a
 * passive, real-file inventory (never composed text); a Context Injection is
 * text Session-Manager itself contributes to the opening prompt, independent
 * of which Agent persona or Mission tag was chosen. Each one is an
 * independent on/off toggle, surfaced in the New Epic card's "advanced"
 * grounding board — not folded silently into Actor or Mission.
 */

export interface ContextInjectionDef {
  key: string
  label: string
  description: string
  text: string
}

export const CONTEXT_INJECTIONS = {
  'general-behavior': {
    key: 'general-behavior',
    label: 'General behaviour',
    description:
      'Universal working-style rules for every Epic, independent of which Agent persona or ' +
      'Mission tag is chosen — the floor every session stands on, including Epics created ' +
      'before any persona resolved.',
    text:
      'Work concisely: lead with the answer or the result, skip preamble, and don\'t recap what ' +
      'you just did unless asked. Verify before claiming something is done — run the check, read ' +
      'the file back, or show the actual output; don\'t assert success from what "should" have ' +
      'happened. Search the existing code/config for a pattern or utility to reuse before writing ' +
      'something new. Ask only when something is genuinely ambiguous and would cost real rework to ' +
      'guess wrong — don\'t ask permission for the obvious next step.',
  },
  'delegate-implementation': {
    key: 'delegate-implementation',
    label: 'Delegate implementation',
    description:
      'Keeps this interactive session in a planning-and-deciding role and pushes actual ' +
      'implementation to the headless scheduler, independent of which Agent persona is chosen — ' +
      'the same floor as General behaviour, on by default for feature/bug work.',
    text:
      'This interactive session plans and decides; it does not implement. Once scope is clear, ' +
      'queue the implementation as scheduled PRDs via the /develop skill and let it run headless — ' +
      'do not edit application source inline in this conversation. If the scheduler tools are ' +
      'unavailable, say so explicitly rather than falling back to implementing the work yourself.',
  },
} as const satisfies Record<string, ContextInjectionDef>

export type ContextInjectionKey = keyof typeof CONTEXT_INJECTIONS

/** Insertion order for every toggle-list/table in the UI. */
export const CONTEXT_INJECTION_ORDER: ContextInjectionKey[] = Object.keys(CONTEXT_INJECTIONS) as ContextInjectionKey[]
