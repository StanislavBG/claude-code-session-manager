// Scheduler — data. Loads after variants/almanac.jsx (uses window.ALMANAC).
const SCH = window.ALMANAC;

// The 5-hour window the scheduler runs against.
const SCH_WINDOW = {
  resetsIn: '3 h 21 m',
  lastRun:  '24 min ago',
  pending: 0, running: 0, done: 21,
};

const SCH_POLICY = {
  when: 'when available',   // when a slot frees up
  parallel: 6,              // max concurrent jobs
  utilCap: 90,              // pause new jobs above this % of window
};

// Jobs in the queue / recently run. `state` drives the badge.
const SCH_JOBS = [
  { id: 'j-21', state: 'running', title: 'Parallelise scheduler jobs across distinct projects up to the concurrency cap',
    project: 'session-manager', took: '4m so far', pct: 0.55,
    detail: { exit: '—', started: '2:58 PM PDT', finished: 'in progress', ago: 'now',
      duration: '4m so far', group: 'group 14 · 14-parallel-scheduler', cwd: '/home/bilko/Projects/session-manager' } },
  { id: 'j-20', state: 'pending', title: 'Add a JSON output mode to burrow so jobs can be machine-read',
    project: 'burrow', took: 'queued · next', pct: 0,
    detail: { exit: '—', started: 'not started', finished: '—', ago: '—',
      duration: '—', group: 'group 13 · 13-burrow-json', cwd: '/home/bilko/Projects/burrow' } },
  { id: 'j-19', state: 'completed', title: 'Finish + commit web-remote hardening (PENTEST.md, panic-UI wiring, green test:unit)',
    project: 'session-manager', took: '2m', pct: 1,
    detail: { exit: 'exit 0', started: '2:48 PM PDT', finished: '2:50 PM PDT · 11 min ago',
      duration: '2m', group: 'group 12 · 12-web-remote-hardening', cwd: '/home/bilko/Projects/session-manager' } },
  { id: 'j-18', state: 'completed', title: 'Fix the Agent-View 5-hour usage counter (was stuck at 100%) and route billing through one shared accessor',
    project: 'session-manager', took: '7m', pct: 1,
    detail: { exit: 'exit 0', started: '2:34 PM PDT', finished: '2:41 PM PDT · 5 h 27 m ago',
      duration: '7m', group: 'group 11 · 11-fix-agentview-usage-counter', cwd: '/home/bilko/Projects/session-manager' } },
  { id: 'j-17', state: 'needs-review', title: 'Burrow seam — persistent HTTP transport + a freshness gate on gather_status',
    project: 'signal-builder', took: '9m', pct: 1, note: 'verifier flagged errors in the transcript',
    detail: { exit: 'exit 0', started: '2:20 PM PDT', finished: '2:29 PM PDT · 6 h ago',
      duration: '9m', group: 'group 10 · 10-burrow-seam', cwd: '/home/bilko/Projects/signal-builder' } },
  { id: 'j-16', state: 'completed', title: 'Audit Agent-View data sources for API reuse and fold in any re-implemented logic',
    project: 'session-manager', took: '3m', pct: 1,
    detail: { exit: 'exit 0', started: '2:12 PM PDT', finished: '2:15 PM PDT · 6 h 12 m ago',
      duration: '3m', group: 'group 9 · 9-agentview-audit', cwd: '/home/bilko/Projects/session-manager' } },
  { id: 'j-15', state: 'failed', title: 'Durable reaper for stuck "running" jobs whose process is already dead',
    project: 'session-manager', took: '1m', pct: 1, note: 'exit 1 — missing-close failure mode; safe to reset',
    detail: { exit: 'exit 1', started: '1:58 PM PDT', finished: '1:59 PM PDT · 6 h 30 m ago',
      duration: '1m', group: 'group 8 · 8-reaper', cwd: '/home/bilko/Projects/session-manager' } },
];

// PRDs you've authored — the source the scheduler runs from.
const SCH_PRDS = [
  { id: 'p1', title: 'Scheduler v2 — cross-project parallelism', project: 'session-manager',
    summary: 'Let independent projects run side-by-side up to the concurrency cap, preserving per-project ordering.',
    steps: 5, est: '~14 min', status: 'running', updated: 'edited 2 h ago' },
  { id: 'p2', title: 'Burrow JSON output mode', project: 'burrow',
    summary: 'A --json flag on every command so jobs can be piped into other tools without scraping stdout.',
    steps: 3, est: '~6 min', status: 'queued', updated: 'edited yesterday' },
  { id: 'p3', title: 'Agent-View billing accessor', project: 'session-manager',
    summary: 'One shared module for the 5-hour window math; delete the three places that re-derive it.',
    steps: 4, est: '~7 min', status: 'ready', updated: 'edited 5 h ago' },
  { id: 'p4', title: 'Signal-builder ingest hardening', project: 'signal-builder',
    summary: 'Parameterise the SQL in ingest.py and add a freshness gate before gather_status returns.',
    steps: 6, est: '~12 min', status: 'draft', updated: 'edited 3 days ago' },
];

Object.assign(window, { SCH, SCH_WINDOW, SCH_POLICY, SCH_JOBS, SCH_PRDS });
