// Decides whether pressing a macro needs a credit-cost notice, from the resolved
// agent persona's effort, and which lower efforts the human may pick instead.
// Pure; the launch path owns the prompt UI via state/macroCostPrompt.ts.
import type { AgentPersona, Macro } from '../../preload/api';

export const HIGH_COST_EFFORTS = ['xhigh', 'max'] as const;

export interface MacroCostNotice {
  message: string;
  model: string | null;
  effort: string;
}

export function macroCostNotice(
  macro: Pick<Macro, 'label' | 'agentName'>,
  persona: Pick<AgentPersona, 'model' | 'effort'> | undefined,
): MacroCostNotice | null {
  if (!persona || !persona.effort) return null;
  if (!(HIGH_COST_EFFORTS as readonly string[]).includes(persona.effort)) return null;
  const model = persona.model ?? null;
  const shown = model ?? 'the default model';
  return {
    message: `"${macro.label}" runs ${macro.agentName} on ${shown} at ${persona.effort} effort, which can use a large share of your Claude usage.`,
    model,
    effort: persona.effort,
  };
}

const NON_LEVELS = new Set(['inherit', 'auto']);

/** Concrete efforts strictly below `effort` in `levels` order. When `effort` is
 *  not a known level, every concrete level that is not high-cost. */
export function lowerEffortOptions(effort: string, levels: readonly string[]): string[] {
  const concrete = levels.filter((l) => !NON_LEVELS.has(l));
  const idx = concrete.indexOf(effort);
  if (idx === -1) return concrete.filter((l) => !(HIGH_COST_EFFORTS as readonly string[]).includes(l));
  return concrete.slice(0, idx);
}

/** 'medium' when offered, else the highest option, else null. */
export function defaultLowerEffort(options: string[]): string | null {
  if (options.includes('medium')) return 'medium';
  return options.length > 0 ? options[options.length - 1] : null;
}
