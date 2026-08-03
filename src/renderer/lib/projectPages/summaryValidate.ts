// Runtime validator for ProjectPageSummary — the project-home-builder Epic
// composes summary.json by hand (Read/Write tools, no backend synthesis
// call), so this is the one place that catches a malformed summary before
// it reaches the renderer, rather than trusting the type system alone.
import type { ProjectPageSummary } from './summaryType';

export type ValidateProjectPageSummaryResult =
  | { ok: true; summary: ProjectPageSummary }
  | { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.trim() !== 'TODO';
}

function checkRequiredString(obj: Record<string, unknown>, key: string, path: string, errors: string[]): void {
  if (!isNonEmptyString(obj[key])) {
    errors.push(`${path}.${key} must be a non-empty string (not 'TODO' or '')`);
  }
}

const IDENTITY_STRING_FIELDS = ['name', 'tag', 'version', 'oneLine', 'claim', 'sub', 'audience', 'install'] as const;
const FEATURE_STRING_FIELDS = ['name', 'kicker', 'status', 'owner', 'oneLine', 'problem', 'solution'] as const;
const FEATURE_ARRAY_FIELDS = ['steps', 'rules', 'specs', 'faq', 'timeline'] as const;
const ARCHITECTURE_ARRAY_FIELDS = ['principles', 'layers', 'modules', 'flow', 'decisions', 'risks'] as const;
const BRIEF_ARRAY_FIELDS = ['what', 'areas', 'scope', 'conventions'] as const;

export function validateProjectPageSummary(value: unknown): ValidateProjectPageSummaryResult {
  const errors: string[] = [];

  if (!isPlainObject(value)) {
    return { ok: false, errors: ['summary must be a JSON object'] };
  }

  if (!isPlainObject(value.identity)) {
    errors.push('identity must be an object');
  } else {
    for (const field of IDENTITY_STRING_FIELDS) {
      checkRequiredString(value.identity, field, 'identity', errors);
    }
  }

  if (!Array.isArray(value.stats)) errors.push('stats must be an array');
  if (!Array.isArray(value.pillars)) errors.push('pillars must be an array');
  if (!Array.isArray(value.quotes)) errors.push('quotes must be an array (may be empty)');

  if (!isPlainObject(value.feature)) {
    errors.push('feature must be an object');
  } else {
    for (const field of FEATURE_STRING_FIELDS) {
      checkRequiredString(value.feature, field, 'feature', errors);
    }
    for (const field of FEATURE_ARRAY_FIELDS) {
      if (!Array.isArray(value.feature[field])) errors.push(`feature.${field} must be an array`);
    }
  }

  if (!isPlainObject(value.architecture)) {
    errors.push('architecture must be an object');
  } else {
    checkRequiredString(value.architecture, 'summary', 'architecture', errors);
    for (const field of ARCHITECTURE_ARRAY_FIELDS) {
      if (!Array.isArray(value.architecture[field])) errors.push(`architecture.${field} must be an array`);
    }
  }

  // `brief` is OPTIONAL — a project whose brief.json has not been generated
  // yet must still produce a valid summary.json (Stage 1's brief mapping is
  // additive on top of the pre-existing 4-lens fields above).
  if (value.brief !== undefined) {
    if (!isPlainObject(value.brief)) {
      errors.push('brief must be an object when present');
    } else {
      checkRequiredString(value.brief, 'purpose', 'brief', errors);
      for (const field of BRIEF_ARRAY_FIELDS) {
        if (!Array.isArray(value.brief[field])) errors.push(`brief.${field} must be an array`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, summary: value as unknown as ProjectPageSummary };
}
