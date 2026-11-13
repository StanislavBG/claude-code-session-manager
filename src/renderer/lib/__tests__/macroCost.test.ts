import { describe, expect, it } from 'vitest';
import { HIGH_COST_EFFORTS, defaultLowerEffort, lowerEffortOptions, macroCostNotice } from '../macroCost';

const macro = { label: 'Demo Video', agentName: 'demo-video-builder' };
const LEVELS = ['inherit', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

describe('macroCostNotice', () => {
  it('exports the high-cost efforts', () => {
    expect([...HIGH_COST_EFFORTS]).toEqual(['xhigh', 'max']);
  });

  it('returns null for an undefined persona', () => {
    expect(macroCostNotice(macro, undefined)).toBeNull();
  });

  it.each([null, 'low', 'medium', 'high'])('returns null for effort %s', (effort) => {
    expect(macroCostNotice(macro, { model: 'opus', effort })).toBeNull();
  });

  it.each(['xhigh', 'max'])('returns a notice for effort %s', (effort) => {
    expect(macroCostNotice(macro, { model: 'opus', effort })).toEqual({
      message: `"Demo Video" runs demo-video-builder on opus at ${effort} effort, which can use a large share of your Claude usage.`,
      model: 'opus',
      effort,
    });
  });

  it('shows "the default model" when model is null and keeps model null', () => {
    const n = macroCostNotice(macro, { model: null, effort: 'max' });
    expect(n?.message).toContain('on the default model at max');
    expect(n?.model).toBeNull();
    expect(n?.message.endsWith('Continue?')).toBe(false);
  });
});

describe('lowerEffortOptions', () => {
  it('max gives low, medium, high, xhigh', () => {
    expect(lowerEffortOptions('max', LEVELS)).toEqual(['low', 'medium', 'high', 'xhigh']);
  });
  it('xhigh gives low, medium, high', () => {
    expect(lowerEffortOptions('xhigh', LEVELS)).toEqual(['low', 'medium', 'high']);
  });
  it('unknown effort gives the non-high-cost levels', () => {
    expect(lowerEffortOptions('turbo', LEVELS)).toEqual(['low', 'medium', 'high']);
  });
  it('never lists inherit or auto', () => {
    for (const e of ['max', 'xhigh', 'turbo', 'high', 'low']) {
      const opts = lowerEffortOptions(e, LEVELS);
      expect(opts).not.toContain('inherit');
      expect(opts).not.toContain('auto');
    }
  });
});

describe('defaultLowerEffort', () => {
  it('prefers medium', () => {
    expect(defaultLowerEffort(['low', 'medium', 'high'])).toBe('medium');
  });
  it('falls back to the last option', () => {
    expect(defaultLowerEffort(['low', 'high'])).toBe('high');
  });
  it('returns null for no options', () => {
    expect(defaultLowerEffort([])).toBeNull();
  });
});
