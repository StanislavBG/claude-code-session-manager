'use strict';

import { beforeAll, describe, expect, test, vi } from 'vitest';
const { clearMainModuleCache } = require('./_helpers/schedulerHarness.cjs');

describe("tab", () => {
  beforeAll(() => {
    clearMainModuleCache();
    ({ notifyOriginatingTab, isNotifiableTerminalStatus } = require('../scheduler.cjs'));
  });

  /**
   * scheduler-notify-originating-tab.test.cjs — unit tests for
   * notifyOriginatingTab (PRD 761): on a job's terminal completed/failed
   * transition, push a short status prompt into the chat tab that originated
   * it via enqueueExternalPrompt (PRD 753).
   *
   * Run: npx vitest run src/main/__tests__/scheduler-notify-originating-tab.test.cjs
   */

  let notifyOriginatingTab;
  let isNotifiableTerminalStatus;

  test('isNotifiableTerminalStatus: completed and failed are notifiable', () => {
    expect(isNotifiableTerminalStatus('completed')).toBe(true);
    expect(isNotifiableTerminalStatus('failed')).toBe(true);
  });

  test('isNotifiableTerminalStatus: needs_review is not notifiable (may still auto-fix)', () => {
    expect(isNotifiableTerminalStatus('needs_review')).toBe(false);
  });

  test('isNotifiableTerminalStatus: a rateLimited exit never reaches an effectiveStatus (undefined) and is not notifiable', () => {
    // spawnJob's treatAsPending branch (rateLimited || paused for rate_limit)
    // resets the job to pending and returns before effectiveStatus is ever
    // computed — so this hook is only ever evaluated with undefined/pending,
    // never with a real status, on that path.
    expect(isNotifiableTerminalStatus(undefined)).toBe(false);
    expect(isNotifiableTerminalStatus('pending')).toBe(false);
  });

  test('resolves via sourceTabId when present on the PRD frontmatter', async () => {
    const sendPrompt = vi.fn();
    const parsePrdRaw = vi.fn(async () => ({ sourceTabId: 'tab-from-frontmatter' }));
    const loadSessions = vi.fn(async () => ({ tabs: [] }));

    await notifyOriginatingTab(
      { slug: '761-notify', status: 'completed', cwd: '/some/cwd' },
      { parsePrdRaw, loadSessions, sendPrompt },
    );

    expect(loadSessions).not.toHaveBeenCalled();
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledWith(
      'tab-from-frontmatter',
      expect.stringContaining('761-notify'),
      expect.objectContaining({ origin: 'scheduler' }),
    );
  });

  test('falls back to the first open tab whose cwd matches the job cwd', async () => {
    const sendPrompt = vi.fn();
    const parsePrdRaw = vi.fn(async () => ({ sourceTabId: null }));
    const loadSessions = vi.fn(async () => ({
      tabs: [
        { id: 'tab-other', cwd: '/other/cwd' },
        { id: 'tab-match', cwd: '/some/cwd' },
        { id: 'tab-second-match', cwd: '/some/cwd' },
      ],
    }));

    await notifyOriginatingTab(
      { slug: '761-notify', status: 'failed', cwd: '/some/cwd' },
      { parsePrdRaw, loadSessions, sendPrompt },
    );

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledWith('tab-match', expect.stringContaining('761-notify'), expect.objectContaining({ origin: 'scheduler' }));
  });

  test('no-ops without throwing when neither sourceTabId nor a cwd-matching tab resolves', async () => {
    const sendPrompt = vi.fn();
    const parsePrdRaw = vi.fn(async () => ({ sourceTabId: null }));
    const loadSessions = vi.fn(async () => ({ tabs: [{ id: 'tab-other', cwd: '/unrelated' }] }));

    await expect(
      notifyOriginatingTab(
        { slug: '761-notify', status: 'completed', cwd: '/some/cwd' },
        { parsePrdRaw, loadSessions, sendPrompt },
      ),
    ).resolves.not.toThrow();

    expect(sendPrompt).not.toHaveBeenCalled();
  });

  test('no-ops when parsing the PRD frontmatter throws', async () => {
    const sendPrompt = vi.fn();
    const parsePrdRaw = vi.fn(async () => { throw new Error('ENOENT'); });
    const loadSessions = vi.fn(async () => ({ tabs: [] }));

    await expect(
      notifyOriginatingTab(
        { slug: '761-notify', status: 'completed', cwd: '/some/cwd' },
        { parsePrdRaw, loadSessions, sendPrompt },
      ),
    ).resolves.not.toThrow();

    expect(sendPrompt).not.toHaveBeenCalled();
  });

  // PRD 814: a dev-work ticket's completion notification routes into its own
  // PromptSession's event chain instead of an unrelated tab, when the PRD's
  // sourcePromptId resolves to a known, still-active PromptSession.
  test('routes into the known PromptSession event chain and never falls back to a tab prompt', async () => {
    const sendPrompt = vi.fn();
    const appendResponseEvent = vi.fn(async () => true);
    const parsePrdRaw = vi.fn(async () => ({ sourcePromptId: 'psess-1', sourceTabId: 'tab-x' }));
    const loadSessions = vi.fn(async () => ({ tabs: [] }));

    await notifyOriginatingTab(
      { slug: '814-notify', status: 'completed', cwd: '/some/cwd' },
      { parsePrdRaw, loadSessions, sendPrompt, appendResponseEvent },
    );

    expect(appendResponseEvent).toHaveBeenCalledWith(
      '/some/cwd',
      'psess-1',
      expect.stringContaining('814-notify'),
      { prdSlug: '814-notify', outcome: 'completed', validation: 'unvalidated' },
    );
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  test('falls back to the tab-external-ticket path when sourcePromptId does not resolve to a known PromptSession', async () => {
    const sendPrompt = vi.fn();
    const appendResponseEvent = vi.fn(async () => false);
    const parsePrdRaw = vi.fn(async () => ({ sourcePromptId: 'psess-unknown', sourceTabId: 'tab-x' }));
    const loadSessions = vi.fn(async () => ({ tabs: [] }));

    await notifyOriginatingTab(
      { slug: '814-notify', status: 'completed', cwd: '/some/cwd' },
      { parsePrdRaw, loadSessions, sendPrompt, appendResponseEvent },
    );

    expect(appendResponseEvent).toHaveBeenCalled();
    expect(sendPrompt).toHaveBeenCalledWith('tab-x', expect.stringContaining('814-notify'), expect.objectContaining({ origin: 'scheduler' }));
  });

  test('falls back to the tab-external-ticket path when the PRD has no sourcePromptId at all (pre-813 PRD)', async () => {
    const sendPrompt = vi.fn();
    const appendResponseEvent = vi.fn(async () => true);
    const parsePrdRaw = vi.fn(async () => ({ sourcePromptId: null, sourceTabId: 'tab-x' }));
    const loadSessions = vi.fn(async () => ({ tabs: [] }));

    await notifyOriginatingTab(
      { slug: '814-notify', status: 'completed', cwd: '/some/cwd' },
      { parsePrdRaw, loadSessions, sendPrompt, appendResponseEvent },
    );

    expect(appendResponseEvent).not.toHaveBeenCalled();
    expect(sendPrompt).toHaveBeenCalledWith('tab-x', expect.stringContaining('814-notify'), expect.objectContaining({ origin: 'scheduler' }));
  });

  // PRD 854: a PRD dispatched straight from an Epic's own composer
  // (dispatchPromptSessionToPrd) never sets sourceTabId — only sourcePromptId.
  // If the Epic has since gone completed (appendResponseEvent returns false),
  // the fallback must still target sourcePromptId itself as the chat:external-
  // send id, since the renderer now resolves that id against known Epics too.
  test('falls back to sourcePromptId as the external-send target when sourceTabId is absent', async () => {
    const sendPrompt = vi.fn();
    const appendResponseEvent = vi.fn(async () => false);
    const parsePrdRaw = vi.fn(async () => ({ sourcePromptId: 'epic-1', sourceTabId: null }));
    const loadSessions = vi.fn(async () => ({ tabs: [] }));

    await notifyOriginatingTab(
      { slug: '854-notify', status: 'completed', cwd: '/some/cwd' },
      { parsePrdRaw, loadSessions, sendPrompt, appendResponseEvent },
    );

    expect(appendResponseEvent).toHaveBeenCalled();
    expect(loadSessions).not.toHaveBeenCalled();
    expect(sendPrompt).toHaveBeenCalledWith('epic-1', expect.stringContaining('854-notify'), expect.objectContaining({ origin: 'scheduler' }));
  });

  test('falls back to the tab-external-ticket path when appendResponseEvent itself throws', async () => {
    const sendPrompt = vi.fn();
    const appendResponseEvent = vi.fn(async () => { throw new Error('disk error'); });
    const parsePrdRaw = vi.fn(async () => ({ sourcePromptId: 'psess-1', sourceTabId: 'tab-x' }));
    const loadSessions = vi.fn(async () => ({ tabs: [] }));

    await expect(
      notifyOriginatingTab(
        { slug: '814-notify', status: 'completed', cwd: '/some/cwd' },
        { parsePrdRaw, loadSessions, sendPrompt, appendResponseEvent },
      ),
    ).resolves.not.toThrow();

    expect(sendPrompt).toHaveBeenCalledWith('tab-x', expect.stringContaining('814-notify'), expect.objectContaining({ origin: 'scheduler' }));
  });

  // ─── PRD 985: real path resolution ───────────────────────────────────────────
  // Every test above injects a stubbed `parsePrdRaw`, which is exactly why the
  // bug PRD 985 fixes shipped green: notifyOriginatingTab resolved its PRD via
  // prdPathForJob → the RETIRED flat `scheduler/prds/` dir (today only
  // `.reserved-NNN` stubs, no PRDs), and archiveCompletedPrd renames the file
  // into `prds-archived/` immediately BEFORE notify runs anyway. `prd` was
  // therefore always null on the completed path and no response event was ever
  // appended. These two tests use the REAL parsePrdRaw against a temp tree so
  // the resolution logic itself is covered, not mocked away.

  const fs = require('node:fs');
  const os = require('node:os');
  const nodePath = require('node:path');

  function makeEpicTree({ epicId, slug, archived }) {
    const cwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'sm-notify-985-'));
    const dir = nodePath.join(
      cwd, 'session-manager-operations', 'scheduler', 'epics', epicId,
      archived ? 'prds-archived' : 'prds',
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      nodePath.join(dir, `${slug}.md`),
      `---\ntitle: notify 985\ncwd: ${cwd}\nsourcePromptId: ${epicId}\n---\n\nbody\n`,
      'utf8',
    );
    return cwd;
  }

  test('PRD 985: an ARCHIVED-only PRD still routes its check-in to the authoring Epic', async () => {
    const epicId = 'psess-985-archived';
    const slug = '985-archived-twin';
    const cwd = makeEpicTree({ epicId, slug, archived: true });

    const appendResponseEvent = vi.fn(async () => true);
    const appendTranscriptTurn = vi.fn(async () => {});
    const sendPrompt = vi.fn();
    const loadSessions = vi.fn(async () => ({ tabs: [] }));

    // NOTE: no parsePrdRaw override — the real one runs against the temp tree.
    await notifyOriginatingTab(
      { slug, status: 'completed', cwd, epicId: null },
      { loadSessions, sendPrompt, appendResponseEvent, appendTranscriptTurn, readResultFromLog: () => null },
    );

    expect(appendResponseEvent).toHaveBeenCalledTimes(1);
    expect(appendResponseEvent).toHaveBeenCalledWith(
      cwd, epicId, expect.stringContaining(slug),
      expect.objectContaining({ prdSlug: slug, outcome: 'completed' }),
    );
    expect(appendTranscriptTurn).toHaveBeenCalledWith(cwd, epicId, expect.anything());
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  test('PRD 985: a PRD missing entirely still routes via the job row\'s own epicId', async () => {
    const cwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'sm-notify-985-none-'));
    const appendResponseEvent = vi.fn(async () => true);
    const appendTranscriptTurn = vi.fn(async () => {});
    const sendPrompt = vi.fn();
    const loadSessions = vi.fn(async () => ({ tabs: [] }));

    await notifyOriginatingTab(
      { slug: '985-no-prd-on-disk', status: 'failed', cwd, epicId: 'psess-985-from-queue-row' },
      { loadSessions, sendPrompt, appendResponseEvent, appendTranscriptTurn, readResultFromLog: () => null },
    );

    expect(appendResponseEvent).toHaveBeenCalledWith(
      cwd, 'psess-985-from-queue-row', expect.stringContaining('985-no-prd-on-disk'),
      expect.objectContaining({ prdSlug: '985-no-prd-on-disk', outcome: 'failed' }),
    );
    expect(appendTranscriptTurn).toHaveBeenCalledWith(cwd, 'psess-985-from-queue-row', expect.anything());
  });

  // ─── PRD 1407: validator jobs stamp verdicts onto the authoring Epic ────────
  // A completed validator job's result text carries one `VALIDATION: <slug>
  // VERIFIED|REFUTED` line per PRD it checked. Each parsed verdict becomes its
  // own response event BEFORE the validator's own (still-unvalidated)
  // check-in, and the validator's check-in never enqueues a validation prompt
  // for itself.
  test('PRD 1407: a validator job with two sentinel lines appends two verdict events plus its own check-in, and never enqueues validation', async () => {
    const sendPrompt = vi.fn();
    const appendResponseEvent = vi.fn(async () => true);
    const appendTranscriptTurn = vi.fn(async () => {});
    const scheduleSettle = vi.fn();
    const parsePrdRaw = vi.fn(async () => ({ sourcePromptId: 'psess-validator-1' }));
    const loadSessions = vi.fn(async () => ({ tabs: [] }));
    const readResultFromLog = vi.fn(() => '{"schedulerVerdict":"PASS"}');
    // PRD 3614: verdicts come from the result event's structured_output.
    const readStructuredFromLog = vi.fn(() => ({
      schedulerVerdict: 'PASS',
      verdicts: [
        { prd: '111-alpha', verdict: 'VERIFIED', reason: '', criteria: [], findings: [] },
        { prd: '222-beta', verdict: 'REFUTED', reason: 'missing coverage', criteria: [{ id: '1', met: false, evidence: 'no test', missKind: 'missing-test' }], findings: [] },
      ],
    }));
    const writeVerdictsFile = vi.fn(async () => {});

    await notifyOriginatingTab(
      { slug: '1407-validator-run', status: 'completed', cwd: '/some/cwd', agentType: 'validator' },
      {
        parsePrdRaw, loadSessions, sendPrompt, appendResponseEvent,
        appendTranscriptTurn, readResultFromLog, readStructuredFromLog, writeVerdictsFile, scheduleSettle,
      },
    );

    expect(appendResponseEvent).toHaveBeenCalledTimes(3);
    expect(appendResponseEvent).toHaveBeenNthCalledWith(
      1, '/some/cwd', 'psess-validator-1', expect.stringContaining('111-alpha'),
      { prdSlug: '111-alpha', outcome: 'completed', validation: 'verified', reason: '', missKinds: [], validator: '1407-validator-run' },
    );
    expect(appendResponseEvent).toHaveBeenNthCalledWith(
      2, '/some/cwd', 'psess-validator-1', expect.stringContaining('222-beta'),
      { prdSlug: '222-beta', outcome: 'completed', validation: 'refuted', reason: 'missing coverage', missKinds: ['missing-test'], validator: '1407-validator-run' },
    );
    expect(appendResponseEvent).toHaveBeenNthCalledWith(
      3, '/some/cwd', 'psess-validator-1', expect.stringContaining('1407-validator-run'),
      { prdSlug: '1407-validator-run', outcome: 'completed', agentType: 'validator', validation: 'unvalidated' },
    );
    expect(scheduleSettle).toHaveBeenCalledTimes(1);
    expect(scheduleSettle).toHaveBeenCalledWith({ cwd: '/some/cwd', epicId: 'psess-validator-1' });
    expect(appendResponseEvent).toHaveBeenLastCalledWith(
      '/some/cwd', 'psess-validator-1', expect.any(String),
      expect.objectContaining({ agentType: 'validator' }),
    );
  });

  // ─── PRD 1408: a downstream validator suppresses the per-PRD validation ask ─
  test('settle: a completed job arms scheduleSettle once with { cwd, epicId } and stamps no agentType when absent', async () => {
    const appendResponseEvent = vi.fn(async () => true);
    const scheduleSettle = vi.fn();
    await notifyOriginatingTab(
      { slug: '1408-work-item', status: 'completed', cwd: '/some/cwd' },
      {
        parsePrdRaw: vi.fn(async () => ({ sourcePromptId: 'psess-1' })),
        loadSessions: vi.fn(async () => ({ tabs: [] })),
        sendPrompt: vi.fn(), appendResponseEvent, scheduleSettle,
      },
    );
    expect(scheduleSettle).toHaveBeenCalledTimes(1);
    expect(scheduleSettle).toHaveBeenCalledWith({ cwd: '/some/cwd', epicId: 'psess-1' });
    expect(appendResponseEvent.mock.calls[0][3]).not.toHaveProperty('agentType');
  });

  test('settle: not called when the check-in append is refused', async () => {
    const scheduleSettle = vi.fn();
    await notifyOriginatingTab(
      { slug: '1408-work-item', status: 'completed', cwd: '/some/cwd' },
      {
        parsePrdRaw: vi.fn(async () => ({ sourcePromptId: 'psess-1' })),
        loadSessions: vi.fn(async () => ({ tabs: [] })),
        sendPrompt: vi.fn(), appendResponseEvent: vi.fn(async () => false), scheduleSettle,
      },
    );
    expect(scheduleSettle).not.toHaveBeenCalled();
  });

  test('settle: a throwing scheduleSettle is caught', async () => {
    await expect(notifyOriginatingTab(
      { slug: '1408-work-item', status: 'completed', cwd: '/some/cwd' },
      {
        parsePrdRaw: vi.fn(async () => ({ sourcePromptId: 'psess-1' })),
        loadSessions: vi.fn(async () => ({ tabs: [] })),
        sendPrompt: vi.fn(), appendResponseEvent: vi.fn(async () => true),
        scheduleSettle: vi.fn(() => { throw new Error('boom'); }),
      },
    )).resolves.toBeUndefined();
  });
});

describe("transcript", () => {
  beforeAll(() => {
    clearMainModuleCache();
    ({ notifyOriginatingTab, extractResultTextFromLog } = require('../scheduler.cjs'));
  });

  /**
   * scheduler-notify-originating-tab-transcript.test.cjs — unit tests for the
   * PRD 863 addition to notifyOriginatingTab: persisting the job's real
   * result text (read from the run's log) to the durable per-Epic transcript
   * store, independent of the existing short-status-chip notification.
   *
   * Run: npx vitest run src/main/__tests__/scheduler-notify-originating-tab.test.cjs
   */

  let notifyOriginatingTab;
  let extractResultTextFromLog;

  test('extractResultTextFromLog returns null for a missing log path', () => {
    expect(extractResultTextFromLog(null)).toBeNull();
    expect(extractResultTextFromLog('/does/not/exist.log')).toBeNull();
  });

  test('appends the job result text to the transcript store when sourcePromptId is known', async () => {
    const appendTranscriptTurn = vi.fn(async () => true);
    const readResultFromLog = vi.fn(() => 'the real agent result text');
    const appendResponseEvent = vi.fn(async () => true);
    const parsePrdRaw = vi.fn(async () => ({ sourcePromptId: 'psess-abc' }));

    await notifyOriginatingTab(
      { slug: '863-transcript', status: 'completed', cwd: '/some/cwd', runId: 'run-1' },
      { parsePrdRaw, appendResponseEvent, appendTranscriptTurn, readResultFromLog },
    );

    expect(appendTranscriptTurn).toHaveBeenCalledTimes(1);
    expect(appendTranscriptTurn).toHaveBeenCalledWith('/some/cwd', 'psess-abc', {
      role: 'assistant',
      text: 'the real agent result text',
      eventId: 'prd-result:863-transcript:run-1',
    });
  });

  test('falls back to the short status message when the run log has no result text', async () => {
    const appendTranscriptTurn = vi.fn(async () => true);
    const readResultFromLog = vi.fn(() => null);
    const appendResponseEvent = vi.fn(async () => true);
    const parsePrdRaw = vi.fn(async () => ({ sourcePromptId: 'psess-abc' }));

    await notifyOriginatingTab(
      { slug: '863-fallback', status: 'completed', cwd: '/some/cwd', runId: 'run-1' },
      { parsePrdRaw, appendResponseEvent, appendTranscriptTurn, readResultFromLog },
    );

    expect(appendTranscriptTurn).toHaveBeenCalledWith(
      '/some/cwd',
      'psess-abc',
      expect.objectContaining({ text: expect.stringContaining('863-fallback') }),
    );
  });

  test('a throwing transcript append never breaks the existing notification path', async () => {
    const appendTranscriptTurn = vi.fn(async () => {
      throw new Error('disk full');
    });
    const readResultFromLog = vi.fn(() => 'result text');
    const appendResponseEvent = vi.fn(async () => true);
    const parsePrdRaw = vi.fn(async () => ({ sourcePromptId: 'psess-abc' }));

    await expect(
      notifyOriginatingTab(
        { slug: '863-safe', status: 'completed', cwd: '/some/cwd', runId: 'run-1' },
        { parsePrdRaw, appendResponseEvent, appendTranscriptTurn, readResultFromLog },
      ),
    ).resolves.toBeUndefined();

    expect(appendResponseEvent).toHaveBeenCalledTimes(1);
  });

  test('no cwd on the job skips the transcript append but does not throw', async () => {
    const appendTranscriptTurn = vi.fn(async () => true);
    const readResultFromLog = vi.fn(() => 'result text');
    const appendResponseEvent = vi.fn(async () => true);
    const parsePrdRaw = vi.fn(async () => ({ sourcePromptId: 'psess-abc' }));

    await notifyOriginatingTab(
      { slug: '863-nocwd', status: 'completed', cwd: null, runId: 'run-1' },
      { parsePrdRaw, appendResponseEvent, appendTranscriptTurn, readResultFromLog },
    );

    expect(appendTranscriptTurn).not.toHaveBeenCalled();
  });

  test('skipped job with blockedDependents sends the dedicated prd-missing message (capped at 10)', async () => {
    const appendResponseEvent = vi.fn(async () => true);
    const parsePrdRaw = vi.fn(async () => ({ sourcePromptId: 'psess-abc' }));
    const deps = Array.from({ length: 12 }, (_, n) => `dep-${n + 1}`);

    await notifyOriginatingTab(
      { slug: '2071-skipped', status: 'skipped', cwd: '/some/cwd', blockedDependents: deps },
      { parsePrdRaw, appendResponseEvent, appendTranscriptTurn: vi.fn(async () => true), readResultFromLog: vi.fn(() => '') },
    );

    expect(appendResponseEvent).toHaveBeenCalledTimes(1);
    const text = JSON.stringify(appendResponseEvent.mock.calls[0]);
    expect(text).toContain('PRD 2071-skipped was skipped: its PRD source could not be found on disk.');
    expect(text).toContain('Blocked dependents: dep-1, dep-2');
    expect(text).toContain('dep-10 (+2 more)');
    expect(text).not.toContain('dep-11');
    expect(text).toContain('scheduler_reset_job with force:true');
    expect(text).toContain('scheduler_archive_prd');
  });

  describe('macro background-build DONE/FAILED notice (PRD 3116)', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const nodePath = require('node:path');

    function mkProject() {
      const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'sm-3116-'));
      fs.mkdirSync(nodePath.join(dir, 'session-manager-operations'), { recursive: true });
      return dir;
    }
    function writeEntry(cwd, kind, id, meta) {
      const d = nodePath.join(cwd, 'session-manager-operations', 'project-pages', kind, id);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(nodePath.join(d, 'index.html'), '<html></html>');
      if (meta !== undefined) fs.writeFileSync(nodePath.join(d, 'meta.json'), typeof meta === 'string' ? meta : JSON.stringify(meta));
    }
    async function run(job, prd) {
      const appendResponseEvent = vi.fn(async () => true);
      const appendTranscriptTurn = vi.fn(async () => true);
      await notifyOriginatingTab(job, {
        parsePrdRaw: vi.fn(async () => ({ sourcePromptId: 'psess-m', ...prd })),
        appendResponseEvent,
        appendTranscriptTurn,
        readResultFromLog: vi.fn(() => 'result text'),
        scheduleSettle: vi.fn(),
      });
      return { appendResponseEvent, appendTranscriptTurn };
    }

    test('video artifact → DONE text naming title, length, style + build-done notice + buildOutput', async () => {
      const cwd = mkProject();
      writeEntry(cwd, 'videos', 'vid-mwguqdcvt42', {
        title: 'Portfolio reasoning, pitched like a startup', kind: 'demo', style: 'animated-whiteboard', lengthS: 30,
      });
      const { appendResponseEvent } = await run(
        { slug: '9000-demo-video', status: 'completed', cwd, runId: 'r1' },
        { macroId: 'builtin-demo-video', deliverable: 'artifact', artifactPaths: ['session-manager-operations/project-pages/videos/vid-mwguqdcvt42/index.html'] },
      );
      expect(appendResponseEvent).toHaveBeenCalledTimes(1);
      const [c, e, text, meta] = appendResponseEvent.mock.calls[0];
      expect(c).toBe(cwd);
      expect(e).toBe('psess-m');
      expect(text).toBe('DONE — Demo Video: “Portfolio reasoning, pitched like a startup” is saved (30 s · animated-whiteboard). Watch it in Project Home ▸ Videos.');
      expect(meta).toMatchObject({
        prdSlug: '9000-demo-video',
        outcome: 'completed',
        notice: 'build-done',
        buildOutput: { kind: 'video', id: 'vid-mwguqdcvt42', title: 'Portfolio reasoning, pitched like a startup' },
      });
    });

    test('knowledge artifact → DONE text pointing at Pages', async () => {
      const cwd = mkProject();
      writeEntry(cwd, 'knowledge', 'overview', { title: 'Overview' });
      const { appendResponseEvent } = await run(
        { slug: '9001-home', status: 'completed', cwd },
        { macroId: 'builtin-project-home', artifactPaths: ['session-manager-operations/project-pages/knowledge/overview/index.html'] },
      );
      const [, , text, meta] = appendResponseEvent.mock.calls[0];
      expect(text).toBe('DONE — Project Home: “Overview” is saved. Read it in Project Home ▸ Pages.');
      expect(meta).toMatchObject({ notice: 'build-done', buildOutput: { kind: 'knowledge', id: 'overview', title: 'Overview' } });
    });

    test('missing, malformed or oversized meta.json → label-only DONE, never throws', async () => {
      const cwd = mkProject();
      writeEntry(cwd, 'videos', 'vid-missing');
      writeEntry(cwd, 'videos', 'vid-bad', '{not json');
      writeEntry(cwd, 'videos', 'vid-big', JSON.stringify({ title: 'x', pad: 'a'.repeat(300 * 1024) }));
      for (const id of ['vid-missing', 'vid-bad', 'vid-big']) {
        const { appendResponseEvent } = await run(
          { slug: `9002-${id}`, status: 'completed', cwd },
          { macroId: 'builtin-demo-video', artifactPaths: [`session-manager-operations/project-pages/videos/${id}/index.html`] },
        );
        const [, , text, meta] = appendResponseEvent.mock.calls[0];
        expect(text).toBe('DONE — Demo Video finished.');
        expect(meta.notice).toBe('build-done');
        expect(meta).not.toHaveProperty('buildOutput');
      }
    });

    test('unknown macroId label falls back to PRD title minus ": background build", then macroId', async () => {
      const cwd = mkProject();
      let { appendResponseEvent } = await run(
        { slug: '9003-x', status: 'completed', cwd },
        { macroId: 'custom-thing', title: 'My Tool: background build', artifactPaths: null },
      );
      expect(appendResponseEvent.mock.calls[0][2]).toBe('DONE — My Tool finished.');
      ({ appendResponseEvent } = await run(
        { slug: '9003-y', status: 'completed', cwd },
        { macroId: 'custom-thing' },
      ));
      expect(appendResponseEvent.mock.calls[0][2]).toBe('DONE — custom-thing finished.');
    });

    test('failed macro PRD → FAILED text with reason (error, else verifierVerdict, else status) + build-failed notice', async () => {
      const cwd = mkProject();
      const prd = { macroId: 'builtin-demo-video', artifactPaths: ['session-manager-operations/project-pages/videos/vid-a/index.html'] };
      let { appendResponseEvent } = await run({ slug: '9004-a', status: 'failed', cwd, error: 'timeout after 45m' }, prd);
      expect(appendResponseEvent.mock.calls[0][2]).toBe('FAILED — Demo Video: the background build failed (timeout after 45m). Press it again in Project Home to retry.');
      expect(appendResponseEvent.mock.calls[0][3]).toMatchObject({ notice: 'build-failed', outcome: 'failed' });
      ({ appendResponseEvent } = await run({ slug: '9004-b', status: 'failed', cwd, verifierVerdict: 'fail' }, prd));
      expect(appendResponseEvent.mock.calls[0][2]).toContain('(fail)');
      ({ appendResponseEvent } = await run({ slug: '9004-c', status: 'failed', cwd }, prd));
      expect(appendResponseEvent.mock.calls[0][2]).toContain('(failed)');
    });

    test('failed approved final run of a video review → points at the entry Retry button', async () => {
      const cwd = mkProject();
      const reviewDir = nodePath.join(cwd, 'session-manager-operations', 'project-pages', 'videos', 'vid-final1', 'review');
      fs.mkdirSync(reviewDir, { recursive: true });
      fs.writeFileSync(nodePath.join(reviewDir, 'dispatch.json'), JSON.stringify({
        entryId: 'vid-final1', macroId: 'builtin-demo-video', slug: '9020-final', stage: 'final', dispatchedAt: new Date().toISOString(),
      }));
      const prd = { macroId: 'builtin-demo-video', artifactPaths: ['session-manager-operations/project-pages/videos/vid-final1/index.html'] };
      let { appendResponseEvent } = await run({ slug: '9020-final', status: 'failed', cwd, error: 'gate red' }, prd);
      expect(appendResponseEvent.mock.calls[0][2]).toBe('FAILED — Demo Video: the approved final run for entry vid-final1 failed (gate red). Press Retry on it in Project Home ▸ Video; your approval is kept.');
      expect(appendResponseEvent.mock.calls[0][3]).toMatchObject({ notice: 'build-failed', outcome: 'failed' });
      // A different slug, or a non-final stage, keeps today's message.
      ({ appendResponseEvent } = await run({ slug: '9020-other', status: 'failed', cwd, error: 'gate red' }, prd));
      expect(appendResponseEvent.mock.calls[0][2]).toBe('FAILED — Demo Video: the background build failed (gate red). Press it again in Project Home to retry.');
      fs.writeFileSync(nodePath.join(reviewDir, 'dispatch.json'), JSON.stringify({
        entryId: 'vid-final1', macroId: 'builtin-demo-video', slug: '9020-final', stage: 'review', dispatchedAt: new Date().toISOString(),
      }));
      ({ appendResponseEvent } = await run({ slug: '9020-final', status: 'failed', cwd, error: 'gate red' }, prd));
      expect(appendResponseEvent.mock.calls[0][2]).toBe('FAILED — Demo Video: the background build failed (gate red). Press it again in Project Home to retry.');
    });

    test('listReviews throwing falls back to the generic FAILED text', async () => {
      const cwd = mkProject();
      // videos/ as a FILE → readdir throws ENOTDIR (not ENOENT) inside listReviews.
      fs.mkdirSync(nodePath.join(cwd, 'session-manager-operations', 'project-pages'), { recursive: true });
      fs.writeFileSync(nodePath.join(cwd, 'session-manager-operations', 'project-pages', 'videos'), 'x');
      const { appendResponseEvent } = await run(
        { slug: '9021-throw', status: 'failed', cwd, error: 'boom' },
        { macroId: 'builtin-demo-video' },
      );
      expect(appendResponseEvent.mock.calls[0][2]).toBe('FAILED — Demo Video: the background build failed (boom). Press it again in Project Home to retry.');
    });

    test('path-traversal entry id is rejected → label-only DONE, no buildOutput', async () => {
      const cwd = mkProject();
      // A readable meta.json one level up that a traversal would reach.
      writeEntry(cwd, 'videos', 'real', { title: 'Should not be read' });
      const { appendResponseEvent } = await run(
        { slug: '9005-trav', status: 'completed', cwd },
        { macroId: 'builtin-demo-video', artifactPaths: ['session-manager-operations/project-pages/videos/../videos/real/index.html'] },
      );
      const [, , text, meta] = appendResponseEvent.mock.calls[0];
      expect(text).toBe('DONE — Demo Video finished.');
      expect(meta).not.toHaveProperty('buildOutput');
      const r2 = await run(
        { slug: '9005-up', status: 'completed', cwd },
        { macroId: 'builtin-demo-video', artifactPaths: ['session-manager-operations/project-pages/videos/A_B/index.html'] },
      );
      expect(r2.appendResponseEvent.mock.calls[0][2]).toBe('DONE — Demo Video finished.');
    });

    describe('Project Video tool review stage (build-review)', () => {
      const REVIEW_MSG = 'WAITING — Burrow Video: the review material is saved. Approve it or ask for changes in Project Home ▸ Video.';
      function writeReview(cwd, id) {
        const d = nodePath.join(cwd, 'session-manager-operations', 'project-pages', 'videos', id, 'review');
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(nodePath.join(d, 'material.json'), JSON.stringify({ title: 'Review title' }));
        // A meta.json beside it must never be reported as the build output.
        fs.writeFileSync(nodePath.join(cwd, 'session-manager-operations', 'project-pages', 'videos', id, 'meta.json'),
          JSON.stringify({ title: 'Not built yet', lengthS: 30, style: 'x' }));
      }

      test('artifact-only review stage (artifactPaths/files) → WAITING text + build-review notice, no buildOutput', async () => {
        const cwd = mkProject();
        writeReview(cwd, 'vid-rev1');
        const rel = 'session-manager-operations/project-pages/videos/vid-rev1/review/material.json';
        const { appendResponseEvent } = await run(
          { slug: '9010-rev', status: 'completed', cwd },
          { macroId: 'tool-burrow-video', title: 'Burrow Video: review material', deliverable: 'artifact', artifactPaths: [rel], files: [rel] },
        );
        const [, , text, meta] = appendResponseEvent.mock.calls[0];
        expect(text).toBe(REVIEW_MSG);
        expect(meta).toMatchObject({ notice: 'build-review', outcome: 'completed' });
        expect(meta).not.toHaveProperty('buildOutput');
      });

      test('repo-committing review stage (path only in files)', async () => {
        const cwd = mkProject();
        const { appendResponseEvent } = await run(
          { slug: '9011-rev', status: 'completed', cwd },
          { macroId: 'tool-burrow-video', title: 'Burrow Video: review material', files: ['src/x.ts', 'session-manager-operations/project-pages/videos/vid-r2/review/material.json'] },
        );
        expect(appendResponseEvent.mock.calls[0][2]).toBe(REVIEW_MSG);
        expect(appendResponseEvent.mock.calls[0][3]).toMatchObject({ notice: 'build-review' });
      });

      test('repo-committing review stage (path only in the gate block)', async () => {
        const cwd = mkProject();
        const abs = nodePath.join(cwd, 'session-manager-operations/project-pages/videos/vid-r3/review/material.json');
        const gateCmd = `timeout 60 node -e 'const s=require("fs").statSync(${JSON.stringify(abs)});process.exit(s.size>0?0:1)'`;
        const body = '# Goal\n\nx\n\n# Gate\n\n```gate\n' + gateCmd + '\n```\n';
        let { appendResponseEvent } = await run(
          { slug: '9012-rev', status: 'completed', cwd },
          { macroId: 'tool-burrow-video', title: 'Burrow Video: review material', files: ['src/x.ts'], body },
        );
        expect(appendResponseEvent.mock.calls[0][2]).toBe(REVIEW_MSG);
        ({ appendResponseEvent } = await run(
          { slug: '9012-rev2', status: 'completed', cwd },
          { macroId: 'tool-burrow-video', title: 'Burrow Video: review material', gate: [gateCmd] },
        ));
        expect(appendResponseEvent.mock.calls[0][3]).toMatchObject({ notice: 'build-review' });
      });

      test('final stage of the same tool → unchanged DONE text + buildOutput', async () => {
        const cwd = mkProject();
        writeEntry(cwd, 'videos', 'vid-fin', { title: 'Final cut', kind: 'demo', style: 'vertical', lengthS: 60 });
        writeReview(cwd, 'vid-fin2');
        const rel = 'session-manager-operations/project-pages/videos/vid-fin/index.html';
        const { appendResponseEvent } = await run(
          { slug: '9013-fin', status: 'completed', cwd },
          { macroId: 'tool-burrow-video', title: 'Burrow Video: background build', deliverable: 'artifact', artifactPaths: [rel], files: [rel] },
        );
        const [, , text, meta] = appendResponseEvent.mock.calls[0];
        expect(text).toBe('DONE — Burrow Video: “Final cut” is saved (60 s · vertical). Watch it in Project Home ▸ Videos.');
        expect(meta).toMatchObject({ notice: 'build-done', buildOutput: { kind: 'video', id: 'vid-fin', title: 'Final cut' } });
      });

      test('Demo Video build is unchanged', async () => {
        const cwd = mkProject();
        writeEntry(cwd, 'videos', 'vid-demo', { title: 'Demo', kind: 'demo', style: 'animated-whiteboard', lengthS: 30 });
        const { appendResponseEvent } = await run(
          { slug: '9014-demo', status: 'completed', cwd },
          { macroId: 'builtin-demo-video', deliverable: 'artifact', artifactPaths: ['session-manager-operations/project-pages/videos/vid-demo/index.html'] },
        );
        expect(appendResponseEvent.mock.calls[0][2]).toBe('DONE — Demo Video: “Demo” is saved (30 s · animated-whiteboard). Watch it in Project Home ▸ Videos.');
        expect(appendResponseEvent.mock.calls[0][3]).toMatchObject({ notice: 'build-done' });
      });

      test('failed review stage keeps the FAILED text', async () => {
        const cwd = mkProject();
        const rel = 'session-manager-operations/project-pages/videos/vid-f/review/material.json';
        const { appendResponseEvent } = await run(
          { slug: '9015-fail', status: 'failed', cwd, error: 'gate red' },
          { macroId: 'tool-burrow-video', title: 'Burrow Video: review material', artifactPaths: [rel], files: [rel] },
        );
        expect(appendResponseEvent.mock.calls[0][2]).toBe('FAILED — Burrow Video: the background build failed (gate red). Press it again in Project Home to retry.');
        expect(appendResponseEvent.mock.calls[0][3]).toMatchObject({ notice: 'build-failed' });
      });
    });

    test('non-macro PRD keeps the exact old message and no notice; transcript turn unchanged', async () => {
      const cwd = mkProject();
      const { appendResponseEvent, appendTranscriptTurn } = await run(
        { slug: '9006-dev', status: 'completed', cwd, runId: 'r9' },
        { artifactPaths: ['session-manager-operations/project-pages/videos/vid-x/index.html'] },
      );
      const [, , text, meta] = appendResponseEvent.mock.calls[0];
      expect(text).toBe('PRD 9006-dev finished: completed. Check Scheduler for details.');
      expect(meta).not.toHaveProperty('notice');
      expect(meta).not.toHaveProperty('buildOutput');
      expect(appendTranscriptTurn).toHaveBeenCalledWith(cwd, 'psess-m', {
        role: 'assistant', text: 'result text', eventId: 'prd-result:9006-dev:r9',
      });
    });

    test('macro PRD transcript append is unchanged (still the run result text)', async () => {
      const cwd = mkProject();
      const { appendTranscriptTurn } = await run(
        { slug: '9007-m', status: 'completed', cwd, runId: 'r7' },
        { macroId: 'builtin-demo-video' },
      );
      expect(appendTranscriptTurn).toHaveBeenCalledWith(cwd, 'psess-m', {
        role: 'assistant', text: 'result text', eventId: 'prd-result:9007-m:r7',
      });
    });
  });
});
