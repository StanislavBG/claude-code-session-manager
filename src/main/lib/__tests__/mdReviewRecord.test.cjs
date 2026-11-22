/**
 * mdReviewRecord.test.cjs — the review-record reader behind Project Home's
 * Review MD network: newest-record ordering, template parsing (the real
 * family-frame record as a fixture, a Drift check, missing sections, a
 * malformed table row) and readMdReview on a scratch project.
 *
 * Run: timeout 300 npx vitest run src/main/lib/__tests__/mdReviewRecord.test.cjs
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { newestRecordName, parseReviewRecord, readMdReview } = require('../mdReviewRecord.cjs');

// Copied verbatim from family-frame session-manager-operations/reviews/docs/2026-11-15-md-network.md.
const FAMILY_FRAME = String.raw`
# Markdown network review 2026-11-15

- Date: 2026-11-15
- Mode: Full review (audit ran 2026-11-12; approved 2026-11-15)
- Scope: the whole project
- Base commit: bab11306fe9757cbdc1d7a40862d63c0bc30829d
- Owner: Bilko
- Map: CLAUDE.md
- Drift-check command: node script/drift-check.cjs --root . --exclude session-manager-operations/
- Findings counts: broken-link 0, missing-path 0, over-line-limit 0, no-contents-list 0
- Census summary: 83 files, 4570 lines, 75.9% of files (63) and 61.0% of lines (2786) machine-written (under session-manager-operations/; counted at the base commit, before this record)

## Verdicts

| Doc | Verdict | Owner doc |
| --- | --- | --- |
| CLAUDE.md | KEEP-OWNER | map |
| docs/operations.md | KEEP-OWNER | new |
| docs/agent-access.md | KEEP-OWNER | itself |
| docs/person-publishing.md | KEEP-OWNER | itself |
| docs/time-series.md | KEEP-OWNER | itself |
| docs/events.md | KEEP-OWNER | itself |
| docs/household-email.md | KEEP-OWNER | itself |
| docs/bilko-run.md | KEEP-OWNER | itself |
| services/events-pipeline/README.md | KEEP-OWNER | itself |
| .claude/agents/builder.md | KEEP-OWNER | itself |
| .claude/rules/ (8 path-scoped rule files) | KEEP-OWNER | themselves |
| services/mail-intake/README.md | SHRINK-TO-POINTER | docs/household-email.md |
| replit.md | SHRINK-TO-POINTER | CLAUDE.md and docs/operations.md |
| docs/events-design-brief.md | MERGE-INTO | docs/events.md |
| design_guidelines.md | DELETE | facts now in .claude/rules/client.md and client/src/index.css |
| session-manager-operations/reviews/validation/ | machine-written records read by script/release.ts (kept, outside the map) | script/release.ts |

## Decisions

- The human approved the restructure on 2026-11-15.
- Drift gate: the vendored script/drift-check.cjs runs inside npm test (script/docs-check.test.ts); periodic reviews still use the Review MD network macro.
- Unbuilt items of the Events design brief (Great fit, Maybe later, Remove from my plans, We went / We didn't go, offline banner) were dropped with it; git log -- docs/events-design-brief.md recovers them.
- docs/household-email.md documents the shipped operator-Gmail design; a replacement design is a product decision outside the docs.
- Rules live in path-scoped .claude/rules/ files, not nested CLAUDE.md files, because the Events, People and Utilities rules span client/, server/, shared/ and services/.
- Terms: release = npm run release to GitHub main; deploy = Replit pull + Publish; publish = agents writing data.
- replit.md is a pointer, not deleted, because Replit Agent reads it by convention.

## Follow-up PRDs

- vendor-drift-check-script
- md-operations-doc
- md-agent-access-owner
- md-people-owner
- md-time-series-owner
- md-events-merge-brief
- md-events-pipeline-readme-owner
- md-events-rules
- md-household-email-owner
- md-client-rules
- md-server-rules
- md-apps-rules
- md-claude-map
- docs-check-in-npm-test
- docs-inventory-test
- docs-ui-links
- remove-unused-auth-deps
- remove-dead-series-board
- replit-drop-postgres-module

## Next review due

2027-02-15, or sooner after a major model release.
`.replace(/^\n/, '');

describe('newestRecordName', () => {
  it('picks the newest date, then the highest numeric suffix', () => {
    expect(newestRecordName([])).toBe(null);
    expect(newestRecordName(['README.md', 'notes.md', '2026-11-15-md-network.txt'])).toBe(null);
    expect(newestRecordName(['2026-11-14-md-network.md', '2026-11-15-md-network.md'])).toBe('2026-11-15-md-network.md');
    expect(newestRecordName(['2026-11-15-md-network.md', '2026-11-15-md-network-2.md'])).toBe('2026-11-15-md-network-2.md');
    expect(newestRecordName(['2026-11-15-md-network-9.md', '2026-11-15-md-network-10.md', '2026-11-15-md-network.md']))
      .toBe('2026-11-15-md-network-10.md');
    expect(newestRecordName(['2026-11-15-md-network-10.md', '2026-11-16-md-network.md'])).toBe('2026-11-16-md-network.md');
    expect(newestRecordName(['2026-11-15-md-network-x.md', '2026-11-15-md-network.md.bak', 'x2026-11-15-md-network.md']))
      .toBe(null);
  });
});

describe('parseReviewRecord', () => {
  it('parses the family-frame record', () => {
    const r = parseReviewRecord(FAMILY_FRAME);
    expect(r.date).toBe('2026-11-15');
    expect(r.mode).toBe('Full review (audit ran 2026-11-12; approved 2026-11-15)');
    expect(r.modeKind).toBe('Full review');
    expect(r.scope).toBe('the whole project');
    expect(r.session).toBe(null);
    expect(r.baseCommit).toBe('bab11306fe9757cbdc1d7a40862d63c0bc30829d');
    expect(r.owner).toBe('Bilko');
    expect(r.map).toBe('CLAUDE.md');
    expect(r.driftCheckCommand).toBe('node script/drift-check.cjs --root . --exclude session-manager-operations/');
    expect(r.findingsCounts).toEqual({ 'broken-link': 0, 'missing-path': 0, 'over-line-limit': 0, 'no-contents-list': 0 });
    expect(r.censusSummary).toMatch(/^83 files, 4570 lines, 75\.9% of files/);
    expect(r.verdicts).toHaveLength(16);
    expect(r.verdicts[0]).toEqual({ doc: 'CLAUDE.md', verdict: 'KEEP-OWNER', owner: 'map' });
    expect(r.verdicts[11]).toEqual({ doc: 'services/mail-intake/README.md', verdict: 'SHRINK-TO-POINTER', owner: 'docs/household-email.md' });
    expect(r.verdicts[14]).toEqual({
      doc: 'design_guidelines.md',
      verdict: 'DELETE',
      owner: 'facts now in .claude/rules/client.md and client/src/index.css',
    });
    expect(r.decisions).toHaveLength(7);
    expect(r.decisions[0]).toBe('The human approved the restructure on 2026-11-15.');
    expect(r.followUpPrds).toHaveLength(19);
    expect(r.followUpPrds[0]).toBe('vendor-drift-check-script');
    expect(r.followUpPrds[18]).toBe('replit-drop-postgres-module');
    expect(r.nextReviewDue).toBe('2027-02-15');
    expect(r.nextReviewNote).toBe('2027-02-15, or sooner after a major model release.');
  });

  it('parses a Drift check record with a Session line and no follow-ups', () => {
    const r = parseReviewRecord([
      '# Markdown network review 2026-12-01',
      '',
      '- Date: 2026-12-01',
      '- Mode: Drift check',
      '- Scope: docs/',
      '- Session: epic-abc123',
      '- Base commit: 0123456789abcdef0123456789abcdef01234567',
      '- Findings counts: broken-link 2, missing-path 1',
      '',
      '## Verdicts',
      '',
      '| Doc | Verdict | Owner doc |',
      '|:---|---|---:|',
      '| docs/a.md | KEEP-OWNER | itself |',
      '',
      '## Follow-up PRDs',
      '',
      '- none',
      '',
      '## Next review due',
      '',
      '2027-03-01',
    ].join('\n'));
    expect(r.modeKind).toBe('Drift check');
    expect(r.session).toBe('epic-abc123');
    expect(r.scope).toBe('docs/');
    expect(r.findingsCounts).toEqual({ 'broken-link': 2, 'missing-path': 1 });
    expect(r.verdicts).toEqual([{ doc: 'docs/a.md', verdict: 'KEEP-OWNER', owner: 'itself' }]);
    expect(r.followUpPrds).toEqual([]);
    expect(r.decisions).toEqual([]);
    expect(r.nextReviewDue).toBe('2027-03-01');
  });

  it('returns nulls and empties for missing sections, never throws', () => {
    const empty = parseReviewRecord('');
    expect(empty).toEqual({
      date: null, mode: null, modeKind: null, scope: null, session: null, baseCommit: null, owner: null,
      map: null, driftCheckCommand: null, findingsCounts: {}, censusSummary: null, verdicts: [],
      decisions: [], followUpPrds: [], nextReviewDue: null, nextReviewNote: null,
    });
    expect(parseReviewRecord(undefined)).toEqual(empty);
    const r = parseReviewRecord('# Review\n\n- Date: 2026-11-01\n- Mode: Something else\n\n## Next review due\n\nwhen convenient\n');
    expect(r.date).toBe('2026-11-01');
    expect(r.modeKind).toBe(null);
    expect(r.verdicts).toEqual([]);
    expect(r.nextReviewDue).toBe(null);
    expect(r.nextReviewNote).toBe('when convenient');
  });

  it('skips a malformed table row', () => {
    const r = parseReviewRecord([
      '## Verdicts',
      '| Doc | Verdict | Owner doc |',
      '| --- | --- | --- |',
      '| only-one-cell |',
      'not a row at all',
      '|  | DELETE | x |',
      '| b.md | DELETE | c.md |',
    ].join('\n'));
    expect(r.verdicts).toEqual([{ doc: 'b.md', verdict: 'DELETE', owner: 'c.md' }]);
  });
});

describe('readMdReview', () => {
  /** @type {string} */
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-review-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('gives record null when the folder is missing', async () => {
    const r = await readMdReview(root, { epicIds: ['epic-1'] });
    expect(r).toEqual({ ok: true, record: null, recordPath: null, validation: { 'epic-1': [] } });
  });

  it('reads the newest of two records and lists validation records', async () => {
    const docs = path.join(root, 'session-manager-operations', 'reviews', 'docs');
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, '2026-11-15-md-network.md'), FAMILY_FRAME);
    fs.writeFileSync(path.join(docs, '2026-11-15-md-network-2.md'), '- Date: 2026-11-15\n- Mode: Drift check\n');
    const val = path.join(root, 'session-manager-operations', 'reviews', 'validation', 'epic-1');
    fs.mkdirSync(val, { recursive: true });
    fs.writeFileSync(path.join(val, 'b.md'), 'x');
    fs.writeFileSync(path.join(val, 'a.md'), 'x');
    fs.writeFileSync(path.join(val, 'skip.json'), '{}');
    fs.mkdirSync(path.join(root, 'session-manager-operations', 'reviews', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'session-manager-operations', 'reviews', 'x', 'leak.md'), 'x');

    const r = await readMdReview(root, { epicIds: ['epic-1', '../x', 'EPIC', ''] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recordPath).toBe('session-manager-operations/reviews/docs/2026-11-15-md-network-2.md');
    expect(r.record && r.record.modeKind).toBe('Drift check');
    expect(r.validation).toEqual({
      'epic-1': [
        'session-manager-operations/reviews/validation/epic-1/a.md',
        'session-manager-operations/reviews/validation/epic-1/b.md',
      ],
    });
  });

  it('merges plan-records with the legacy folder; plan-records wins a name clash', async () => {
    const ops = path.join(root, 'session-manager-operations');
    const plan = path.join(ops, 'plan-records', 'epic-1');
    const legacy = path.join(ops, 'reviews', 'validation', 'epic-1');
    fs.mkdirSync(plan, { recursive: true });
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(plan, '0003-c.md'), 'x');
    fs.writeFileSync(path.join(plan, '0002-b.md'), 'new');
    fs.writeFileSync(path.join(plan, 'skip.json'), '{}');
    fs.writeFileSync(path.join(legacy, '0002-b.md'), 'old');
    fs.writeFileSync(path.join(legacy, '0001-a.md'), 'x');

    const r = await readMdReview(root, { epicIds: ['epic-1'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.validation).toEqual({
      'epic-1': [
        'session-manager-operations/reviews/validation/epic-1/0001-a.md',
        'session-manager-operations/plan-records/epic-1/0002-b.md',
        'session-manager-operations/plan-records/epic-1/0003-c.md',
      ],
    });
  });

  it('lists plan-records alone when there is no legacy folder', async () => {
    const plan = path.join(root, 'session-manager-operations', 'plan-records', 'epic-2');
    fs.mkdirSync(plan, { recursive: true });
    fs.writeFileSync(path.join(plan, 'x.md'), 'x');
    const r = await readMdReview(root, { epicIds: ['epic-2'] });
    expect(r.ok && r.validation).toEqual({ 'epic-2': ['session-manager-operations/plan-records/epic-2/x.md'] });
  });

  it('still lists legacy-only history when plan-records is absent', async () => {
    const legacy = path.join(root, 'session-manager-operations', 'reviews', 'validation', 'epic-3');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'old.md'), 'x');
    const r = await readMdReview(root, { epicIds: ['epic-3'] });
    expect(r.ok && r.validation).toEqual({ 'epic-3': ['session-manager-operations/reviews/validation/epic-3/old.md'] });
  });

  it('reads at most 256 KB of the record', async () => {
    const docs = path.join(root, 'session-manager-operations', 'reviews', 'docs');
    fs.mkdirSync(docs, { recursive: true });
    const big = '- Date: 2026-11-15\n## Decisions\n' + '- d\n'.repeat(100000) + '- LAST\n';
    fs.writeFileSync(path.join(docs, '2026-11-15-md-network.md'), big);
    const r = await readMdReview(root);
    expect(r.ok && r.record && r.record.decisions.length).toBe(Math.floor((256 * 1024 - 32) / 4));
    expect(r.ok && r.record && r.record.decisions.includes('LAST')).toBe(false);
  });
});
