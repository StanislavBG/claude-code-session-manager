import { describe, it, expect } from 'vitest';
import { safeParseJsonBody } from '../src/bodyParser';

// ── safeParseJsonBody — relay empty-body guard ─────────────────────────────
//
// REGRESSION: POST /api/otp and /api/ws-ticket are bodyless. A client that
// erroneously sends Content-Type: application/json on these requests causes
// JSON.parse('') → SyntaxError → 500. The guard returns {} so Fastify routes
// the request normally; the auth check then returns 401 (not 500).

describe('safeParseJsonBody', () => {
  it('returns {} for an empty string', () => {
    expect(safeParseJsonBody('')).toEqual({});
  });

  it('returns {} for a whitespace-only body', () => {
    expect(safeParseJsonBody('   \n\t')).toEqual({});
  });

  it('parses a well-formed JSON object', () => {
    expect(safeParseJsonBody('{"foo":"bar","n":1}')).toEqual({ foo: 'bar', n: 1 });
  });

  it('parses a JSON array', () => {
    expect(safeParseJsonBody('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('throws a SyntaxError for malformed JSON (preserves the Fastify 400 path)', () => {
    expect(() => safeParseJsonBody('{bad json')).toThrow(SyntaxError);
  });

  it('does NOT return {} for syntactically invalid JSON (empty body != bad body)', () => {
    expect(() => safeParseJsonBody('{"unclosed":')).toThrow();
  });
});

// ── Integration property ───────────────────────────────────────────────────
//
// When safeParseJsonBody is registered as the Fastify content-type parser and
// a bodyless POST /api/otp arrives:
//   1. parser returns {} (no throw)           → Fastify does NOT 500
//   2. requireBrowserSession checks the session → returns 401 (4xx, not 500)
//
// This is a non-500 guarantee: any response to a bodyless POST is 4xx, never 5xx.

describe('empty-body guard — non-500 property', () => {
  it('safeParseJsonBody("") does not throw, so Fastify never 500s on an empty body', () => {
    expect(() => safeParseJsonBody('')).not.toThrow();
    const result = safeParseJsonBody('');
    // The route handler receives an object, not an error; error handling is upstream
    expect(typeof result).toBe('object');
  });
});
