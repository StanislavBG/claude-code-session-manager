/**
 * Treats an empty or whitespace-only body as `{}` rather than throwing
 * FST_ERR_CTP_EMPTY_JSON_BODY. Prevents bodyless POSTs with
 * Content-Type: application/json from 500-ing instead of routing normally
 * to the auth check (which returns 401).
 */
export function safeParseJsonBody(raw: string): unknown {
  if (!raw || raw.trim() === '') return {};
  return JSON.parse(raw);
}
