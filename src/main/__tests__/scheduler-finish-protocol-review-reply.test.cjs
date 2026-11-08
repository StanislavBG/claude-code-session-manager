// A review command (e.g. built-in /security-review) may say its report must be
// the final reply. In a scheduled run it is not — Bilko job 1685 obeyed that and
// ended before VERIFY, COMMIT and the verdict line. The in-run review steps
// must say so; the deferred (no in-run review) variant must stay unchanged.
import { describe, it, expect } from 'vitest';
const { buildFinishProtocol } = require('../scheduler.cjs');

const RULE_MARKER = 'report must be your final reply';

describe('finish protocol: review report is not the final reply', () => {
  const inRun = buildFinishProtocol({ reviewInRun: true });
  const deferred = buildFinishProtocol({ reviewInRun: false });

  it('in-run protocol carries the rule before the VERIFY step', () => {
    const ruleAt = inRun.indexOf(RULE_MARKER);
    const securityAt = inRun.indexOf('SECURITY REVIEW');
    const verifyAt = inRun.indexOf('3. VERIFY');
    expect(ruleAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(-1);
    expect(ruleAt).toBeGreaterThan(securityAt);
    expect(ruleAt).toBeLessThan(verifyAt);
    const block = inRun.slice(ruleAt, verifyAt);
    expect(block).toMatch(/in this run it is not/i);
    expect(block).toMatch(/findings into your final report/);
    expect(block).toMatch(/next step/);
  });

  it('deferred protocol has no such rule', () => {
    expect(deferred).not.toContain(RULE_MARKER);
    expect(deferred).not.toMatch(/in this run it is not/i);
  });

  it('no protocol line starts with a verdict sentinel', () => {
    for (const text of [inRun, deferred]) {
      for (const line of text.split('\n')) {
        expect(line.startsWith('SCHEDULER_VERDICT:')).toBe(false);
        expect(line.startsWith('FOREIGN_WIP_PATHS:')).toBe(false);
      }
    }
  });
});
