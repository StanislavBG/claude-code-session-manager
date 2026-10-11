/**
 * kebabCase.cjs — shared lowercase/kebab-case slugify. Extracted from
 * hives.cjs (private `kebabCase` helper) so prdCreate.cjs doesn't fork a
 * second, subtly-different copy (API reuse: one concept, one implementation).
 */
'use strict';

function kebabCase(s, { maxLen = 64, fallback = '' } = {}) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, maxLen) || fallback;
}

module.exports = { kebabCase };
