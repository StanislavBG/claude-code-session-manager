// Marketing Landing — product-depth slots.
// Inserted between the capability block and the closing CTA. These are the
// sections that argue the product rather than the pitch.

const MD = {
  tour: [
    { id: 'tabs', k: 'Epics', t: 'Work is a goal, not a chat log', d: 'Every piece of work opens as an Epic with its own thread, PRDs and runs. The conversation stays scoped, so the model never re-reads three unrelated tasks to answer one question.', pts: ['Question, permission and diff turns resolve inline', 'PRDs are drafted in-thread and approved explicitly', 'Archive an Epic and its context leaves the working set'] },
    { id: 'sched', k: 'Scheduler', t: 'Approved work drains while you read', d: 'An approved PRD becomes a headless claude -p job. The queue holds order and dependencies, claims one of three slots when it can, and survives a restart because it wrote itself down at enqueue.', pts: ['Three concurrent sessions, machine-wide', 'Dependencies honoured before order', 'Boot reconciliation kills orphans and resumes'] },
    { id: 'usage', k: 'Usage', t: 'Know what the window costs', d: 'Token accounting is computed from the transcript archive already on disk — per project, per Epic, per model. The scheduler plans against the same numbers you are reading.', pts: ['Live 5-hour window with burn rate', 'Per-project and per-Epic breakdowns', 'Aggregates only — transcripts never leave disk'] },
    { id: 'config', k: 'Configure', t: 'Skills, hooks and MCP with a state you can see', d: 'Everything the CLI can load gets a surface: which skills are active, which hooks fire on which event, which MCP servers are reachable right now, and what the agent is allowed to run unattended.', pts: ['Per-project scoping, not one global blob', 'Permission rules with an audit trail', 'Hook failures surface in the Epic that caused them'] },
  ],
  workflow: [
    { t: 'Open a folder', d: 'A tab is a directory on disk. Skills, hooks and permissions scope themselves to it.', c: 'session-manager open ~/work/api' },
    { t: 'State the goal', d: 'Create an Epic. The thread that follows belongs to that goal and nothing else.', c: 'epic: "migrate auth to sessions"' },
    { t: 'Approve the plan', d: 'The agent drafts a PRD in-thread. You approve it — nothing queues itself.', c: 'prd approved · 6 steps · 2 deps' },
    { t: 'Walk away', d: 'The queue drains against your window and reports back into the Epic thread.', c: 'queued → running → 3 files changed' },
  ],
  compare: {
    cols: ['Raw terminal', 'Cloud agent', 'Session Manager'],
    rows: [
      ['Work survives a restart', ['no', 'yes', 'yes']],
      ['Runs unattended overnight', ['no', 'yes', 'yes']],
      ['Code stays on your machine', ['yes', 'no', 'yes']],
      ['Parallel sessions with a ceiling', ['no', 'partial', 'yes']],
      ['Your own skills, hooks & MCP', ['yes', 'partial', 'yes']],
      ['Cost visible before you spend it', ['no', 'partial', 'yes']],
    ],
  },
  specs: [
    ['Runs on', 'macOS 13+ · Linux', 'Electron shell, native menus'],
    ['Requires', 'Claude Code CLI', 'brings its own session pool'],
    ['Concurrency', '3 sessions', 'machine-wide, memory-gated'],
    ['Storage', 'sqlite + ~/.claude', 'no external database'],
    ['Network', 'Anthropic API only', 'no telemetry, no account'],
    ['Extends via', 'skills · hooks · MCP', 'same files the CLI reads'],
  ],
  privacy: [
    { t: 'Transcripts never leave disk', d: 'Analytics are computed locally from the archive you already have. Nothing is uploaded, aggregated remotely, or phoned home.' },
    { t: 'No account, no sign-in', d: 'The app authenticates with your existing Claude Code credentials. There is no Session Manager account to create.' },
    { t: 'Permissions are explicit', d: 'What the agent may run unattended is a rule set you write, scoped per project, with an audit trail per run.' },
  ],
  faq: [
    { q: 'Does it replace the Claude Code CLI?', a: 'No — it drives it. The CLI stays the execution engine; Session Manager owns the pool, the queue and the state around it. Anything you can do in a terminal still works.' },
    { q: 'What happens to my existing skills and hooks?', a: 'They are read from the same ~/.claude tree the CLI uses. Nothing is copied or migrated; the app just gives them a surface and shows you when they fire.' },
    { q: 'Can I run it on a work machine?', a: 'That is the intended case. No network egress beyond the Anthropic API, no account, and nothing written outside your home directory and project folders.' },
    { q: 'What does it cost?', a: 'The app is free while in beta. Your only spend is Claude usage, which the usage view accounts for locally against the 5-hour window.' },
  ],
};

// ── TOUR ───────────────────────────────────────────────────
function MTourTabs() {
  const [i, setI] = React.useState(0);
  const t = MD.tour[i];
  return <PkSection pad="72px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>A closer look</PkEyebrow>
    <PkH size={34} style={{ marginTop: 12, maxWidth: 620 }}>Four surfaces, one project.</PkH>
    <div style={{ display: 'flex', gap: 6, marginTop: 26, flexWrap: 'wrap' }}>
      {MD.tour.map((x, n) => <button key={x.id} onClick={() => setI(n)} style={{ appearance: 'none', cursor: 'pointer', fontFamily: PK.sans, fontSize: 13, fontWeight: n === i ? 600 : 500, padding: '8px 14px', borderRadius: 8, border: `1px solid ${n === i ? PK.accent : PK.rule}`, background: n === i ? PK.accent : 'transparent', color: n === i ? '#fff' : PK.inkSoft }}>{x.k}</button>)}
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.1fr)', gap: 'clamp(24px,4vw,48px)', marginTop: 28, alignItems: 'center' }}>
      <div>
        <PkH size={26}>{t.t}</PkH>
        <PkBody style={{ marginTop: 12 }}>{t.d}</PkBody>
        <div style={{ marginTop: 18, display: 'grid', gap: 9 }}>
          {t.pts.map(p => <div key={p} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}><PkDot c={PK.sage} s={6} /><span style={{ fontFamily: PK.sans, fontSize: 14, color: PK.inkSoft }}>{p}</span></div>)}
        </div>
      </div>
      <PkShot h={280} label={`${t.k.toLowerCase()} view`} />
    </div>
  </PkSection>;
}
function MTourStacked() {
  return <PkSection pad="64px 80px" style={{ borderTop: `1px solid ${PK.rule}`, display: 'grid', gap: 4 }}>
    <PkEyebrow>Inside the app</PkEyebrow>
    {MD.tour.map((t, i) => <div key={t.id} style={{ display: 'grid', gridTemplateColumns: i % 2 ? 'minmax(0,1fr) minmax(0,0.95fr)' : 'minmax(0,0.95fr) minmax(0,1fr)', gap: 'clamp(24px,4vw,52px)', alignItems: 'center', padding: '32px 0', borderTop: `1px solid ${PK.rule}` }}>
      <div style={{ order: i % 2 ? 2 : 1 }}>
        <PkEyebrow tone={PK.inkMute}>{t.k}</PkEyebrow>
        <PkH size={28} style={{ marginTop: 10 }}>{t.t}</PkH>
        <PkBody style={{ marginTop: 12 }}>{t.d}</PkBody>
        <div style={{ marginTop: 16, display: 'grid', gap: 7 }}>{t.pts.map(p => <div key={p} style={{ display: 'flex', gap: 9, alignItems: 'baseline' }}><span style={{ color: PK.accent, fontFamily: PK.mono, fontSize: 12 }}>—</span><span style={{ fontFamily: PK.sans, fontSize: 13.5, color: PK.inkSoft }}>{p}</span></div>)}</div>
      </div>
      <PkShot h={230} label={`${t.k.toLowerCase()}`} style={{ order: i % 2 ? 1 : 2 }} />
    </div>)}
  </PkSection>;
}
function MTourCards() {
  return <PkSection pad="64px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>A closer look</PkEyebrow>
    <PkH size={32} style={{ marginTop: 12, maxWidth: 560 }}>Every surface earns its place in the window.</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: 16, marginTop: 30 }}>
      {MD.tour.map(t => <div key={t.id} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 14, overflow: 'hidden' }}>
        <PkShot h={130} label={t.k.toLowerCase()} style={{ borderRadius: 0, border: 'none', borderBottom: `1px solid ${PK.edge}` }} />
        <div style={{ padding: 20 }}>
          <PkEyebrow tone={PK.inkMute}>{t.k}</PkEyebrow>
          <div style={{ fontFamily: PK.serif, fontSize: 21, color: PK.ink, marginTop: 8, lineHeight: 1.2 }}>{t.t}</div>
          <PkBody size={13.5} style={{ marginTop: 9 }}>{t.d}</PkBody>
        </div>
      </div>)}
    </div>
  </PkSection>;
}
function MTourBigShot() {
  return <PkSection pad="64px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(200px,300px)', gap: 'clamp(24px,4vw,48px)', alignItems: 'start' }}>
      <div>
        <PkEyebrow>The workspace</PkEyebrow>
        <PkH size={32} style={{ marginTop: 12 }}>Everything in flight, on one screen.</PkH>
        <PkShot h={330} label="full app window" style={{ marginTop: 22, background: PK.card, borderStyle: 'solid' }} />
      </div>
      <div style={{ paddingTop: 76, display: 'grid', gap: 0 }}>
        {MD.tour.map((t, i) => <div key={t.id} style={{ padding: '14px 0', borderTop: `1px solid ${PK.rule}` }}>
          <div style={{ display: 'flex', gap: 9, alignItems: 'baseline' }}>
            <span style={{ fontFamily: PK.mono, fontSize: 11, color: PK.accent }}>{String(i + 1).padStart(2, '0')}</span>
            <span style={{ fontFamily: PK.sans, fontSize: 14, fontWeight: 600, color: PK.ink }}>{t.k}</span>
          </div>
          <PkBody size={13} style={{ marginTop: 5 }}>{t.t}.</PkBody>
        </div>)}
      </div>
    </div>
  </PkSection>;
}

// ── WORKFLOW ───────────────────────────────────────────────
function MFlowSteps() {
  return <PkSection pad="64px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>How a day goes</PkEyebrow>
    <PkH size={32} style={{ marginTop: 12, maxWidth: 560 }}>Four moves, then you stop watching.</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14, marginTop: 30 }}>
      {MD.workflow.map((s, i) => <div key={i} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 12, padding: 20 }}>
        <div style={{ fontFamily: PK.mono, fontSize: 11, color: PK.accent }}>{String(i + 1).padStart(2, '0')}</div>
        <div style={{ fontFamily: PK.sans, fontSize: 15.5, fontWeight: 600, color: PK.ink, marginTop: 9 }}>{s.t}</div>
        <PkBody size={13.5} style={{ marginTop: 7 }}>{s.d}</PkBody>
        <div style={{ marginTop: 14, fontFamily: PK.mono, fontSize: 11.5, color: PK.inkMute, background: PK.paper, border: `1px solid ${PK.edge}`, borderRadius: 7, padding: '7px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.c}</div>
      </div>)}
    </div>
  </PkSection>;
}
function MFlowRail() {
  return <PkSection pad="64px 80px" style={{ borderTop: `1px solid ${PK.rule}`, display: 'grid', gridTemplateColumns: 'minmax(160px,260px) minmax(0,1fr)', gap: 'clamp(24px,4vw,56px)' }}>
    <div>
      <PkEyebrow>The loop</PkEyebrow>
      <PkH size={30} style={{ marginTop: 12 }}>State the goal. Approve the plan. Leave.</PkH>
    </div>
    <div style={{ position: 'relative', paddingLeft: 28 }}>
      <div style={{ position: 'absolute', left: 6, top: 8, bottom: 8, width: 2, background: PK.rule }} />
      {MD.workflow.map((s, i) => <div key={i} style={{ position: 'relative', paddingBottom: 26 }}>
        <span style={{ position: 'absolute', left: -28, top: 4, width: 14, height: 14, borderRadius: '50%', background: PK.paper, border: `2px solid ${PK.accent}` }} />
        <div style={{ fontFamily: PK.sans, fontSize: 16, fontWeight: 600, color: PK.ink }}>{s.t}</div>
        <PkBody size={14.5} style={{ marginTop: 5 }}>{s.d}</PkBody>
        <div style={{ marginTop: 9, fontFamily: PK.mono, fontSize: 12, color: PK.accent }}>{s.c}</div>
      </div>)}
    </div>
  </PkSection>;
}
function MFlowTerminal() {
  return <PkSection pad="64px 80px" style={{ background: PK.deep }}>
    <PkEyebrow tone={PK.butter}>How a day goes</PkEyebrow>
    <PkH size={30} style={{ marginTop: 12, color: PK.paper, maxWidth: 520 }}>You set the goal. The queue does the hours.</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 12, marginTop: 28 }}>
      {MD.workflow.map((s, i) => <div key={i} style={{ border: '1px solid #3b3025', borderRadius: 10, padding: 18, background: i === 3 ? '#241d16' : 'transparent' }}>
        <div style={{ fontFamily: PK.mono, fontSize: 11, color: PK.butter }}>{String(i + 1).padStart(2, '0')}</div>
        <div style={{ fontFamily: PK.sans, fontSize: 15, fontWeight: 600, color: PK.paper, marginTop: 8 }}>{s.t}</div>
        <PkBody size={13} style={{ marginTop: 7, color: '#bdaf97' }}>{s.d}</PkBody>
        <div style={{ marginTop: 12, fontFamily: PK.mono, fontSize: 11.5, color: PK.sage, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.c}</div>
      </div>)}
    </div>
  </PkSection>;
}

// ── DEPTH: comparison / specs / privacy ────────────────────
const MD_MARK = { yes: [PK.sage, '●'], partial: [PK.butter, '◐'], no: [PK.rule, '○'] };
function MDepthCompare() {
  return <PkSection pad="64px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Where it fits</PkEyebrow>
    <PkH size={32} style={{ marginTop: 12, maxWidth: 560 }}>Between a terminal you babysit and a cloud you cannot see.</PkH>
    <div style={{ marginTop: 28, border: `1px solid ${PK.edge}`, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) repeat(3,minmax(78px,1fr))', background: PK.panel, borderBottom: `1px solid ${PK.edge}` }}>
        <div />
        {MD.compare.cols.map((c, i) => <div key={c} style={{ padding: '12px 10px', textAlign: 'center', fontFamily: PK.sans, fontSize: 12.5, fontWeight: i === 2 ? 700 : 500, color: i === 2 ? PK.accent : PK.inkSoft }}>{c}</div>)}
      </div>
      {MD.compare.rows.map(([label, vals], r) => <div key={r} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) repeat(3,minmax(78px,1fr))', borderTop: r ? `1px solid ${PK.edge}` : 'none', background: r % 2 ? PK.card : 'transparent' }}>
        <div style={{ padding: '13px 18px', fontFamily: PK.sans, fontSize: 14, color: PK.ink }}>{label}</div>
        {vals.map((v, i) => <div key={i} style={{ display: 'grid', placeItems: 'center', color: MD_MARK[v][0], fontSize: 15, background: i === 2 ? 'rgba(184,92,52,0.05)' : 'transparent' }}>{MD_MARK[v][1]}</div>)}
      </div>)}
    </div>
    <div style={{ display: 'flex', gap: 18, marginTop: 12 }}>{Object.entries(MD_MARK).map(([k, [c, g]]) => <span key={k} style={{ fontFamily: PK.sans, fontSize: 12, color: PK.inkMute }}><span style={{ color: c, marginRight: 6 }}>{g}</span>{k}</span>)}</div>
  </PkSection>;
}
function MDepthSpecs() {
  return <PkSection pad="64px 80px" style={{ borderTop: `1px solid ${PK.rule}`, display: 'grid', gridTemplateColumns: 'minmax(160px,240px) minmax(0,1fr)', gap: 'clamp(24px,4vw,52px)' }}>
    <div><PkEyebrow>The details</PkEyebrow><PkH size={28} style={{ marginTop: 12 }}>What it needs, and what it never does.</PkH></div>
    <div>{MD.specs.map((s, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(90px,130px) minmax(0,1fr)', gap: 'clamp(14px,2vw,24px)', padding: '13px 0', borderTop: `1px solid ${PK.rule}`, alignItems: 'baseline' }}>
      <span style={{ fontFamily: PK.mono, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: PK.inkMute }}>{s[0]}</span>
      <span><span style={{ fontFamily: PK.sans, fontSize: 14.5, fontWeight: 600, color: PK.ink }}>{s[1]}</span><span style={{ fontFamily: PK.sans, fontSize: 13.5, color: PK.inkMute, marginLeft: 10 }}>{s[2]}</span></span>
    </div>)}</div>
  </PkSection>;
}
function MDepthPrivacy() {
  return <PkSection pad="64px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Local by construction</PkEyebrow>
    <PkH size={32} style={{ marginTop: 12, maxWidth: 600 }}>Your code never leaves the machine it was written on.</PkH>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 16, marginTop: 28 }}>
      {MD.privacy.map((p, i) => <div key={i} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 12, padding: 22, borderTop: `3px solid ${PK.sage}` }}>
        <div style={{ fontFamily: PK.sans, fontSize: 15.5, fontWeight: 600, color: PK.ink }}>{p.t}</div>
        <PkBody size={13.5} style={{ marginTop: 8 }}>{p.d}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function MDepthStack() {
  return <PkSection pad="56px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <div style={{ display: 'flex', gap: 'clamp(20px,4vw,48px)', flexWrap: 'wrap' }}>
      {MD.specs.map((s, i) => <div key={i} style={{ minWidth: 150 }}>
        <div style={{ fontFamily: PK.mono, fontSize: 10.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: PK.inkMute }}>{s[0]}</div>
        <div style={{ fontFamily: PK.sans, fontSize: 15, fontWeight: 600, color: PK.ink, marginTop: 6 }}>{s[1]}</div>
        <div style={{ fontFamily: PK.sans, fontSize: 12.5, color: PK.inkMute, marginTop: 3 }}>{s[2]}</div>
      </div>)}
    </div>
  </PkSection>;
}

// ── FAQ ────────────────────────────────────────────────────
function MFaqAccordion() {
  const [open, setOpen] = React.useState(0);
  return <PkSection pad="64px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Before you ask</PkEyebrow>
    <div style={{ marginTop: 18, maxWidth: 780 }}>
      {MD.faq.map((f, i) => <div key={i} style={{ borderTop: `1px solid ${PK.rule}` }}>
        <button onClick={() => setOpen(open === i ? -1 : i)} style={{ appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer', width: '100%', textAlign: 'left', padding: '16px 0', display: 'flex', justifyContent: 'space-between', gap: 20, fontFamily: PK.sans, fontSize: 16, fontWeight: 550, color: PK.ink }}>
          {f.q}<span style={{ color: PK.inkMute }}>{open === i ? '−' : '+'}</span>
        </button>
        {open === i && <PkBody size={15} style={{ paddingBottom: 18, maxWidth: 640 }}>{f.a}</PkBody>}
      </div>)}
    </div>
  </PkSection>;
}
function MFaqColumns() {
  return <PkSection pad="64px 80px" style={{ borderTop: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Before you ask</PkEyebrow>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 'clamp(20px,3vw,40px)', marginTop: 24 }}>
      {MD.faq.map((f, i) => <div key={i}>
        <div style={{ fontFamily: PK.sans, fontSize: 15, fontWeight: 650, color: PK.ink }}>{f.q}</div>
        <PkBody size={14} style={{ marginTop: 7 }}>{f.a}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}
function MFaqObjections() {
  return <PkSection pad="64px 80px" style={{ background: PK.panel, borderTop: `1px solid ${PK.rule}`, borderBottom: `1px solid ${PK.rule}` }}>
    <PkEyebrow>Fair objections</PkEyebrow>
    <div style={{ display: 'grid', gap: 10, marginTop: 22 }}>
      {MD.faq.map((f, i) => <div key={i} style={{ background: PK.card, border: `1px solid ${PK.edge}`, borderRadius: 12, padding: '18px 22px', display: 'grid', gridTemplateColumns: 'minmax(180px,280px) minmax(0,1fr)', gap: 'clamp(18px,3vw,36px)', alignItems: 'baseline' }}>
        <div style={{ fontFamily: PK.serif, fontSize: 19, color: PK.ink, lineHeight: 1.25 }}>{f.q}</div>
        <PkBody size={14}>{f.a}</PkBody>
      </div>)}
    </div>
  </PkSection>;
}

// Splice the depth slots in before the closing CTA and re-point the presets.
(function () {
  const P = window.PAGE_MARKETING;
  const deep = [
    { id: 'tour', label: 'Product tour', variants: [
      { id: 'tabs', label: 'Tabbed tour', note: 'Interactive — one surface at a time, with a shot.', C: MTourTabs },
      { id: 'stacked', label: 'Alternating deep-dive', note: 'Every surface gets a full row. Longest, most convincing.', C: MTourStacked },
      { id: 'cards', label: 'Tour cards', note: 'Four capped cards with thumbnails. Scannable.', C: MTourCards },
      { id: 'bigshot', label: 'One window + legend', note: 'A single full-app shot with an indexed rail.', C: MTourBigShot },
    ] },
    { id: 'workflow', label: 'How it works', variants: [
      { id: 'steps', label: 'Four step cards', note: 'Each step carries the command that runs it.', C: MFlowSteps },
      { id: 'rail', label: 'Vertical loop', note: 'Reads as a sequence; good after a dense section.', C: MFlowRail },
      { id: 'terminal', label: 'Dark step band', note: 'Inverted; breaks up a long cream page.', C: MFlowTerminal },
    ] },
    { id: 'depth', label: 'Substance block', variants: [
      { id: 'compare', label: 'Comparison table', note: 'Against the two alternatives buyers already have.', C: MDepthCompare },
      { id: 'specs', label: 'Spec ledger', note: 'Requirements and limits, plainly stated.', C: MDepthSpecs },
      { id: 'privacy', label: 'Local-first panel', note: 'Leads with the privacy argument.', C: MDepthPrivacy },
      { id: 'stack', label: 'Inline spec strip', note: 'Lightest option — one band of facts.', C: MDepthStack },
    ] },
    { id: 'faq', label: 'Objections', variants: [
      { id: 'accordion', label: 'Accordion', note: 'Compact; hides answers until asked.', C: MFaqAccordion },
      { id: 'columns', label: 'Open columns', note: 'Everything visible, nothing to click.', C: MFaqColumns },
      { id: 'objections', label: 'Objection rows', note: 'Question as a serif statement, answer beside it.', C: MFaqObjections },
    ] },
  ];
  const at = P.slots.findIndex(s => s.id === 'close');
  P.slots.splice(at, 0, ...deep);
  Object.assign(P.presets[0].pick, { tour: 'tabs', workflow: 'rail', depth: 'compare', faq: 'accordion' });
  Object.assign(P.presets[1].pick, { tour: 'stacked', workflow: 'steps', depth: 'privacy', faq: 'objections' });
  Object.assign(P.presets[2].pick, { tour: 'bigshot', workflow: 'terminal', depth: 'specs', faq: 'columns' });
  P.blurb = 'Positions the project to someone who has never seen it — then proves it works.';
})();
