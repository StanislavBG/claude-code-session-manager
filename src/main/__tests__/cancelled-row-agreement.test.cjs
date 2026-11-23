/**
 * cancelled-row-agreement.test.cjs — PRD 3830. The four former copies of the
 * "did a human cancel this row?" rule can never disagree again: ONE table of
 * row shapes (mirroring the exact fields remote.cancelJob writes) runs
 * through every reader of the cancel rule, and each reader's answer must
 * match isCancelledRow — and the table's expected answer.
 *
 * Readers: isCancelledRow, computeEpicOutsideState, evaluateEpicSettle,
 * makeDepResolver, budget.isNonProblemRow (pure), then queueOps
 * (autoDismissCancelled, dismissCancelled, archiveMany) and remote.listJobs
 * in one temp-HOME block.
 *
 * HOME is overridden BEFORE requiring scheduler.cjs (paths are baked at require).
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/cancelled-row-agreement.test.cjs
 */
'use strict';

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Every module is required AFTER HOME points at the temp dir (top-level
// beforeAll below): scheduler paths are baked at require time, and budget.cjs
// pulls scheduler deps in — a require before the override binds the real HOME.
let isCancelledRow;
let computeEpicOutsideState;
let evaluateEpicSettle;
let makeDepResolver;
let bareSlug;
let budget;
let scheduler;
let queueOps;
let config;
let activeIndexPath;
let tmpHome;
let originalHome;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cancelled-agreement-test-'));
  process.env.HOME = tmpHome;
  scheduler = require('../scheduler.cjs');
  queueOps = require('../queueOps.cjs');
  config = require('../config.cjs');
  budget = require('../scheduler/budget.cjs');
  ({ activeIndexPath } = require('../lib/epic/epicMint.cjs'));
  ({ isCancelledRow } = require('../lib/scheduler/cancelledRow.cjs'));
  ({ computeEpicOutsideState } = require('../lib/epic/epicOutsideState.cjs'));
  ({ evaluateEpicSettle } = require('../lib/epic/epicSettle.cjs'));
  ({ makeDepResolver, bareSlug } = require('../lib/prd/depSlugResolve.cjs'));
  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) throw new Error('PRDS_DIR not under temp HOME');
  CWD = path.join(tmpHome, 'proj');
  const projDir = path.join(tmpHome, '.claude', 'projects', 'fake-project-slug');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'session.jsonl'), `${JSON.stringify({ cwd: CWD })}\n`);
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const EPIC = 'agreement-fixture-epic';
const AT = '2026-11-23T10:00:00.000Z';
const LATER = '2026-11-23T10:00:01.000Z';
const CANCEL_REASON = 'cancelled via admin API';
const LANDED_REASON = 'cancelled via admin API, but landedCommit abc1234 resolves — verify before treating as done';
const CASCADE_REASON = 'cancelled via admin API (cascade: depends on cancelled 10-failed-cancel)';

// Set to <temp HOME>/proj by the top-level beforeAll.
let CWD = '/tmp/agreement-fixture-proj';

const h = (from, to, reason, source, at = AT) => ({ from, to, at, reason, source });

/**
 * The ONE shape table. `cancelled` is the expected answer of every reader.
 * Cancelled shapes mirror remote.cancelJob's mutate body exactly (status via
 * transitionJob with source 'remote:cancelJob', error, cancelledAt,
 * finishedAt, exitCode, cancelledRunId on a running cancel, verifierVerdict
 * when the landedCommit resolved).
 */
const SHAPES = [
  {
    name: 'failed+cancelledAt',
    cancelled: true,
    row: {
      slug: '10-failed-cancel', status: 'failed', error: CANCEL_REASON, cancelledAt: AT, finishedAt: AT, exitCode: null,
      statusHistory: [h('pending', 'failed', CANCEL_REASON, 'remote:cancelJob')],
    },
  },
  {
    name: 'needs_review+cancelledAt (landed commit)',
    cancelled: true,
    row: {
      slug: '11-review-cancel', status: 'needs_review', error: LANDED_REASON, cancelledAt: AT, cancelledRunId: 'run-11',
      finishedAt: AT, exitCode: null, landedCommit: 'abc1234', verifierVerdict: 'cancelled_with_landed_commit',
      statusHistory: [
        h('pending', 'running', 'dispatch', 'scheduler:dispatch'),
        h('running', 'needs_review', LANDED_REASON, 'remote:cancelJob', LATER),
      ],
    },
  },
  {
    name: 'cascaded dependent',
    cancelled: true,
    row: {
      slug: '12-cascaded', status: 'failed', error: CASCADE_REASON, cancelledAt: AT, finishedAt: AT, exitCode: null,
      statusHistory: [h('pending', 'failed', CASCADE_REASON, 'remote:cancelJob')],
    },
  },
  {
    name: 'statusHistory-only legacy row',
    cancelled: true,
    row: {
      slug: '13-legacy-history', status: 'failed', error: 'killed', finishedAt: AT,
      statusHistory: [
        h('pending', 'running', 'dispatch', 'scheduler:dispatch'),
        h('running', 'failed', CANCEL_REASON, 'remote:cancelJob', LATER),
      ],
    },
  },
  {
    name: 'error-only legacy row',
    cancelled: true,
    row: { slug: '14-legacy-error', status: 'failed', error: CANCEL_REASON, finishedAt: AT },
  },
  {
    name: 'real failure',
    cancelled: false,
    row: {
      slug: '15-real-failure', status: 'failed', error: 'gate failed: exit 1', finishedAt: AT, exitCode: 1,
      statusHistory: [
        h('pending', 'running', 'dispatch', 'scheduler:dispatch'),
        h('running', 'failed', 'exit 1', 'runner:finalize', LATER),
      ],
    },
  },
  {
    name: 'real needs_review park',
    cancelled: false,
    row: {
      slug: '16-real-park', status: 'needs_review', error: 'gate red', finishedAt: AT, exitCode: 1,
      statusHistory: [
        h('pending', 'running', 'dispatch', 'scheduler:dispatch'),
        h('running', 'needs_review', 'gate red', 'runner:finalize', LATER),
      ],
    },
  },
  {
    name: 'reset pending row',
    cancelled: false,
    row: {
      slug: '17-reset', status: 'pending',
      statusHistory: [
        h('pending', 'failed', CANCEL_REASON, 'remote:cancelJob'),
        h('failed', 'pending', 'reset', 'remote:resetJob', LATER),
      ],
    },
  },
];

/** A fresh copy of a shape's row with slug, cwd and epicId on it. */
function rowOf(shape, cwd = CWD) {
  return {
    title: shape.row.slug, cwd, epicId: EPIC, sourcePromptId: EPIC, dependsOn: [],
    ...JSON.parse(JSON.stringify(shape.row)),
  };
}

const CANCELLED_SLUGS = SHAPES.filter((s) => s.cancelled).map((s) => s.row.slug).sort();
const label = (shape, reader) => `shape "${shape.name}" · reader ${reader}`;

describe('pure readers agree with isCancelledRow on every shape', () => {
  test('the table covers both answers', () => {
    expect(CANCELLED_SLUGS.length).toBe(5);
    expect(SHAPES.length).toBe(8);
  });

  test.each(SHAPES.map((s) => [s.name, s]))('%s', (_name, shape) => {
    const row = rowOf(shape);
    const want = shape.cancelled;

    // isCancelledRow itself
    expect(isCancelledRow(row), label(shape, 'isCancelledRow')).toBe(want);

    // computeEpicOutsideState: counted in prds.cancelled, never failed/needsReview
    const outside = computeEpicOutsideState({ session: { id: EPIC, status: 'active' }, events: [], jobs: [row] });
    expect(outside.prds.total, label(shape, 'computeEpicOutsideState.total')).toBe(1);
    expect(outside.prds.cancelled === 1, label(shape, 'computeEpicOutsideState.prds.cancelled')).toBe(want);
    if (want) {
      expect(outside.prds.failed, label(shape, 'computeEpicOutsideState.prds.failed')).toBe(0);
      expect(outside.prds.needsReview, label(shape, 'computeEpicOutsideState.prds.needsReview')).toBe(0);
      expect(outside.blocked, label(shape, 'computeEpicOutsideState.blocked')).toBeNull();
    } else if (row.status === 'failed') {
      expect(outside.prds.failed, label(shape, 'computeEpicOutsideState.prds.failed')).toBe(1);
    } else if (row.status === 'needs_review') {
      expect(outside.prds.needsReview, label(shape, 'computeEpicOutsideState.prds.needsReview')).toBe(1);
    }

    // evaluateEpicSettle: cancelled vs parked
    const settle = evaluateEpicSettle({ epicId: EPIC, cwd: CWD, events: [], jobs: [row], now: Date.parse(AT) });
    expect(settle.cancelled.includes(row.slug), label(shape, 'evaluateEpicSettle.cancelled')).toBe(want);
    expect(settle.parked.includes(row.slug), label(shape, 'evaluateEpicSettle.parked'))
      .toBe(row.status === 'needs_review' && !want);

    // makeDepResolver: the row is dropped when a satisfied record shares its bare name
    const bare = bareSlug(row.slug);
    const satisfied = new Set([`99-${bare}`]);
    const dependent = { slug: '50-dependent', cwd: CWD, epicId: EPIC, status: 'pending', dependsOn: [bare] };
    const resolver = makeDepResolver([row, dependent], satisfied);
    const bareRes = resolver.resolve(bare, dependent);
    expect(bareRes.kind, label(shape, 'makeDepResolver(bare dep)')).toBe(want ? 'satisfied' : 'row');
    const prefixedRes = resolver.resolve(`20-${bare}`, dependent);
    expect(prefixedRes.rows.includes(row), label(shape, 'makeDepResolver(prefixed dep)')).toBe(!want);
    // Without a satisfied twin the row is never dropped.
    expect(makeDepResolver([row, dependent], new Set()).resolve(bare, dependent).kind,
      label(shape, 'makeDepResolver(no satisfied twin)')).toBe('row');

    // budget.isNonProblemRow: a cancel is not a problem; nothing else in the table is
    expect(budget.isNonProblemRow(row), label(shape, 'budget.isNonProblemRow')).toBe(want);
  });
});

describe('queueOps + remote.listJobs agree with isCancelledRow (temp HOME)', () => {
  const cwdOf = () => path.join(tmpHome, 'proj');
  const epicDir = () => path.join(cwdOf(), 'session-manager-operations', 'scheduler', 'epics', EPIC);
  const prdsDir = () => path.join(epicDir(), 'prds');

  function filesUnder(sub) {
    const root = path.join(epicDir(), sub);
    if (!fs.existsSync(root)) return [];
    const out = [];
    for (const ts of fs.readdirSync(root)) for (const f of fs.readdirSync(path.join(root, ts))) out.push(f);
    return out.sort();
  }

  async function queueJobs() {
    const queuePath = path.join(cwdOf(), 'session-manager-operations', 'scheduler', 'state', 'queue.json');
    return JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  }

  async function seedAll() {
    const cwd = cwdOf();
    config.addAllowedRoot(cwd);
    fs.mkdirSync(prdsDir(), { recursive: true });
    for (const s of SHAPES) {
      fs.writeFileSync(path.join(prdsDir(), `${s.row.slug}.md`),
        `---\ntitle: ${s.row.slug}\ncwd: ${cwd}\nestimateMinutes: 10\nepicId: ${EPIC}\nsourcePromptId: ${EPIC}\n---\n\n# Goal\n\nx\n`);
    }
    await scheduler.writeQueue({ jobs: SHAPES.map((s) => rowOf(s, cwd)), config: {}, paused: null });
    // The seeded rows must still answer as the table says (writeQueue kept every marker).
    const seeded = await queueJobs();
    for (const s of SHAPES) {
      const j = seeded.find((x) => x.slug === s.row.slug);
      expect(j, label(s, 'writeQueue')).toBeTruthy();
      expect(isCancelledRow(j), label(s, 'isCancelledRow(seeded row)')).toBe(s.cancelled);
    }
    return cwd;
  }

  function writeEpicStatus(status) {
    const file = activeIndexPath(cwdOf());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sessions: { [EPIC]: { id: EPIC, status } }, events: {}, tombstones: {} }));
  }

  beforeEach(async () => {
    await scheduler.writeQueue({ jobs: [], config: {}, paused: null });
    fs.rmSync(path.join(cwdOf(), 'session-manager-operations', 'scheduler', 'epics'), { recursive: true, force: true });
    fs.rmSync(path.join(cwdOf(), 'session-manager-operations', 'prompt-sessions'), { recursive: true, force: true });
    // An open Epic by default: only the auto-dismiss test closes it.
    writeEpicStatus('active');
  });

  test('autoDismissCancelled on a completed Epic dismisses exactly the cancelled shapes', async () => {
    await seedAll();
    writeEpicStatus('completed');
    const state = { jobs: await queueJobs() };
    const res = await queueOps.autoDismissCancelled(state);
    const dismissed = new Set(res.dismissed);
    const kept = new Set(state.jobs.map((j) => j.slug));
    for (const s of SHAPES) {
      expect(dismissed.has(s.row.slug), label(s, 'queueOps.autoDismissCancelled')).toBe(s.cancelled);
      expect(kept.has(s.row.slug), label(s, 'queueOps.autoDismissCancelled (row kept)')).toBe(!s.cancelled);
    }
    expect(filesUnder('prds-cancelled')).toEqual(CANCELLED_SLUGS.map((s) => `${s}.md`));
  });

  test('dismissCancelled returns ok for the cancelled shapes and notCancelled for the rest', async () => {
    const cwd = await seedAll();
    for (const s of SHAPES) {
      const res = await queueOps.dismissCancelled(s.row.slug, cwd);
      if (s.cancelled) {
        expect(res.ok, `${label(s, 'queueOps.dismissCancelled')}: ${res.error ?? ''}`).toBe(true);
        expect(res.notCancelled, label(s, 'queueOps.dismissCancelled')).toBeUndefined();
      } else {
        expect(res.ok, label(s, 'queueOps.dismissCancelled')).toBe(false);
        expect(res.notCancelled, label(s, 'queueOps.dismissCancelled')).toBe(true);
      }
    }
    const left = (await queueJobs()).map((j) => j.slug).sort();
    expect(left).toEqual(SHAPES.filter((s) => !s.cancelled).map((s) => s.row.slug).sort());
    expect(filesUnder('prds-cancelled')).toEqual(CANCELLED_SLUGS.map((s) => `${s}.md`));
  });

  test('archiveMany refuses exactly the cancelled shapes', async () => {
    const cwd = await seedAll();
    const res = await queueOps.archiveMany(SHAPES.map((s) => s.row.slug), cwd, { retire: false });
    const refused = new Set(res.results.filter((r) => r.cancelled === true).map((r) => r.slug));
    for (const s of SHAPES) {
      expect(refused.has(s.row.slug), label(s, 'queueOps.archiveMany (refused)')).toBe(s.cancelled);
      expect(fs.existsSync(path.join(prdsDir(), `${s.row.slug}.md`)), label(s, 'queueOps.archiveMany (PRD file stays)'))
        .toBe(s.cancelled);
    }
    expect((res.warnings ?? []).length).toBe(CANCELLED_SLUGS.length);
    const archived = filesUnder('prds-archived');
    for (const slug of CANCELLED_SLUGS) expect(archived.includes(`${slug}.md`), `${slug} must not be archived`).toBe(false);
  });

  test('remote.listJobs carries cancelled: true exactly on the cancelled shapes', async () => {
    await seedAll();
    const jobs = await scheduler.remote.listJobs();
    const bySlug = new Map(jobs.map((j) => [j.slug, j]));
    for (const s of SHAPES) {
      const j = bySlug.get(s.row.slug);
      expect(j, label(s, 'remote.listJobs (row listed)')).toBeTruthy();
      expect(j.status, label(s, 'remote.listJobs (status kept)')).toBe(s.row.status);
      expect(j.cancelled === true, label(s, 'remote.listJobs.cancelled')).toBe(s.cancelled);
      if (!s.cancelled) {
        expect(Object.prototype.hasOwnProperty.call(j, 'cancelled'), label(s, 'remote.listJobs (no cancelled key)')).toBe(false);
      }
    }
  });
});
