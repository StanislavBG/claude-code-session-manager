'use strict';

// Starvation escalation must name the row everything waits on (the root
// blocker), not the oldest pending dependent. 2026-11-22: 854-ios-eas-build
// was named while the real blocker was 852-fix-ios-asc-profile (parked).

const { findRootBlocker, rootBlockersForProject } = require('../starvation.cjs');

const CWD = '/proj/app';
const row = (slug, status, extra = {}) => ({ slug, cwd: CWD, epicId: 'e1', status, ...extra });

describe('findRootBlocker', () => {
  it('walks a 3-link chain to the needs_review row', () => {
    const rows = [
      row('852-fix-ios-asc-profile', 'needs_review', {
        statusHistory: [
          { from: 'pending', to: 'running', reason: 'dispatched', source: 's', at: '1' },
          { from: 'running', to: 'needs_review', reason: 'gate red: asc profile missing', source: 's', at: '2' },
        ],
      }),
      row('853-ios-signing', 'pending', { dependsOn: ['852-fix-ios-asc-profile'] }),
      row('854-ios-eas-build', 'pending', { dependsOn: ['853-ios-signing'] }),
    ];
    expect(findRootBlocker(rows[2], rows)).toEqual({
      slug: '852-fix-ios-asc-profile', status: 'needs_review', reason: 'gate red: asc profile missing', preflightHeld: false,
    });
  });

  it('returns null for a row with no blocking dependency', () => {
    const rows = [row('1-a', 'completed'), row('2-b', 'pending', { dependsOn: ['1-a'] })];
    expect(findRootBlocker(rows[1], rows)).toBeNull();
    expect(findRootBlocker(rows[0], rows)).toBeNull();
  });

  it('ends at a pending row with a preflightHold, reason from heldReason', () => {
    const rows = [
      row('10-root', 'pending', {
        heldReason: 'preflight: needs Xcode login',
        preflightHold: { kind: 'credential' },
        statusHistory: [{ from: null, to: 'pending', reason: 'queued', source: 's', at: '1' }],
      }),
      row('11-mid', 'pending', { dependsOn: ['10-root'] }),
      row('12-leaf', 'pending', { dependsOn: ['11-mid'] }),
    ];
    expect(findRootBlocker(rows[2], rows)).toEqual({
      slug: '10-root', status: 'pending', reason: 'preflight: needs Xcode login', preflightHeld: true,
    });
  });

  it('is cycle-safe', () => {
    const rows = [
      row('20-a', 'pending', { dependsOn: ['21-b'] }),
      row('21-b', 'pending', { dependsOn: ['22-c'] }),
      row('22-c', 'pending', { dependsOn: ['20-a'] }),
    ];
    const r = findRootBlocker(rows[0], rows);
    expect(r).not.toBeNull();
    expect(['20-a', '21-b', '22-c']).toContain(r.slug);
    expect(r.reason).toBeNull();
  });

  it('stops at depth 50 on a very long chain', () => {
    const rows = [row('0-root', 'failed')];
    for (let i = 1; i <= 120; i++) rows.push(row(`${i}-n`, 'pending', { dependsOn: [i === 1 ? '0-root' : `${i - 1}-n`] }));
    const r = findRootBlocker(rows[120], rows);
    expect(r).not.toBeNull();
    expect(r.slug).not.toBe('0-root');
  });
});

describe('rootBlockersForProject', () => {
  it('groups dependency-blocked pending rows by distinct root', () => {
    const rows = [
      row('30-root-a', 'failed', { statusHistory: [{ from: 'running', to: 'failed', reason: 'boom', source: 's', at: '1' }] }),
      row('31-a1', 'pending', { dependsOn: ['30-root-a'] }),
      row('32-a2', 'pending', { dependsOn: ['31-a1'] }),
      row('40-root-b', 'needs_review'),
      row('41-b1', 'pending', { dependsOn: ['40-root-b'] }),
      row('50-free', 'pending'),
    ];
    const out = rootBlockersForProject(rows);
    const bySlug = Object.fromEntries(out.map((b) => [b.slug, b]));
    expect(out).toHaveLength(2);
    expect(bySlug['30-root-a']).toEqual({
      slug: '30-root-a', status: 'failed', reason: 'boom', preflightHeld: false, heldSlugs: ['31-a1', '32-a2'],
    });
    expect(bySlug['40-root-b']).toEqual({
      slug: '40-root-b', status: 'needs_review', reason: null, preflightHeld: false, heldSlugs: ['41-b1'],
    });
  });

  it('tolerates non-array input', () => {
    expect(rootBlockersForProject(null)).toEqual([]);
  });
});
