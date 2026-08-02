// Shared kit for the three agent-populated Project Pages.
// Tokens follow the Almanac paper palette so generated pages sit inside the
// same world as the app, but typography is set for *published* reading.

const PK = {
  paper: '#f6efe1', panel: '#efe6d3', card: '#fbf6ec', deep: '#2a221a',
  edge: '#e0d3b8', rule: '#d9c9a8', ink: '#2a221a', inkSoft: '#5b4a36', inkMute: '#8a7a60',
  accent: '#b85c34', accentDeep: '#9c4a26', sage: '#6f7d52', butter: '#e4b85a', clay: '#c98a5e',
  serif: "'Newsreader', Georgia, serif", sans: "'Geist', system-ui, sans-serif", mono: "'IBM Plex Mono', ui-monospace, monospace",
};

// Every token the agent fills in. One project → three lenses.
const PROJ = {
  name: 'Session Manager',
  tag: 'session-manager',
  version: 'v0.50.0',
  oneLine: 'A local cockpit for Claude Code.',
  claim: 'Everything your agent does, in one window you actually own.',
  sub: 'Session Manager wraps the Claude Code CLI in a desktop shell — sessions, skills, hooks, MCP servers and scheduled headless jobs all get a place to live and a state you can see. It runs on your machine. Nothing phones home.',
  audience: 'For developers running Claude Code all day',
  install: 'npx @bilko/session-manager',
  stats: [
    { v: '3', k: 'concurrent sessions', n: 'a single machine-wide pool' },
    { v: '891', k: 'sessions archived', n: 'every one resumable' },
    { v: '0', k: 'bytes leave disk', n: 'aggregates only, no transcripts' },
    { v: '5h', k: 'billing window', n: 'scheduler plans against it' },
  ],
  pillars: [
    { t: 'One tab per project', d: 'A tab is a directory on disk. Open four, switch with ⌘1–4, and every skill, hook and permission scopes itself to that project automatically.', k: 'Workspace' },
    { t: 'Epics, not chat logs', d: 'Work is broken into goal-scoped Epics with their own conversation, PRDs and runs. Approve a PRD and it becomes a headless job.', k: 'Planning' },
    { t: 'A scheduler that respects the window', d: 'Approved PRDs run as claude -p jobs when a slot frees. Queue state persists to sqlite, so a restart never drops work.', k: 'Automation' },
    { t: 'Observability without telemetry', d: 'Token accounting, burn rate and per-project history are computed locally from the transcript archive you already have.', k: 'Analytics' },
  ],
  quotes: [
    { q: 'I stopped keeping six terminals open. The queue just drains while I read.', a: 'Ana R.', r: 'infra lead, 40-person team' },
    { q: 'The Epic model is the first time planning and execution shared a surface.', a: 'Devon K.', r: 'staff engineer' },
  ],
  // Feature lens
  feature: {
    name: 'The Scheduler',
    kicker: 'Feature',
    status: 'Shipping · v0.50',
    owner: 'Core',
    oneLine: 'Approved PRDs become headless jobs that drain against your billing window — unattended, ordered, and restart-safe.',
    problem: 'Long work needs to run while you are not watching. Left to a terminal, it competes with your interactive session, dies with the window, and forgets where it was.',
    solution: 'The Scheduler owns a single machine-wide pool of three session slots. Every approved PRD is enqueued with a project, a dependency set and a definition of done. Jobs claim a slot only when one is genuinely free, and queue state is written to sqlite on enqueue — not on exit.',
    steps: [
      { t: 'Approve a PRD', d: 'Inside an Epic, a PRD gets an explicit human approval. Nothing enters the queue on its own.' },
      { t: 'Enqueue with intent', d: 'The job carries its project cwd, dependsOn set, and a definition of done the runner can check.' },
      { t: 'Claim a slot', d: 'A memory gate defers launch when free RAM drops below threshold, so a burst never takes the host down.' },
      { t: 'Run headless', d: 'claude -p executes against the project. Output streams into the Epic thread as it happens.' },
      { t: 'Drain and reconcile', d: 'On boot, a reaper kills orphaned processes and reconciles the queue against what actually ran.' },
    ],
    rules: [
      { t: 'Approval is human-only', d: 'No agent path can enqueue a PRD. Approval is a person, always.' },
      { t: 'Persist on enqueue', d: 'Queue state hits sqlite the moment a job is added, never deferred to shutdown.' },
      { t: 'Survive restarts', d: 'Every scheduled job must be recoverable after a host restart, including mid-run.' },
      { t: 'One slot, one job', d: 'Slots are exclusive. Chat runs and scheduler jobs request from the same pool.' },
    ],
    specs: [
      ['Pool size', '3 concurrent sessions', 'machine-wide, not per project'],
      ['Persistence', 'sqlite (queueStore.cjs)', 'written on enqueue'],
      ['Gate', 'free RAM < 1.5 GB defers', 'checked before every claim'],
      ['Recovery', 'boot reconciliation + reaper', 'orphan processes killed'],
      ['Trigger', 'approved PRD only', 'explicit human intent'],
    ],
    faq: [
      { q: 'What happens if the machine sleeps mid-job?', a: 'The job is marked interrupted. On wake, boot reconciliation re-queues it at the head with its original dependency set intact.' },
      { q: 'Can two projects run at once?', a: 'Yes — the pool is machine-wide, so slots are allocated across projects in enqueue order unless a dependency forces sequencing.' },
      { q: 'Does the scheduler ever pause itself?', a: 'It defers when free RAM drops below the gate and when the 5-hour window is nearly exhausted. It never cancels; it waits.' },
    ],
    timeline: [
      { w: 'v0.44', t: 'Queue persisted to sqlite', s: 'done' },
      { w: 'v0.47', t: 'Dependency satisfaction (dependsOn)', s: 'done' },
      { w: 'v0.50', t: 'Boot reconciliation + dead-process reaper', s: 'done' },
      { w: 'v0.52', t: 'Per-project concurrency ceilings', s: 'next' },
      { w: 'later', t: 'Cross-machine queue hand-off', s: 'idea' },
    ],
  },
  // Architecture lens
  arch: {
    summary: 'An Electron shell owning a Claude Code CLI pool, a sqlite-backed job queue, and a renderer that never talks to disk directly.',
    principles: [
      { t: 'Local only', d: 'No network egress. Transcripts never leave the machine; analytics are computed from the local archive.' },
      { t: 'One pool, one owner', d: 'The main process is the sole allocator of session slots. The renderer may only request.' },
      { t: 'Durable before visible', d: 'State is written before it is rendered — a restart is a re-read, not a recovery.' },
      { t: 'Project-scoped by default', d: 'Every nav destination, skill and permission derives from the focused project, not global config.' },
    ],
    layers: [
      { n: 'Renderer', d: 'React surfaces — Project Home, Epics, Scheduler, History, Config', f: '82 files', tone: 'accent' },
      { n: 'IPC contract', d: 'Typed channels; every call is a request the main process may refuse', f: '9 files', tone: 'butter' },
      { n: 'Main process', d: 'Session pool, scheduler, queue store, hooks runner, reaper', f: '34 files', tone: 'sage' },
      { n: 'Disk + CLI', d: 'claude binary, project cwds, sqlite, ~/.claude config tree', f: 'external', tone: 'mute' },
    ],
    modules: [
      { n: 'sessionPool', d: 'slot allocation, memory gate, restart recovery', f: 14, dep: ['queueStore', 'ipc'], heat: 0.9 },
      { n: 'scheduler', d: 'headless job queue, dependency satisfaction', f: 11, dep: ['sessionPool', 'queueStore'], heat: 0.75 },
      { n: 'queueStore', d: 'sqlite persistence, boot reconciliation', f: 6, dep: [], heat: 0.55 },
      { n: 'epicStore', d: 'Epic + PRD lifecycle, thread schema', f: 22, dep: ['queueStore'], heat: 1 },
      { n: 'usage', d: 'token accounting, 5-hour window, analytics', f: 7, dep: ['epicStore'], heat: 0.6 },
      { n: 'shell', d: 'tabs, two-face nav, settings surfaces', f: 18, dep: ['ipc'], heat: 0.35 },
    ],
    flow: [
      { a: 'Renderer', b: 'IPC', t: 'approvePrd(epicId, prdId)', n: 'user clicks Approve inside an Epic' },
      { a: 'IPC', b: 'scheduler', t: 'enqueue(job)', n: 'job written to sqlite before ack' },
      { a: 'scheduler', b: 'sessionPool', t: 'requestSlot()', n: 'blocked while memory gate is closed' },
      { a: 'sessionPool', b: 'CLI', t: 'spawn claude -p', n: 'cwd = project root, streamed stdout' },
      { a: 'CLI', b: 'epicStore', t: 'append turns', n: 'thread updates live in the Epic' },
      { a: 'epicStore', b: 'Renderer', t: 'push event', n: 'no polling; renderer is a subscriber' },
    ],
    decisions: [
      { id: 'ADR-04', t: 'Queue state persists to sqlite on enqueue', w: 'In-memory queues lost work on every crash. Durability at enqueue is cheap; durability at exit is a lie.', s: 'accepted' },
      { id: 'ADR-07', t: 'Session pool is machine-wide, not per project', w: 'Per-project pools multiplied under four open tabs and exhausted RAM. One allocator, one ceiling.', s: 'accepted' },
      { id: 'ADR-09', t: 'Epic creation requires explicit human intent', w: 'Auto-created Epics from stray prompts made the queue unreadable. Intent is a click.', s: 'accepted' },
      { id: 'ADR-11', t: 'Renderer never touches disk', w: 'Keeps the security surface in one process and makes every filesystem effect auditable in the main log.', s: 'accepted' },
    ],
    risks: [
      { t: 'Memory gate is a heuristic', d: 'Free-RAM thresholds vary by host. A wrong gate either starves the queue or lets it thrash.', s: 'watching' },
      { t: 'Archive depth caps analytics', d: 'All-time views want 360 days; the local archive holds 214. Open question: cap or extrapolate.', s: 'open' },
      { t: 'CLI version drift', d: 'The shell assumes claude CLI flags that may change between releases.', s: 'mitigated' },
    ],
  },
};

// ── primitives ─────────────────────────────────────────────
function PkEyebrow({ children, tone = PK.accent, style }) {
  return <div style={{ fontFamily: PK.mono, fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: tone, fontWeight: 500, ...style }}>{children}</div>;
}
function PkPill({ children, tone = PK.inkSoft, bg = 'transparent', border = PK.rule, style }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: PK.mono, fontSize: 11, color: tone, background: bg, border: `1px solid ${border}`, borderRadius: 999, padding: '3px 9px', whiteSpace: 'nowrap', ...style }}>{children}</span>;
}
function PkDot({ c = PK.sage, s = 7 }) { return <span style={{ width: s, height: s, borderRadius: '50%', background: c, flex: 'none' }} />; }
function PkCmd({ children, wide }) {
  return <code style={{ display: wide ? 'block' : 'inline-block', fontFamily: PK.mono, fontSize: 13, color: PK.paper, background: PK.deep, borderRadius: 8, padding: wide ? '12px 16px' : '7px 12px' }}>{children}</code>;
}
function PkBtn({ children, primary, onClick, small }) {
  return <button onClick={onClick} style={{ appearance: 'none', cursor: 'pointer', fontFamily: PK.sans, fontSize: small ? 12 : 14, fontWeight: 550, padding: small ? '6px 12px' : '11px 20px', borderRadius: 9, border: primary ? '1px solid transparent' : `1px solid ${PK.rule}`, background: primary ? PK.accent : 'transparent', color: primary ? '#fff' : PK.inkSoft }}>{children}</button>;
}
// Faint placeholder standing in for real imagery the agent will supply.
function PkShot({ h = 220, label = 'screenshot', style }) {
  return <div style={{ height: h, borderRadius: 12, border: `1px dashed ${PK.rule}`, background: `repeating-linear-gradient(135deg, ${PK.panel} 0 10px, ${PK.card} 10px 20px)`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: PK.inkMute, fontFamily: PK.mono, fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', ...style }}>{label}</div>;
}
function PkSection({ children, pad = '64px 72px', bg, style }) {
  // Side padding scales down so sections survive a narrow preview frame.
  const p = String(pad).replace(/\b(72|80)px\b/g, 'clamp(22px, 5.5%, $1px)');
  return <section style={{ padding: p, background: bg, ...style }}>{children}</section>;
}
function PkH({ children, size = 40, style }) {
  return <h2 style={{ margin: 0, fontFamily: PK.serif, fontWeight: 500, fontSize: size, lineHeight: 1.1, letterSpacing: '-0.015em', color: PK.ink, textWrap: 'balance', ...style }}>{children}</h2>;
}
function PkBody({ children, size = 16, style }) {
  return <p style={{ margin: 0, fontFamily: PK.sans, fontSize: size, lineHeight: 1.62, color: PK.inkSoft, textWrap: 'pretty', ...style }}>{children}</p>;
}
Object.assign(window, { PK, PROJ, PkEyebrow, PkPill, PkDot, PkCmd, PkBtn, PkShot, PkSection, PkH, PkBody });
