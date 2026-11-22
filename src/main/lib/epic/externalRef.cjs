'use strict';

/**
 * externalRef.cjs — the one shared validator for an Epic's `source.externalRef`:
 * an outside app's own id for the Epic it asked Session Manager to create.
 *
 * Every entry point that accepts an externalRef runs it through
 * normalizeExternalRef. The STORED shape (EpicSourceSchema in
 * promptSessionSchema.cjs) is deliberately lenient — any string — so a stricter
 * rule here never makes dropInvalidSessions drop a whole row on read.
 */

const EXTERNAL_REF_MAX = 200;
// Letters, digits and . _ : / @ - only, 1..EXTERNAL_REF_MAX characters.
const EXTERNAL_REF_PATTERN = new RegExp(`^[A-Za-z0-9._:/@-]{1,${EXTERNAL_REF_MAX}}$`);

/**
 * @param {unknown} value
 * @returns {{ ok: true, value: string | undefined } | { ok: false, error: string }}
 * Never throws.
 */
function normalizeExternalRef(value) {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== 'string') {
    return { ok: false, error: 'externalRef must be a string.' };
  }
  const trimmed = value.trim();
  if (!EXTERNAL_REF_PATTERN.test(trimmed)) {
    return {
      ok: false,
      error: `externalRef must be 1 to ${EXTERNAL_REF_MAX} characters of letters, digits or . _ : / @ - after trimming.`,
    };
  }
  return { ok: true, value: trimmed };
}

module.exports = { EXTERNAL_REF_MAX, EXTERNAL_REF_PATTERN, normalizeExternalRef };
