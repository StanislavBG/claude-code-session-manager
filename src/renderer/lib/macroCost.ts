// Decides whether pressing a macro needs a credit-cost confirmation, from the
// resolved agent persona's effort. Pure; the launch path owns the confirm UI.
import type { AgentPersona, Macro } from '../../preload/api';

export const HIGH_COST_EFFORTS = ['xhigh', 'max'] as const;

export function macroCostWarning(
  macro: Pick<Macro, 'label' | 'agentName'>,
  persona: Pick<AgentPersona, 'model' | 'effort'> | undefined,
): string | null {
  if (!persona || !persona.effort) return null;
  if (!(HIGH_COST_EFFORTS as readonly string[]).includes(persona.effort)) return null;
  const model = persona.model ?? 'the default model';
  return `"${macro.label}" runs ${macro.agentName} on ${model} at ${persona.effort} effort, which can use a large share of your Claude usage. Continue?`;
}
