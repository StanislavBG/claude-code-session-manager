// Subagents / "The Hive" — shared data + small primitives.
// Reuses the Almanac palette (window.ALMANAC), so this file must load AFTER
// variants/almanac.jsx.

const HIVE = window.ALMANAC;

// Harmonised agent accents — all low-chroma so they sit on warm paper.
const HV_HUES = {
  terracotta: '#b85c34',
  sage:       '#6f7d52',
  butter:     '#c79338',
  slate:      '#5f6f86',
  plum:       '#8a5a6e',
  teal:       '#4f7d72',
};

// ── The configured roster (~/.claude/agents) ────────────────────────
const HIVE_AGENTS = [
  { id: 'code-reviewer',     name: 'code-reviewer',     dot: HV_HUES.terracotta,
    role: 'Reviews a diff',
    blurb: 'Reads a change set and flags correctness bugs, footguns, and style drift before you merge.',
    tools: ['Read', 'Grep', 'Glob'], model: 'inherit', effort: 'high', readOnly: true, returns: 'a prioritised list of issues' },
  { id: 'security-auditor',  name: 'security-auditor',  dot: HV_HUES.plum,
    role: 'Hunts vulnerabilities',
    blurb: 'Looks for injection, secret leakage, unsafe deserialisation, and auth gaps across the surface.',
    tools: ['Read', 'Grep', 'Glob'], model: 'opus', effort: 'high', readOnly: true, returns: 'findings ranked by severity' },
  { id: 'perf-profiler',     name: 'perf-profiler',     dot: HV_HUES.butter,
    role: 'Finds slow paths',
    blurb: 'Traces hot loops, N+1 queries, and allocation churn, then proposes the cheapest wins.',
    tools: ['Read', 'Grep', 'Bash'], model: 'inherit', effort: 'medium', readOnly: true, returns: 'a short hot-path report' },
  { id: 'dependency-auditor',name: 'dependency-auditor',dot: HV_HUES.teal,
    role: 'Audits the lockfile',
    blurb: 'Checks pinned versions for known CVEs, abandoned packages, and license conflicts.',
    tools: ['Read', 'Bash', 'WebFetch'], model: 'haiku', effort: 'low', readOnly: true, returns: 'a per-package verdict' },
  { id: 'api-designer',      name: 'api-designer',      dot: HV_HUES.slate,
    role: 'Reviews the API surface',
    blurb: 'Audits route naming, verbs, status codes, pagination, and error envelopes for consistency.',
    tools: ['Read', 'Grep', 'Glob'], model: 'inherit', effort: 'medium', readOnly: true, returns: 'inconsistencies vs. the rest of the surface' },
  { id: 'refactorer',        name: 'refactorer',        dot: HV_HUES.sage,
    role: 'Proposes cleanups',
    blurb: 'Spots duplication and tangled control flow, suggesting safe, mechanical refactors.',
    tools: ['Read', 'Grep', 'Edit'], model: 'inherit', effort: 'medium', readOnly: false, returns: 'a patch plan' },
  { id: 'debugger',          name: 'debugger',          dot: HV_HUES.terracotta,
    role: 'Roots out a bug',
    blurb: 'Reproduces a failing case, bisects the cause, and explains the smallest fix.',
    tools: ['Read', 'Grep', 'Bash', 'Edit'], model: 'opus', effort: 'high', readOnly: false, returns: 'a root-cause writeup' },
  { id: 'explorer',          name: 'explorer',          dot: HV_HUES.slate,
    role: 'Maps the code',
    blurb: 'Read-only sweep of a folder to summarise structure, entry points, and where things live.',
    tools: ['Read', 'Grep', 'Glob'], model: 'haiku', effort: 'low', readOnly: true, returns: 'a folder map + key files' },
];

const HIVE_AGENT_BY_ID = Object.fromEntries(HIVE_AGENTS.map(a => [a.id, a]));

// ── Recipes: preset bundles you fire at a target ────────────────────
const HIVE_RECIPES = [
  { id: 'ship-ready', name: 'Ship-readiness review', accent: HV_HUES.terracotta,
    tagline: 'Everything that should pass before you merge.',
    agentIds: ['code-reviewer', 'security-auditor', 'dependency-auditor', 'perf-profiler'],
    estMin: 6, estCost: 0.78 },
  { id: 'deep-review', name: 'Deep code review', accent: HV_HUES.sage,
    tagline: 'A close read plus refactor and API-shape notes.',
    agentIds: ['code-reviewer', 'refactorer', 'api-designer'],
    estMin: 5, estCost: 0.61 },
  { id: 'bug-hunt', name: 'Bug hunt', accent: HV_HUES.plum,
    tagline: 'Reproduce, bisect, and explain a failing case.',
    agentIds: ['debugger', 'explorer', 'perf-profiler'],
    estMin: 7, estCost: 0.69 },
  { id: 'security-sweep', name: 'Security sweep', accent: HV_HUES.teal,
    tagline: 'Vulnerabilities and risky dependencies, nothing else.',
    agentIds: ['security-auditor', 'dependency-auditor'],
    estMin: 4, estCost: 0.42 },
  { id: 'map-codebase', name: 'Map the codebase', accent: HV_HUES.slate,
    tagline: 'Three explorers fan out to chart unfamiliar code.',
    agentIds: ['explorer', 'explorer', 'explorer'],
    estMin: 3, estCost: 0.21 },
];

// ── A hive mid-flight, for the Live view ────────────────────────────
const HIVE_LIVE = {
  recipeId: 'ship-ready',
  target: 'src/snapshot.py and the signals/ module',
  startedAgo: '1 min 48 s',
  agents: [
    { id: 'code-reviewer', state: 'running', pct: 0.62, tokens: '22.4k', elapsed: '1m 41s',
      lastLine: 'snapshot.py:142 — `window` is mutated inside the comprehension…',
      findings: 2 },
    { id: 'security-auditor', state: 'running', pct: 0.38, tokens: '15.1k', elapsed: '1m 39s',
      lastLine: 'scanning signals/ingest.py for unsanitised f-strings…',
      findings: 1 },
    { id: 'dependency-auditor', state: 'done', pct: 1, tokens: '6.8k', elapsed: '0m 52s',
      lastLine: 'done — 1 advisory, 0 license conflicts.',
      findings: 1 },
    { id: 'perf-profiler', state: 'queued', pct: 0, tokens: '—', elapsed: '—',
      lastLine: 'waiting for a worker slot…',
      findings: 0 },
  ],
};

// ── Aggregated digest, shown as agents finish ───────────────────────
const HIVE_DIGEST = [
  { agent: 'dependency-auditor', sev: 'med',  text: 'requests 2.31 has advisory GHSA-xxxx — bump to 2.32.' },
  { agent: 'code-reviewer',      sev: 'high', text: 'off-by-one in the 5-hour window slice (snapshot.py:142).' },
  { agent: 'code-reviewer',      sev: 'low',  text: 'two helpers duplicate `coerce_ts`; fold into utils.' },
  { agent: 'security-auditor',   sev: 'med',  text: 'f-string SQL in ingest.py:88 — parameterise it.' },
];

// ── Library: community recipes & agents you can install ─────────────
const HIVE_LIBRARY = [
  { name: 'test-author',     author: 'anthropic',     installs: '24k', kind: 'agent',
    blurb: 'Writes focused unit tests for a file and runs them to green.', tools: ['Read', 'Write', 'Bash'] },
  { name: 'docs-writer',     author: 'community',      installs: '11k', kind: 'agent',
    blurb: 'Drafts README + docstrings from the code as it actually is.', tools: ['Read', 'Write'] },
  { name: 'migration-pilot', author: 'planetscale',    installs: '8.3k', kind: 'recipe',
    blurb: 'Bundle: schema-diff + data-backfill + rollback-checker.', tools: ['Read', 'Bash'] },
  { name: 'a11y-auditor',    author: 'community',      installs: '6.1k', kind: 'agent',
    blurb: 'Checks a UI for contrast, focus order, and ARIA gaps.', tools: ['Read', 'Grep'] },
  { name: 'release-notes',   author: 'anthropic',      installs: '5.4k', kind: 'agent',
    blurb: 'Turns a commit range into human release notes.', tools: ['Read', 'Bash'] },
  { name: 'i18n-sweep',      author: 'vercel',         installs: '3.9k', kind: 'recipe',
    blurb: 'Bundle: string-extractor + locale-filler + RTL-checker.', tools: ['Read', 'Grep', 'Edit'] },
];

// ── Primitives ──────────────────────────────────────────────────────

// Hexagon agent token — little hive cell with the agent's accent.
function HiveCell({ color = HIVE.accent, size = 16, filled = true }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'block' }}>
      <path d="M12 2l8.66 5v10L12 22l-8.66-5V7z"
        fill={filled ? color : 'none'} stroke={color} strokeWidth={filled ? 0 : 2}
        opacity={filled ? 1 : 0.9} />
    </svg>
  );
}

function StatusPill({ state, small }) {
  const map = {
    running: { bg: HIVE.accent,  fg: '#fff',           label: 'running', dot: true },
    done:    { bg: '#e5ecd8',    fg: '#4a5e2e',        label: 'done',    dot: false },
    queued:  { bg: HIVE.paper,   fg: HIVE.inkSoft,     label: 'queued',  dot: false, edge: true },
    failed:  { bg: '#f3d9cf',    fg: '#9a3b1f',        label: 'failed',  dot: false },
  };
  const s = map[state] || map.queued;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontFamily: HIVE.sans, fontSize: small ? 10.5 : 11.5, fontWeight: 600,
      padding: small ? '2px 7px' : '3px 9px', borderRadius: 999,
      background: s.bg, color: s.fg,
      boxShadow: s.edge ? `inset 0 0 0 1px ${HIVE.edge}` : 'none',
    }}>
      {s.dot && <span className="hv-pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }} />}
      {s.label}
    </span>
  );
}

function SevDot({ sev }) {
  const c = { high: '#a8442a', med: '#c79338', low: '#6f7d52' }[sev] || HIVE.inkMute;
  const label = { high: 'high', med: 'medium', low: 'low' }[sev];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: HIVE.inkMute, fontFamily: HIVE.mono }}>
      <span style={{ width: 7, height: 7, borderRadius: 2, background: c, transform: 'rotate(45deg)' }} />
      {label}
    </span>
  );
}

// Small read-only / tool chips
function ToolChip({ children, tone = 'plain' }) {
  const styles = {
    plain:    { bg: HIVE.paper,  fg: HIVE.inkSoft, edge: HIVE.edge },
    readonly: { bg: '#e9efdc',   fg: '#4a5e2e',    edge: '#cdd8b6' },
    write:    { bg: '#f5e3c8',   fg: '#8a6818',    edge: '#e6cfa0' },
  }[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontFamily: HIVE.mono, fontSize: 11, fontWeight: 500,
      padding: '2px 7px', borderRadius: 6,
      background: styles.bg, color: styles.fg,
      boxShadow: `inset 0 0 0 1px ${styles.edge}`,
    }}>{children}</span>
  );
}

// Sub-tab bar used at the top of the Hive page
function HiveSubTabs({ value, onChange, counts = {} }) {
  const tabs = [
    { id: 'launch',     label: 'Launch' },
    { id: 'live',       label: 'Live' },
    { id: 'configured', label: 'Configured' },
    { id: 'library',    label: 'Library' },
  ];
  return (
    <div style={{ display: 'flex', gap: 4, background: HIVE.panel, padding: 4, borderRadius: 12, boxShadow: `inset 0 0 0 1px ${HIVE.edge}` }}>
      {tabs.map(t => {
        const active = value === t.id;
        return (
          <button key={t.id} onClick={() => onChange(t.id)} style={{
            appearance: 'none', border: 0, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '7px 16px', borderRadius: 9,
            background: active ? HIVE.card : 'transparent',
            boxShadow: active ? `inset 0 0 0 1px ${HIVE.edge}, 0 1px 0 ${HIVE.edge}` : 'none',
            color: active ? HIVE.ink : HIVE.inkSoft,
            fontFamily: HIVE.sans, fontSize: 13.5, fontWeight: active ? 600 : 500,
          }}>
            {t.label}
            {t.id === 'live' && (
              <span className="hv-pulse" style={{ width: 7, height: 7, borderRadius: '50%', background: HIVE.accent }} />
            )}
            {counts[t.id] != null && t.id !== 'live' && (
              <span style={{ fontFamily: HIVE.mono, fontSize: 11, color: HIVE.inkMute }}>{counts[t.id]}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

Object.assign(window, {
  HIVE, HV_HUES, HIVE_AGENTS, HIVE_AGENT_BY_ID, HIVE_RECIPES,
  HIVE_LIVE, HIVE_DIGEST, HIVE_LIBRARY,
  HiveCell, StatusPill, SevDot, ToolChip, HiveSubTabs,
});
