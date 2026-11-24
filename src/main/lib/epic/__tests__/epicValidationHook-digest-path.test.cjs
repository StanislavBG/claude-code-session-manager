/**
 * epicValidationHook-digest-path.test.cjs — the PLAN SETTLED digest names the
 * absolute main-checkout plan-records folder (records are never committed, so a
 * repo-relative path would point at nothing in a fresh checkout) plus the
 * legacy reviews/validation folder.
 *
 * Run: timeout 300 npx vitest run src/main/lib/epic/__tests__/epicValidationHook-digest-path.test.cjs
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSettledDigest, runEpicSettle, __resetSettleForTests } = require('../epicValidationHook.cjs');
const { opsPath } = require('../../opsOwnership.cjs');

describe('buildSettledDigest record folder', () => {
  /** @type {string} */
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-path-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('names the absolute plan-records folder and the legacy folder', () => {
    const digest = buildSettledDigest({ verified: ['0001-a'] }, { epicId: 'epic-1', cwd: root });
    const planDir = opsPath(root, 'plan-records', 'epic-1');
    expect(path.isAbsolute(planDir)).toBe(true);
    expect(digest).toContain(planDir + path.sep);
    expect(digest).toContain(opsPath(root, 'reviews', 'validation', 'epic-1') + path.sep);
    expect(digest).not.toContain('relative to the repository root');
  });
});

const HEAD = 'Findings (';
const ASK = '— give each one an outcome in this turn: a fix PRD or a one-line close reason:';

describe('buildSettledDigest findings section', () => {
  it('renders every finding, Critical first, then Important, then Minor', () => {
    const digest = buildSettledDigest({ verified: ['0001-a'], uncovered: ['0009-z'] }, {
      epicId: 'epic-1',
      findings: [
        { prd: '0001-a', severity: 'Minor', text: 'typo in comment', file: 'src/a.cjs' },
        { prd: '0002-b', severity: 'Critical', text: 'data loss', file: 'src/b.cjs' },
        { prd: '0003-c', severity: 'Important', text: 'missing test', file: 'src/c.cjs' },
      ],
    });
    expect(digest).toContain(`Findings (3) ${ASK}`);
    const crit = digest.indexOf('- [Critical] 0002-b: data loss (src/b.cjs)');
    const imp = digest.indexOf('- [Important] 0003-c: missing test (src/c.cjs)');
    const min = digest.indexOf('- [Minor] 0001-a: typo in comment (src/a.cjs)');
    expect(crit).toBeGreaterThan(-1);
    expect(imp).toBeGreaterThan(crit);
    expect(min).toBeGreaterThan(imp);
    // After the verdict lists, before Not validated.
    expect(digest.indexOf('Verified (1)')).toBeLessThan(digest.indexOf(HEAD));
    expect(digest.indexOf(HEAD)).toBeLessThan(digest.indexOf('Not validated (1)'));
  });

  it('no findings means no section and the rest unchanged', () => {
    const settle = { verified: ['0001-a'], refuted: [{ slug: '0002-b', reason: 'r' }] };
    const base = buildSettledDigest(settle, { epicId: 'epic-1' });
    expect(base).not.toContain(HEAD);
    expect(buildSettledDigest(settle, { epicId: 'epic-1', findings: [] })).toBe(base);
  });

  it('collapses newlines and tabs so each finding stays on one line', () => {
    const digest = buildSettledDigest({ verified: ['0001-a'] }, {
      epicId: 'epic-1',
      findings: [
        { prd: '0001-a', severity: 'Important', text: '  first line\n\nsecond\tline \r\n third  ', file: ' src/\na.cjs\t' },
        { prd: '0002-b', severity: 'Minor', text: ' \n\t ', file: '' },
      ],
    });
    const lines = digest.split('\n');
    expect(lines).toContain('- [Important] 0001-a: first line second line third (src/ a.cjs)');
    expect(lines).toContain('- [Minor] 0002-b:');
    expect(lines.filter((l) => l.startsWith('- ['))).toHaveLength(2);
    expect(digest).not.toContain('second\tline');
  });

  it('caps the list at 50 lines with a pointer to the records', () => {
    const findings = Array.from({ length: 53 }, (_, i) => ({ prd: `p${i}`, severity: 'Minor', text: 't', file: 'f' }));
    const digest = buildSettledDigest({ verified: ['x'] }, { epicId: 'e', findings });
    expect(digest).toContain('Findings (53)');
    expect(digest.split('\n').filter((l) => l.startsWith('- [Minor]')).length).toBe(50);
    expect(digest).toContain('- …and 3 more in the records');
  });
});

describe('runEpicSettle findings collection', () => {
  const EPIC = 'epic-f';
  const NOW = Date.parse('2026-11-23T12:00:00Z');
  const at = (min) => new Date(NOW - (60 - min) * 60000).toISOString();
  const checkin = (slug, min) => ({
    id: `c-${slug}`, kind: 'response', at: at(min), text: `PRD ${slug} finished: completed.`,
    prdSlug: slug, outcome: 'completed', validation: 'unvalidated', agentType: 'dev-lead',
  });
  const verdictEv = (slug, min) => ({ id: `v-${slug}`, kind: 'response', at: at(min), text: '', prdSlug: slug, validation: 'verified' });
  const deps = (events, verdicts) => ({
    readActiveIndex: vi.fn(() => ({ sessions: { [EPIC]: { id: EPIC, status: 'active' } }, events: { [EPIC]: events } })),
    loadJobs: vi.fn(async () => []),
    loadHistory: vi.fn(async () => []),
    createPrd: vi.fn(async () => ({ ok: true })),
    sendPrompt: vi.fn(),
    appendResponseEvent: vi.fn(async () => true),
    readVerdictFiles: vi.fn(() => verdicts),
    now: () => NOW,
    log: { error: vi.fn() },
  });
  beforeEach(() => { __resetSettleForTests(); });

  it('leaves out findings saved before the previous digest', async () => {
    const events = [
      checkin('0001-old', 1), verdictEv('0001-old', 2),
      { id: 'd', kind: 'response', at: at(5), text: 'Plan digest sent', outcome: 'digest', digestKey: 'old-key' },
      checkin('0002-new', 6), verdictEv('0002-new', 7),
    ];
    const d = deps(events, [
      { prd: '0001-old', verdict: 'VERIFIED', at: at(3), findings: [{ severity: 'Minor', text: 'old nit', file: 'a.cjs' }] },
      { prd: '0002-new', verdict: 'VERIFIED', at: at(8), findings: [{ severity: 'Minor', text: 'new nit', file: 'b.cjs' }] },
    ]);
    const res = await runEpicSettle({ cwd: '/c', epicId: EPIC }, d);
    expect(res.action).toBe('digest-sent');
    expect(d.readVerdictFiles).toHaveBeenCalledWith('/c', EPIC);
    const text = d.sendPrompt.mock.calls[0][1];
    expect(text).toContain('Findings (1)');
    expect(text).toContain('- [Minor] 0002-new: new nit (b.cjs)');
    expect(text).not.toContain('old nit');
  });

  it('includes every finding when there was no digest yet', async () => {
    const events = [checkin('0001-a', 1), verdictEv('0001-a', 2)];
    const d = deps(events, [
      { prd: '0001-a', verdict: 'VERIFIED', at: at(3), findings: [
        { severity: 'Minor', text: 'nit', file: 'a.cjs' },
        { severity: 'Important', text: 'gap', file: 'b.cjs' },
      ] },
    ]);
    await runEpicSettle({ cwd: '/c', epicId: EPIC }, d);
    const text = d.sendPrompt.mock.calls[0][1];
    expect(text).toContain('Findings (2)');
    expect(text.indexOf('[Important] 0001-a: gap')).toBeLessThan(text.indexOf('[Minor] 0001-a: nit'));
  });

  it('no findings in the records means no Findings section', async () => {
    const events = [checkin('0001-a', 1), verdictEv('0001-a', 2)];
    const d = deps(events, [{ prd: '0001-a', verdict: 'VERIFIED', at: at(3), findings: [] }]);
    await runEpicSettle({ cwd: '/c', epicId: EPIC }, d);
    expect(d.sendPrompt.mock.calls[0][1]).not.toContain('Findings (');
  });
});
