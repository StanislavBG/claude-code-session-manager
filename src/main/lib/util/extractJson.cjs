/**
 * extractJson.cjs — pull the first balanced {...} JSON object out of model
 * output (handles prose/fences). Shared by memoryAggregate.cjs (clustering
 * response parsing) and chatRunner.cjs (stop-signal protocol parsing).
 *
 * Complexity: O(n) single pass over the input text.
 */
'use strict';

function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

module.exports = { extractJson };
