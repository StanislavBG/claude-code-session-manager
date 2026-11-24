'use strict';

/**
 * environmentReportWeek.test.cjs — PRD 3942: environment enforcement starts in
 * 'report' on a fresh machine, persists when that week began
 * (environmentReportSince, scheduler runtime state), and switches to 'enforce'
 * by itself 7 days later; SM_ENVIRONMENT_ENFORCEMENT overrides both ways
 * ('report' always wins). The readiness banner names the switch date and the
 * packages to install.
 *
 * Run: timeout 300 npx vitest run src/main/lib/scheduler/__tests__/environmentReportWeek.test.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const schedulerConfig = require('../schedulerConfig.cjs');
const runtimeState = require('../schedulerRuntimeState.cjs');
const { checkJobSandbox } = require('../../epic/delegationReadiness.cjs');

const DAY = 24 * 60 * 60_000;
const T0 = Date.UTC(2026, 10, 23, 18, 0, 0);
const localDate = (ms) => new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

let dir;
let statePath;
let prevEnv;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-report-week-'));
  statePath = path.join(dir, 'state', 'scheduler-runtime-state.json');
  prevEnv = process.env.SM_ENVIRONMENT_ENFORCEMENT;
  delete process.env.SM_ENVIRONMENT_ENFORCEMENT;
  runtimeState.__resetForTests();
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.SM_ENVIRONMENT_ENFORCEMENT;
  else process.env.SM_ENVIRONMENT_ENFORCEMENT = prevEnv;
  runtimeState.__resetForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));

describe('environment enforcement report week', () => {
  it("defaults to 'report'", () => {
    expect(schedulerConfig.DEFAULT_ENVIRONMENT_ENFORCEMENT).toBe('report');
    expect(schedulerConfig.ENVIRONMENT_REPORT_WINDOW_MS).toBe(7 * DAY);
  });

  it('fresh machine = report, and persists environmentReportSince on first evaluation', () => {
    expect(fs.existsSync(statePath)).toBe(false);
    expect(schedulerConfig.environmentEnforcement({ now: T0, statePath })).toBe('report');
    expect(readState().environmentReportSince).toBe(T0);
    const s = schedulerConfig.environmentEnforcementStatus({ now: T0, statePath });
    expect(s).toEqual({ mode: 'report', source: 'report-week', reportSince: T0, enforceFrom: T0 + 7 * DAY });
  });

  it('day 6 = report, day 7 = enforce', () => {
    schedulerConfig.environmentEnforcement({ now: T0, statePath });
    expect(schedulerConfig.environmentEnforcement({ now: T0 + 6 * DAY, statePath })).toBe('report');
    expect(schedulerConfig.environmentEnforcement({ now: T0 + 7 * DAY - 1, statePath })).toBe('report');
    expect(schedulerConfig.environmentEnforcement({ now: T0 + 7 * DAY, statePath })).toBe('enforce');
  });

  it('timestamp is not reset on re-read or restart (memo cleared)', () => {
    schedulerConfig.environmentEnforcement({ now: T0, statePath });
    schedulerConfig.environmentEnforcement({ now: T0 + 2 * DAY, statePath });
    runtimeState.__resetForTests(); // simulated restart: in-memory memo gone, file stays
    expect(schedulerConfig.environmentEnforcement({ now: T0 + 8 * DAY, statePath })).toBe('enforce');
    expect(readState().environmentReportSince).toBe(T0);
    expect(runtimeState.ensureEnvironmentReportSince({ now: T0 + 9 * DAY, statePath })).toBe(T0);
    expect(readState().environmentReportSince).toBe(T0);
  });

  it('keeps other keys in the runtime-state file and repairs an invalid stamp', () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ other: 1, environmentReportSince: 'garbage' }));
    expect(runtimeState.ensureEnvironmentReportSince({ now: T0, statePath })).toBe(T0);
    expect(readState()).toEqual({ other: 1, environmentReportSince: T0 });
  });

  it('SM_ENVIRONMENT_ENFORCEMENT=enforce forces enforce on a fresh machine', () => {
    process.env.SM_ENVIRONMENT_ENFORCEMENT = 'enforce';
    expect(schedulerConfig.environmentEnforcement({ now: T0, statePath })).toBe('enforce');
  });

  it('SM_ENVIRONMENT_ENFORCEMENT=report always wins, even after the week', () => {
    schedulerConfig.environmentEnforcement({ now: T0, statePath });
    process.env.SM_ENVIRONMENT_ENFORCEMENT = 'report';
    expect(schedulerConfig.environmentEnforcement({ now: T0 + 30 * DAY, statePath })).toBe('report');
    process.env.SM_ENVIRONMENT_ENFORCEMENT = ' REPORT ';
    expect(schedulerConfig.environmentEnforcement({ now: T0 + 30 * DAY, statePath })).toBe('report');
  });

  it('an unrecognized override follows the persisted week', () => {
    process.env.SM_ENVIRONMENT_ENFORCEMENT = 'bogus';
    expect(schedulerConfig.environmentEnforcement({ now: T0, statePath })).toBe('report');
    expect(schedulerConfig.environmentEnforcement({ now: T0 + 7 * DAY, statePath })).toBe('enforce');
  });

  it('an unwritable state file stays in report rather than parking jobs', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const s = schedulerConfig.environmentEnforcementStatus({ now: T0, statePath: path.join(blocker, 'state.json') });
    expect(s.mode).toBe('report');
    expect(s.source).toBe('unpersisted');
  });
});

describe('readiness banner during the report week', () => {
  const enforceFrom = T0 + 7 * DAY;

  it('names the local start date, socat, and that headless jobs will park from then', () => {
    const c = checkJobSandbox({ sandboxDeps: { available: false, missing: ['socat'] }, platform: 'linux', mode: 'report', enforceFrom });
    expect(c.ok).toBe(true);
    expect(c.warn).toBe(true);
    expect(c.detail).toContain(localDate(enforceFrom));
    expect(c.detail).toMatch(/socat/);
    expect(c.detail).toMatch(/headless .*jobs will park/);
    expect(c.fix).toContain('Install socat (sudo apt install socat)');
    expect(c.fix).toContain(localDate(enforceFrom));
  });

  it('deps present: still names the date enforcement starts', () => {
    const c = checkJobSandbox({ sandboxDeps: { available: true, missing: [] }, platform: 'linux', mode: 'report', enforceFrom });
    expect(c.ok).toBe(true);
    expect(c.detail).toContain(localDate(enforceFrom));
    expect(c.fix).toBeNull();
  });

  it('with no mode passed, reads mode + date from the persisted week', () => {
    const prevHome = process.env.SM_SCHEDULER_HOME;
    process.env.SM_SCHEDULER_HOME = dir;
    try {
      const since = runtimeState.ensureEnvironmentReportSince();
      const c = checkJobSandbox({ sandboxDeps: { available: false, missing: ['socat'] }, platform: 'linux' });
      expect(c.ok).toBe(true);
      expect(c.detail).toContain(localDate(since + 7 * DAY));
    } finally {
      if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
      else process.env.SM_SCHEDULER_HOME = prevHome;
    }
  });

  it('under enforce: a failure, no report-week date', () => {
    const c = checkJobSandbox({ sandboxDeps: { available: false, missing: ['socat'] }, platform: 'linux', mode: 'enforce', enforceFrom });
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/environment_unavailable/);
    expect(c.detail).not.toContain(localDate(enforceFrom));
  });
});
