import { describe, it, expect } from 'vitest';
import { scoreVariants, mergePicks } from '../select';
import { LENS_LIBRARY, LENS_ORDER } from '../library';
import type { ProjectPageSummary, ProjectPagePicks } from '../summaryType';

function minimalSummary(overrides: Partial<ProjectPageSummary> = {}): ProjectPageSummary {
  return {
    identity: {
      name: 'Test Project', tag: 'app', version: '1.0.0', oneLine: 'A test project.',
      claim: 'It works.', sub: 'Really.', audience: 'developers', install: 'npm install',
    },
    stats: [],
    pillars: [],
    feature: {
      name: 'Feature', kicker: 'kicker', status: 'shipped', owner: 'owner', oneLine: 'one line',
      problem: 'problem', solution: 'solution', steps: [], rules: [], specs: [], faq: [], timeline: [],
    },
    architecture: {
      summary: 'summary', principles: [], layers: [], modules: [], flow: [], decisions: [], risks: [],
    },
    quotes: [],
    ...overrides,
  };
}

describe('scoreVariants', () => {
  it('never selects a quote-requiring variant when quotes[] is empty, in any lens', () => {
    const summary = minimalSummary({ quotes: [] });
    for (const lensId of LENS_ORDER) {
      const picks = scoreVariants(LENS_LIBRARY[lensId], summary);
      for (const slotId of Object.keys(picks)) {
        expect(picks[slotId]).not.toBe('quote');
      }
    }
  });

  it('CAN select the quote-requiring variant when quotes[] is populated and it is the deterministic winner', () => {
    // minimalSummary's stats[] is empty, so preset v1's pick for 'proof'
    // ('stats') is ineligible; preset v2's pick ('quote') becomes the
    // deterministic winner once quotes[] is populated.
    const summary = minimalSummary({ quotes: [{ q: 'Great tool.', a: 'A User', r: 'CEO' }] });
    const picks = scoreVariants(LENS_LIBRARY.marketing, summary);
    expect(picks.proof).toBe('quote');
  });

  it('every slot in every lens always receives a pick for a minimal valid summary', () => {
    const summary = minimalSummary();
    for (const lensId of LENS_ORDER) {
      const lens = LENS_LIBRARY[lensId];
      const picks = scoreVariants(lens, summary);
      for (const slot of lens.slots) {
        expect(picks[slot.id]).toBeDefined();
        expect(typeof picks[slot.id]).toBe('string');
        expect(picks[slot.id].length).toBeGreaterThan(0);
      }
    }
  });
});

describe('mergePicks', () => {
  const scored: ProjectPagePicks = { marketing: { hero: 'centered', proof: 'stats' } };

  it('returns scored unchanged when existing is null', () => {
    expect(mergePicks(null, scored)).toEqual(scored);
  });

  it('preserves an existing hand-pick for a slot not in resetSlots', () => {
    const existing: ProjectPagePicks = { marketing: { hero: 'terminal', proof: 'stats' } };
    const merged = mergePicks(existing, scored, []);
    expect(merged.marketing.hero).toBe('terminal');
  });

  it('overwrites an existing pick for a slot that IS in resetSlots', () => {
    const existing: ProjectPagePicks = { marketing: { hero: 'terminal', proof: 'stats' } };
    const merged = mergePicks(existing, scored, ['hero']);
    expect(merged.marketing.hero).toBe('centered');
  });

  it('supports lens-scoped resetSlots keys ("lensId.slotId")', () => {
    const existing: ProjectPagePicks = { marketing: { hero: 'terminal', proof: 'stats' } };
    const merged = mergePicks(existing, scored, ['marketing.hero']);
    expect(merged.marketing.hero).toBe('centered');
  });
});
