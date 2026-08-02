import { describe, it, expect } from 'vitest';
import { validateProjectPageSummary } from '../summaryValidate';
import type { ProjectPageSummary } from '../summaryType';

function minimalSummary(): ProjectPageSummary {
  return {
    identity: {
      name: 'Test Project',
      tag: 'app',
      version: '1.0.0',
      oneLine: 'A test project.',
      claim: 'It works.',
      sub: 'Really.',
      audience: 'developers',
      install: 'npm install',
    },
    stats: [],
    pillars: [],
    feature: {
      name: 'Feature',
      kicker: 'kicker',
      status: 'shipped',
      owner: 'owner',
      oneLine: 'one line',
      problem: 'problem',
      solution: 'solution',
      steps: [],
      rules: [],
      specs: [],
      faq: [],
      timeline: [],
    },
    architecture: {
      summary: 'summary',
      principles: [],
      layers: [],
      modules: [],
      flow: [],
      decisions: [],
      risks: [],
    },
    quotes: [],
  };
}

describe('validateProjectPageSummary', () => {
  it('passes for a valid minimal summary', () => {
    const result = validateProjectPageSummary(minimalSummary());
    expect(result.ok).toBe(true);
  });

  it('fails with a descriptive error naming a missing required field', () => {
    const summary: any = minimalSummary();
    delete summary.identity.name;
    const result = validateProjectPageSummary(summary);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('identity.name'))).toBe(true);
    }
  });

  it('an empty quotes[] array is valid (never required to be non-empty)', () => {
    const summary = minimalSummary();
    summary.quotes = [];
    const result = validateProjectPageSummary(summary);
    expect(result.ok).toBe(true);
  });

  it('rejects a non-object value', () => {
    const result = validateProjectPageSummary(null);
    expect(result.ok).toBe(false);
  });

  it('rejects the literal placeholder string TODO for a required string field', () => {
    const summary: any = minimalSummary();
    summary.identity.claim = 'TODO';
    const result = validateProjectPageSummary(summary);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('identity.claim'))).toBe(true);
    }
  });

  it('rejects a non-array stats field', () => {
    const summary: any = minimalSummary();
    summary.stats = 'not an array';
    const result = validateProjectPageSummary(summary);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('stats'))).toBe(true);
    }
  });
});
