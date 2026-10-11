import { describe, expect, it } from 'vitest';
import { HIGH_COST_EFFORTS, macroCostWarning } from '../macroCost';

const macro = { label: 'Demo Video', agentName: 'demo-video-builder' };

describe('macroCostWarning', () => {
  it('exports the high-cost efforts', () => {
    expect([...HIGH_COST_EFFORTS]).toEqual(['xhigh', 'max']);
  });

  it('returns null for an undefined persona', () => {
    expect(macroCostWarning(macro, undefined)).toBeNull();
  });

  it.each([null, 'low', 'medium', 'high'])('returns null for effort %s', (effort) => {
    expect(macroCostWarning(macro, { model: 'opus', effort })).toBeNull();
  });

  it.each(['xhigh', 'max'])('warns for effort %s', (effort) => {
    const msg = macroCostWarning(macro, { model: 'opus', effort });
    expect(msg).toContain('Demo Video');
    expect(msg).toContain('demo-video-builder');
    expect(msg).toContain('opus');
    expect(msg).toContain(effort);
    expect(msg).toContain('large share');
    expect(msg!.endsWith('Continue?')).toBe(true);
  });

  it('uses "the default model" when model is null', () => {
    expect(macroCostWarning(macro, { model: null, effort: 'max' })).toContain('the default model');
  });
});
