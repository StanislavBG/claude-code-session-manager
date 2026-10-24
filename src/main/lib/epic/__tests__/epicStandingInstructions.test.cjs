import { test, expect } from 'vitest';
const {
  buildEpicStandingInstructions: build,
  DELEGATE_IMPLEMENTATION_TEXT: DELEGATE,
  HEADER,
  MAX_CHARS,
} = require('../epicStandingInstructions.cjs');

const sec = (kind, text, source) => ({ kind, label: kind, text, source });

test('sections path: excludes goal/reference/input, keeps order', () => {
  const out = build({
    sections: [
      sec('actor', 'A1'), sec('persona-body', 'P1'), sec('injection', 'I1', 'x'),
      sec('input', 'IN'), sec('mission', 'M1'), sec('goal', 'G'), sec('reference', 'R'),
    ],
  });
  expect(out).toBe(`${HEADER}\n\nA1\n\nP1\n\nI1\n\nM1`);
});

test('legacy fallback uses readPersonaBody', () => {
  const out = build({ agentType: 'dev', sections: [] }, { readPersonaBody: (n) => `body of ${n}` });
  expect(out).toContain('body of dev');
  expect(build({ agentType: 'dev' }, { readPersonaBody: () => null })).toBeNull();
});

test('delegate text appended for architect/feature/bug, not otherwise', () => {
  const rp = () => 'persona';
  expect(build({ agentType: 'architect' }, { readPersonaBody: rp })).toContain(DELEGATE);
  expect(build({ tag: 'feature', sections: [sec('actor', 'a')] })).toContain(DELEGATE);
  expect(build({ tag: 'bug', sections: [sec('actor', 'a')] })).toContain(DELEGATE);
  expect(build({ tag: 'research', agentType: 'dev', sections: [sec('actor', 'a')] })).not.toContain(DELEGATE);
});

test('delegate text not duplicated when injection section exists', () => {
  const out = build({
    tag: 'feature',
    sections: [sec('injection', DELEGATE, 'delegate-implementation')],
  });
  expect(out.split(DELEGATE).length - 1).toBe(1);
});

test('null epic / no content returns null', () => {
  expect(build(null)).toBeNull();
  expect(build(undefined)).toBeNull();
  expect(build({ sections: [sec('goal', 'g')] })).toBeNull();
});

test('output capped at 12000 chars with truncation notice', () => {
  const out = build({ sections: [sec('actor', 'x'.repeat(20000))] });
  expect(out.length).toBeLessThanOrEqual(MAX_CHARS);
  expect(out).toMatch(/truncated/);
});
