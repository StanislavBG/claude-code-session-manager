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

  it('passes when brief is absent (project has not generated brief.json yet)', () => {
    const summary: any = minimalSummary();
    delete summary.brief;
    const result = validateProjectPageSummary(summary);
    expect(result.ok).toBe(true);
  });

  it('passes when brief is present with valid fields', () => {
    const summary: any = minimalSummary();
    summary.brief = {
      purpose: 'Local cockpit for Claude Code CLI.',
      what: ['It runs a terminal.', 'It tracks Epics.'],
      areas: [{ name: 'src/main', files: 40, note: 'Main process.', epic: null, heat: 0.5 }],
      scope: [{ when: '2026-08-01', kind: 'decided', text: 'Added the brief lens.', src: 'CLAUDE.md' }],
      conventions: ['No CommonJS in renderer.'],
    };
    const result = validateProjectPageSummary(summary);
    expect(result.ok).toBe(true);
  });

  it('rejects a placeholder brief.purpose', () => {
    const summary: any = minimalSummary();
    summary.brief = {
      purpose: 'TODO',
      what: [],
      areas: [],
      scope: [],
      conventions: [],
    };
    const result = validateProjectPageSummary(summary);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('brief.purpose'))).toBe(true);
    }
  });

  it('rejects a non-array brief.areas', () => {
    const summary: any = minimalSummary();
    summary.brief = {
      purpose: 'A real purpose.',
      what: [],
      areas: 'not an array',
      scope: [],
      conventions: [],
    };
    const result = validateProjectPageSummary(summary);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('brief.areas'))).toBe(true);
    }
  });
});
