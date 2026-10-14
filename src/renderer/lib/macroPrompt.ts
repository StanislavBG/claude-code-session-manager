// Renders a macro prompt's `{{name}}` placeholders from user-entered values. Pure; the
// press path and the editor own the UI. Mirrors macroLibrary.cjs MACRO_PLACEHOLDER_RE
// (renderer code cannot require .cjs).
import type { MacroInput } from '../../preload/api';

export const MACRO_INPUT_MAX_LEN = 500;
const MACRO_PROMPT_MAX_LEN = 8000;
const PLACEHOLDER_RE = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g;

export type RenderMacroResult = { ok: true; prompt: string } | { ok: false; error: string };

export function macroPlaceholders(prompt: string): string[] {
  const names: string[] = [];
  for (const m of prompt.matchAll(new RegExp(PLACEHOLDER_RE.source, 'g'))) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

export function defaultMacroValues(inputs: MacroInput[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of inputs ?? []) out[i.name] = i.default ?? '';
  return out;
}

function sanitize(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

export function renderMacroPrompt(
  prompt: string,
  inputs: MacroInput[] | undefined,
  values: Record<string, string>,
): RenderMacroResult {
  if (!inputs || inputs.length === 0) return { ok: true, prompt };

  const clean: Record<string, string> = Object.create(null);
  for (const input of inputs) {
    const v = sanitize(values[input.name] ?? input.default ?? '');
    if (v === '') {
      if (input.required) return { ok: false, error: `"${input.label}" is required` };
    } else if (v.length > MACRO_INPUT_MAX_LEN) {
      return { ok: false, error: `"${input.label}" is longer than ${MACRO_INPUT_MAX_LEN} characters` };
    } else if (input.options && input.options.length > 0 && !input.options.includes(v)) {
      return { ok: false, error: `"${input.label}" must be one of: ${input.options.join(', ')}` };
    }
    clean[input.name] = v;
  }

  for (const name of macroPlaceholders(prompt)) {
    if (!(name in clean)) return { ok: false, error: `prompt uses undeclared input {{${name}}}` };
  }

  const rendered = prompt.replace(PLACEHOLDER_RE, (_m, n: string) => clean[n]);
  if (rendered.length > MACRO_PROMPT_MAX_LEN) {
    return { ok: false, error: `rendered prompt is longer than ${MACRO_PROMPT_MAX_LEN} characters` };
  }
  return { ok: true, prompt: rendered };
}
